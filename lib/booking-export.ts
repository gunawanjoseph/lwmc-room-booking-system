import { DateTime } from "luxon";
import type {
  CellObject,
  Sheet,
  SheetData,
} from "write-excel-file/browser";

export type JotformCanonicalField =
  | "requesterName"
  | "requesterEmail"
  | "room"
  | "eventName"
  | "purpose"
  | "ministry"
  | "recurrence"
  | "recurrenceHasEndDate"
  | "recurrenceCount"
  | "recurrenceUntil"
  | "start"
  | "end"
  | "date"
  | "startTime"
  | "endDate"
  | "endTime";

export type BookingFormResponse = {
  qid: string;
  name?: string;
  label: string;
  type?: string;
  order?: number;
  value: string;
  canonicalField?: JotformCanonicalField;
};

/**
 * The public projection returned by bookings.listTable/exportPage.
 *
 * This deliberately doesn't depend on Convex's generated types, which keeps
 * workbook creation testable and allows paginated results to be concatenated.
 */
export type BookingExportRow = {
  _id?: string;
  jotformSubmissionId: string;
  requesterName: string;
  requesterEmail: string;
  room: string;
  startAt: number;
  endAt: number;
  timezone: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  recurrenceFrequency?:
    | "none"
    | "daily"
    | "weekly_same_day"
    | "biweekly_same_day"
    | "monthly_same_day"
    | "monthly_same_date";
  recurrenceHasEndDate?: boolean;
  recurrenceCount?: number;
  recurrenceUntilAt?: number;
  occurrences?: Array<{
    sequence: number;
    startAt: number;
    endAt: number;
  }>;
  availabilityCheckPending?: boolean;
  calendarSyncStatus?:
    | "disabled"
    | "not_created"
    | "creating"
    | "synced"
    | "failed"
    | "conflict";
  formResponses?: readonly BookingFormResponse[];
  formResponsesTruncated?: boolean;
  formResponseCapturedCount?: number;
  formResponseFieldCount?: number;
  status: "pending" | "approved" | "rejected" | "unavailable" | "cancelled";
  reviewNote?: string;
  reviewedAt?: number;
  createdAt: number;
  updatedAt: number;
  revision?: number;
};

export type DynamicJotformColumn = {
  qid: string;
  label: string;
  name?: string;
  type?: string;
  order?: number;
};

type BrowserFileContent = File | Blob | ArrayBuffer;

export type BookingWorkbook = {
  sheets: Sheet<BrowserFileContent>[];
  rowCount: number;
  columnCount: number;
  dynamicColumns: DynamicJotformColumn[];
  omittedDynamicColumnCount: number;
};

const QID_PATTERN = /^\d{1,20}$/;
export const MAX_EXPORTED_DYNAMIC_COLUMNS = 150;
const LOCAL_DATE_FORMAT = "yyyy-mm-dd hh:mm";
const LOCAL_DATE_ONLY_FORMAT = "yyyy-mm-dd";
const UTC_DATE_FORMAT = "yyyy-mm-dd hh:mm:ss";

const HEADER_STYLE = {
  backgroundColor: "#255F53",
  textColor: "#FFFFFF",
  fontWeight: "bold" as const,
  alignVertical: "center" as const,
  bottomBorderColor: "#19483E",
  bottomBorderStyle: "thin" as const,
  height: 28,
  wrap: true,
};

const SUBHEADER_STYLE = {
  ...HEADER_STYLE,
  backgroundColor: "#3A7568",
};

const BODY_STYLE = {
  alignVertical: "top" as const,
};

const STATUS_BACKGROUND: Record<BookingExportRow["status"], string> = {
  pending: "#FFF2CC",
  approved: "#D9EAD3",
  rejected: "#F4CCCC",
  unavailable: "#E6E6E6",
  cancelled: "#EAD1DC",
};

function recurrenceLabel(
  frequency: BookingExportRow["recurrenceFrequency"],
): string {
  const labels = {
    none: "No repeat",
    daily: "Daily",
    weekly_same_day: "Every week",
    biweekly_same_day: "Every 2 weeks",
    monthly_same_day: "Every month on the same day",
    monthly_same_date: "Every month on the same date",
  } as const;
  return labels[frequency ?? "none"];
}

function textCell(
  value: unknown,
  style: Partial<CellObject> = {},
): CellObject {
  const text =
    value === null || value === undefined ? "" : String(value);
  return {
    value: text.replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      "",
    ),
    type: String,
    // Explicit text formatting plus `type: String` prevents submitted text
    // beginning with "=", "+", "-", or "@" from becoming an Excel formula.
    format: "@",
    ...style,
  };
}

