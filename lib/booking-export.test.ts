import { describe, expect, it } from "vitest";
import type { CellObject } from "write-excel-file/browser";
import {
  buildBookingWorkbook,
  collectDynamicColumns,
  MAX_EXPORTED_DYNAMIC_COLUMNS,
  toTimezoneWallClockDate,
  type BookingExportRow,
} from "./booking-export";

function booking(
  overrides: Partial<BookingExportRow> = {},
): BookingExportRow {
  return {
    jotformSubmissionId: "submission-1",
    requesterName: "Joseph",
    requesterEmail: "joseph@example.com",
    room: "Board Room",
    startAt: Date.parse("2026-07-24T01:30:00.000Z"),
    endAt: Date.parse("2026-07-24T02:30:00.000Z"),
    timezone: "Asia/Singapore",
    purpose: "Meeting",
    status: "pending",
    createdAt: Date.parse("2026-07-23T12:00:00.000Z"),
    updatedAt: Date.parse("2026-07-23T12:00:00.000Z"),
    revision: 0,
    ...overrides,
  };
}

describe("booking workbook export", () => {
  it("orders dynamic fields by numeric qid and uses the latest label", () => {
    const older = booking({
      createdAt: 100,
      updatedAt: 100,
      formResponses: [
        { qid: "10", label: "Old remarks", value: "Earlier" },
        { qid: "2", label: "Catering", value: "No" },
      ],
    });
    const newer = booking({
      jotformSubmissionId: "submission-2",
      createdAt: 200,
      updatedAt: 200,
      formResponses: [
        { qid: "10", label: "Updated remarks", value: "Latest" },
        {
          qid: "3",
          label: "Name",
          value: "Joseph",
          canonicalField: "requesterName",
        },
      ],
    });

    expect(collectDynamicColumns([older, newer])).toEqual([
      {
        qid: "2",
        label: "Catering",
      },
      {
        qid: "10",
        label: "Updated remarks",
      },
    ]);
  });

  it("keeps formula-like submitted text as explicitly typed strings", () => {
    const workbook = buildBookingWorkbook([
      booking({
        requesterName: "=HYPERLINK(\"https://example.test\",\"click\")",
        eventName: "@Leadership gathering",
        purpose: "+SUM(1,1)",
        ministry: "-Young adults",
        formResponses: [
          {
            qid: "99",
            label: "@Remarks",
            name: "-internal",
            value: "=1+1",
          },
        ],
      }),
    ]);

    const bookingsRow = workbook.sheets[0].data[1];
    const fieldsRow = workbook.sheets[1].data[1];
    for (const cell of [
      bookingsRow[1],
      bookingsRow[8],
      bookingsRow[9],
      bookingsRow[10],
      bookingsRow[21],
      fieldsRow[1],
      fieldsRow[2],
    ]) {
      expect((cell as CellObject).type).toBe(String);
      expect((cell as CellObject).format).toBe("@");
    }
    expect(bookingsRow[21]).toMatchObject({
      value: "=1+1",
      type: String,
      format: "@",
    });
  });

  it("exports venue-local wall-clock values independent of browser time", () => {
    const wallClock = toTimezoneWallClockDate(
      Date.parse("2026-07-24T01:30:45.123Z"),
      "Asia/Singapore",
    );

    expect(wallClock.toISOString()).toBe("2026-07-24T09:30:45.123Z");
  });

  it("exports legacy rows without a form response snapshot", () => {
    const workbook = buildBookingWorkbook([
      booking({ formResponses: undefined }),
    ]);

    expect(workbook.dynamicColumns).toEqual([]);
    expect(workbook.rowCount).toBe(1);
    expect(workbook.columnCount).toBe(21);
    expect(workbook.sheets).toHaveLength(2);
    expect(workbook.sheets[0].data).toHaveLength(2);
    expect(workbook.sheets[1].data).toHaveLength(1);
    expect(workbook.sheets[0].data[1][20]).toMatchObject({
      value: "Legacy (source field count unavailable)",
      type: String,
      format: "@",
    });
  });

  it("caps same-age dynamic columns in favor of higher qids, then sorts them", () => {
    const formResponses = Array.from(
      { length: MAX_EXPORTED_DYNAMIC_COLUMNS + 5 },
      (_, index) => ({
        qid: String(MAX_EXPORTED_DYNAMIC_COLUMNS + 5 - index),
        label: `Question ${index}`,
        value: `Answer ${index}`,
      }),
    );
    const workbook = buildBookingWorkbook([booking({ formResponses })]);

    expect(workbook.dynamicColumns).toHaveLength(
      MAX_EXPORTED_DYNAMIC_COLUMNS,
    );
    expect(workbook.dynamicColumns[0]?.qid).toBe("6");
    expect(
      workbook.dynamicColumns[MAX_EXPORTED_DYNAMIC_COLUMNS - 1]?.qid,
    ).toBe(String(MAX_EXPORTED_DYNAMIC_COLUMNS + 5));
    expect(workbook.omittedDynamicColumnCount).toBe(5);
    expect(workbook.columnCount).toBeLessThanOrEqual(200);
  });

  it("retains a recently seen field when the dynamic-column cap is reached", () => {
    const older = booking({
      createdAt: 100,
      updatedAt: 100,
      formResponses: Array.from(
        { length: MAX_EXPORTED_DYNAMIC_COLUMNS },
        (_, index) => ({
          qid: String(index + 2),
          label: `Older ${index + 2}`,
          value: "",
        }),
      ),
    });
    const newer = booking({
      jotformSubmissionId: "submission-2",
      createdAt: 200,
      updatedAt: 200,
      formResponses: [
        {
          qid: "1",
          label: "Newly added field",
          value: "Retain me",
        },
      ],
    });

    const workbook = buildBookingWorkbook([older, newer]);
    const selectedQids = workbook.dynamicColumns.map(({ qid }) => qid);

    expect(selectedQids).toContain("1");
    expect(selectedQids).not.toContain("2");
    expect(selectedQids).toEqual(
      [...selectedQids].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
      ),
    );
  });

  it("reports complete and capped response capture with source field counts", () => {
    const workbook = buildBookingWorkbook([
      booking({
        formResponses: [{ qid: "99", label: "Remarks", value: "Complete" }],
        formResponseCapturedCount: 1,
        formResponseFieldCount: 1,
      }),
      booking({
        jotformSubmissionId: "submission-2",
        formResponses: [{ qid: "99", label: "Remarks", value: "Capped" }],
        formResponsesTruncated: true,
        formResponseCapturedCount: 1,
        formResponseFieldCount: 120,
      }),
    ]);

    expect(workbook.sheets[0].data[1][20]).toMatchObject({
      value: "Complete (1 field)",
    });
    expect(workbook.sheets[0].data[2][20]).toMatchObject({
      value: "Capped (1/120 fields)",
    });
  });

  it("keeps pre-metadata response arrays labeled as legacy", () => {
    const workbook = buildBookingWorkbook([
      booking({
        formResponses: [
          { qid: "99", label: "Remarks", value: "Admin-added value" },
        ],
      }),
    ]);

    expect(workbook.sheets[0].data[1][20]).toMatchObject({
      value: "Legacy (source field count unavailable)",
    });
  });

  it("exports recurrence and calendar fields in the fixed columns", () => {
    const repeatUntil = Date.parse("2026-12-31T15:59:59.999Z");
    const workbook = buildBookingWorkbook([
      booking({
        eventName: "Leadership Gathering",
        purpose: "Annual planning",
        ministry: "Young Adults",
        recurrenceFrequency: "monthly_same_day",
        recurrenceCount: 6,
        recurrenceUntilAt: repeatUntil,
        calendarSyncStatus: "synced",
      }),
    ]);
    const header = workbook.sheets[0].data[0];
    const row = workbook.sheets[0].data[1];

    expect(workbook.columnCount).toBe(21);
    expect(
      header.slice(8, 16).map((cell) => (cell as CellObject).value),
    ).toEqual([
      "Event Name",
      "Purpose",
      "Ministry",
      "Repeat",
      "Occurrence Count",
      "Repeat Until (Local)",
      "Calendar Sync",
      "Review Note",
    ]);
    expect(row[8]).toMatchObject({ value: "Leadership Gathering" });
    expect(row[9]).toMatchObject({ value: "Annual planning" });
    expect(row[10]).toMatchObject({ value: "Young Adults" });
    expect(row[11]).toMatchObject({ value: "monthly same day" });
    expect(row[12]).toMatchObject({ value: 6, type: Number });
    expect(row[13]).toMatchObject({
      value: new Date("2026-12-31T23:59:59.999Z"),
      type: Date,
      format: "yyyy-mm-dd hh:mm",
    });
    expect(row[14]).toMatchObject({ value: "synced" });
  });
});