function dateCell(
  value: Date | undefined,
  format: string,
  style: Partial<CellObject> = {},
): CellObject {
  if (!value) return textCell("", style);
  return {
    value,
    type: Date,
    format,
    ...style,
  };
}

function numberCell(
  value: number | undefined,
  style: Partial<CellObject> = {},
): CellObject {
  if (value === undefined) return textCell("", style);
  return {
    value,
    type: Number,
    ...style,
  };
}

function compareNumericQids(
  left: DynamicJotformColumn,
  right: DynamicJotformColumn,
): number {
  const leftNumber = BigInt(left.qid);
  const rightNumber = BigInt(right.qid);
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  // Keep ordering deterministic if Jotform ever supplies leading zeroes.
  return left.qid.localeCompare(right.qid);
}

/**
 * Builds the dynamic column catalogue from non-canonical Jotform answers.
 *
 * The newest booking metadata wins when a question label is changed. Columns
 * are then sorted by numeric qid, an identifier that remains stable when a
 * question is renamed or moved in Jotform. Canonical status is evaluated per
 * stored response so a later field-map change cannot hide historical dynamic
 * answers that share the same qid.
 */
export function collectDynamicColumns(
  rows: readonly BookingExportRow[],
): DynamicJotformColumn[] {
  const newestFirst = rows
    .map((row, originalIndex) => ({
      row,
      originalIndex,
      // Submission order, rather than later administrator edits, determines
      // which mutable Jotform label is the newest.
      freshness: row.createdAt,
    }))
    .sort(
      (left, right) =>
        right.freshness - left.freshness ||
        left.originalIndex - right.originalIndex,
    );

  const columns = new Map<string, DynamicJotformColumn>();
  for (const { row } of newestFirst) {
    for (const response of row.formResponses ?? []) {
      const qid = response.qid.trim();
      if (
        response.canonicalField ||
        !QID_PATTERN.test(qid) ||
        columns.has(qid)
      ) {
        continue;
      }
      columns.set(qid, {
        qid,
        label: response.label.trim() || `Jotform question ${qid}`,
        ...(response.name?.trim()
          ? { name: response.name.trim() }
          : {}),
        ...(response.type?.trim()
          ? { type: response.type.trim() }
          : {}),
        ...(Number.isFinite(response.order)
          ? { order: response.order }
          : {}),
      });
    }
  }

  return [...columns.values()].sort(compareNumericQids);
}

/**
 * Applies the workbook's dynamic-column limit without allowing old low-numbered
 * qids to crowd out questions that were added to Jotform more recently.
 *
 * Selection uses the most recent booking that contains each field. If several
 * fields were last seen in the same booking, the higher numeric qid wins the
 * final slot. The selected columns are sorted back into numeric qid order so
 * workbook layout remains deterministic.
 */
function selectDynamicColumns(
  rows: readonly BookingExportRow[],
  allColumns: readonly DynamicJotformColumn[],
): DynamicJotformColumn[] {
  if (allColumns.length <= MAX_EXPORTED_DYNAMIC_COLUMNS) {
    return [...allColumns];
  }

  const candidateQids = new Set(allColumns.map((column) => column.qid));
  const mostRecentlySeen = new Map<string, number>();
  for (const row of rows) {
    for (const response of row.formResponses ?? []) {
      const qid = response.qid.trim();
      if (response.canonicalField || !candidateQids.has(qid)) {
        continue;
      }
      const existing = mostRecentlySeen.get(qid);
      if (existing === undefined || row.createdAt > existing) {
        mostRecentlySeen.set(qid, row.createdAt);
      }
    }
  }

  return [...allColumns]
    .sort((left, right) => {
      const leftSeen = mostRecentlySeen.get(left.qid) ?? -Infinity;
      const rightSeen = mostRecentlySeen.get(right.qid) ?? -Infinity;
      if (leftSeen !== rightSeen) return rightSeen - leftSeen;
      return compareNumericQids(right, left);
    })
    .slice(0, MAX_EXPORTED_DYNAMIC_COLUMNS)
    .sort(compareNumericQids);
}

/**
 * Converts an instant to a timezone-local wall-clock Date for Excel.
 *
 * XLSX has no timezone-aware cell type. Creating a pseudo-UTC Date from the
 * venue's local components preserves the intended wall-clock value in Excel,
 * regardless of the browser's own timezone. The timezone is exported in its
 * own adjacent column.
 */
export function toTimezoneWallClockDate(
  timestamp: number,
  timezone: string,
): Date {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Booking timestamp must be a finite number.");
  }
  const zoned = DateTime.fromMillis(timestamp, { zone: timezone });
  if (!zoned.isValid) {
    throw new RangeError(
      `Cannot export booking time using timezone "${timezone}".`,
    );
  }
  return new Date(
    Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      zoned.millisecond,
    ),
  );
}

function utcDate(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp);
}

function dynamicValues(
  row: BookingExportRow,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const response of row.formResponses ?? []) {
    if (
      !response.canonicalField &&
      QID_PATTERN.test(response.qid) &&
      !values.has(response.qid)
    ) {
      values.set(response.qid, response.value);
    }
  }
  return values;
}

function bookingsHeader(
  dynamicColumns: readonly DynamicJotformColumn[],
): SheetData[number] {
  const fixed = [
    "Submission ID",
    "Requester Name",
    "Requester Email",
    "Room",
    "Start (Local)",
    "End (Local)",
    "Time Zone",
    "Status",
    "Event Name",
    "Purpose",
    "Ministry",
    "Repeat",
    "Has Recurrence End Date",
    "Occurrence Count",
    "Requested Last Date (Local)",
    "Final Occurrence Start (Local)",
    "Final Occurrence End (Local)",
    "Calendar Sync",
    "Review Note",
    "Submitted (UTC)",
    "Reviewed (UTC)",
    "Updated (UTC)",
    "Revision",
    "Response Capture",
  ];
  return [
    ...fixed.map((label) => textCell(label, HEADER_STYLE)),
    ...dynamicColumns.map((column) =>
      textCell(`Jotform qid:${column.qid}`, HEADER_STYLE),
    ),
  ];
}

function responseCaptureValue(row: BookingExportRow): string {
  if (
    !Number.isSafeInteger(row.formResponseCapturedCount) ||
    (row.formResponseCapturedCount ?? -1) < 0 ||
    !Number.isSafeInteger(row.formResponseFieldCount) ||
    (row.formResponseFieldCount ?? -1) < 0
  ) {
    return "Legacy (source field count unavailable)";
  }

  const capturedFieldCount = row.formResponseCapturedCount!;
  const sourceFieldCount = row.formResponseFieldCount!;
  const wasCapped =
    row.formResponsesTruncated === true ||
    sourceFieldCount > capturedFieldCount;

  return wasCapped
    ? `Capped (${capturedFieldCount}/${sourceFieldCount} fields)`
    : `Complete (${sourceFieldCount} ${sourceFieldCount === 1 ? "field" : "fields"})`;
}

function bookingDataRow(
  row: BookingExportRow,
  rowIndex: number,
  dynamicColumns: readonly DynamicJotformColumn[],
): SheetData[number] {
  const alternateRow =
    rowIndex % 2 === 1 ? { backgroundColor: "#F5F8F7" } : {};
  const baseStyle = { ...BODY_STYLE, ...alternateRow };
  const wrapStyle = { ...baseStyle, wrap: true };
  const responseValues = dynamicValues(row);
  const finalOccurrence = row.occurrences?.at(-1);

  return [
    textCell(row.jotformSubmissionId, baseStyle),
    textCell(row.requesterName, baseStyle),
    textCell(row.requesterEmail, baseStyle),
    textCell(row.room, baseStyle),
    dateCell(
      toTimezoneWallClockDate(row.startAt, row.timezone),
      LOCAL_DATE_FORMAT,
      baseStyle,
    ),
    dateCell(
      toTimezoneWallClockDate(row.endAt, row.timezone),
      LOCAL_DATE_FORMAT,
      baseStyle,
    ),
    textCell(row.timezone, baseStyle),
    textCell(row.status, {
      ...baseStyle,
      backgroundColor: STATUS_BACKGROUND[row.status],
      fontWeight: "bold",
    }),
    textCell(row.eventName ?? "", wrapStyle),
    textCell(row.purpose ?? "", wrapStyle),
    textCell(row.ministry ?? "", wrapStyle),
    textCell(recurrenceLabel(row.recurrenceFrequency), baseStyle),
    textCell(
      (row.recurrenceFrequency ?? "none") === "none"
        ? "No"
        : (row.recurrenceHasEndDate ??
            (row.recurrenceUntilAt !== undefined))
          ? "Yes"
          : "No",
      baseStyle,
    ),
    numberCell(row.recurrenceCount ?? 1, baseStyle),
    dateCell(
      row.recurrenceUntilAt === undefined
        ? undefined
        : toTimezoneWallClockDate(
            row.recurrenceUntilAt,
            row.timezone,
          ),
      LOCAL_DATE_ONLY_FORMAT,
      baseStyle,
    ),
    dateCell(
      finalOccurrence === undefined
        ? undefined
        : toTimezoneWallClockDate(
            finalOccurrence.startAt,
            row.timezone,
          ),
      LOCAL_DATE_FORMAT,
      baseStyle,
    ),
    dateCell(
      finalOccurrence === undefined
        ? undefined
        : toTimezoneWallClockDate(
            finalOccurrence.endAt,
            row.timezone,
          ),
      LOCAL_DATE_FORMAT,
      baseStyle,
    ),
    textCell(row.calendarSyncStatus ?? "disabled", baseStyle),
    textCell(row.reviewNote ?? "", wrapStyle),
    dateCell(utcDate(row.createdAt), UTC_DATE_FORMAT, baseStyle),
    dateCell(utcDate(row.reviewedAt), UTC_DATE_FORMAT, baseStyle),
    dateCell(utcDate(row.updatedAt), UTC_DATE_FORMAT, baseStyle),
    numberCell(row.revision ?? 0, baseStyle),
    textCell(responseCaptureValue(row), baseStyle),
    ...dynamicColumns.map((column) =>
      textCell(responseValues.get(column.qid) ?? "", wrapStyle),
    ),
  ];
}

function fieldCatalogueData(
  dynamicColumns: readonly DynamicJotformColumn[],
): SheetData {
  return [
    ["QID", "Latest Label", "Internal Name", "Control Type", "Order"].map(
      (label) => textCell(label, SUBHEADER_STYLE),
    ),
    ...dynamicColumns.map((column, index) => {
      const alternateRow =
        index % 2 === 1 ? { backgroundColor: "#F5F8F7" } : {};
      const style = { ...BODY_STYLE, ...alternateRow };
      return [
        textCell(column.qid, style),
        textCell(column.label, { ...style, wrap: true }),
        textCell(column.name ?? "", style),
        textCell(column.type ?? "", style),
        numberCell(column.order, style),
      ];
    }),
  ];
}

export function buildBookingWorkbook(
  rows: readonly BookingExportRow[],
): BookingWorkbook {
  const allDynamicColumns = collectDynamicColumns(rows);
  const dynamicColumns = selectDynamicColumns(rows, allDynamicColumns);
  const bookingsData: SheetData = [
    bookingsHeader(dynamicColumns),
    ...rows.map((row, rowIndex) =>
      bookingDataRow(row, rowIndex, dynamicColumns),
    ),
  ];

  const fixedColumnWidths = [
    20, 24, 30, 20, 19, 19, 22, 14, 30, 36, 24, 24, 18, 16, 20, 20,
    20, 18, 30, 20, 20, 20, 10, 28,
  ];
  const sheets: Sheet<BrowserFileContent>[] = [
    {
      data: bookingsData,
      sheet: "Bookings",
      columns: [
        ...fixedColumnWidths.map((width) => ({ width })),
        ...dynamicColumns.map(() => ({ width: 28 })),
      ],
      stickyRowsCount: 1,
      stickyColumnsCount: 2,
      showGridLines: false,
      orientation: "landscape",
      zoomScale: 0.9,
    },
    {
      data: fieldCatalogueData(dynamicColumns),
      sheet: "Jotform Fields",
      columns: [
        { width: 14 },
        { width: 36 },
        { width: 24 },
        { width: 20 },
        { width: 10 },
      ],
      stickyRowsCount: 1,
      showGridLines: false,
      zoomScale: 0.95,
    },
  ];

  return {
    sheets,
    rowCount: rows.length,
    columnCount: fixedColumnWidths.length + dynamicColumns.length,
    dynamicColumns,
    omittedDynamicColumnCount:
      allDynamicColumns.length - dynamicColumns.length,
  };
}

export async function downloadBookingWorkbook(
  rows: readonly BookingExportRow[],
  filename: string,
): Promise<{
  rowCount: number;
  columnCount: number;
  omittedDynamicColumnCount: number;
}> {
  const workbook = buildBookingWorkbook(rows);
  const { default: writeExcelFile } = await import(
    "write-excel-file/browser"
  );
  await writeExcelFile(workbook.sheets, {
    fontFamily: "Aptos",
    fontSize: 10,
  }).toFile(filename);
  return {
    rowCount: workbook.rowCount,
    columnCount: workbook.columnCount,
    omittedDynamicColumnCount: workbook.omittedDynamicColumnCount,
  };
}
