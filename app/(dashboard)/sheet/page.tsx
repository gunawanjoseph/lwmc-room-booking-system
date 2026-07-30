"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAction,
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import {
  Download,
  LockKeyhole,
  Pencil,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  collectDynamicColumns,
  type BookingExportRow,
  type BookingFormResponse,
  type DynamicJotformColumn,
} from "@/lib/booking-export";
import {
  formatDate,
  formatDateTime,
  messageFromError,
} from "@/lib/ui";
import { isBookingCalendarProcessing } from "@/lib/booking-conflict-transition";
import type { Capability } from "@/shared/roles";
import { StatusBadge } from "@/components/status-badge";

type BookingRow = BookingExportRow & {
  _id: Id<"bookings">;
  revision: number;
  formResponses?: BookingFormResponse[];
  deletionInProgress?: boolean;
  deletionError?: string;
};

type EditableValues = {
  requesterName: string;
  requesterEmail: string;
  eventName: string;
  purpose: string;
  ministry: string;
  responseValues: Record<string, string>;
};

type RowDraft = {
  expectedRevision: number;
  original: EditableValues;
  values: EditableValues;
};

type ExportPageResult = {
  page: BookingRow[];
  continueCursor: string;
  isDone: boolean;
};

const MAX_SAVE_ROWS = 50;
const MAX_EXPORT_ROWS = 10_000;
const EXPORT_PAGE_SIZE = 100;
const MAX_VISIBLE_DYNAMIC_COLUMNS = 150;
const JOTFORM_QID_PATTERN = /^\d{1,20}$/;

function compareDynamicQids(
  left: DynamicJotformColumn,
  right: DynamicJotformColumn,
): number {
  const leftQid = BigInt(left.qid);
  const rightQid = BigInt(right.qid);
  if (leftQid < rightQid) return -1;
  if (leftQid > rightQid) return 1;
  return left.qid.localeCompare(right.qid);
}

function selectVisibleDynamicColumns(
  rows: readonly BookingRow[],
  columns: readonly DynamicJotformColumn[],
): DynamicJotformColumn[] {
  if (columns.length <= MAX_VISIBLE_DYNAMIC_COLUMNS) {
    return [...columns];
  }

  const candidateQids = new Set(columns.map((column) => column.qid));
  const mostRecentlySeen = new Map<string, number>();
  for (const booking of rows) {
    for (const response of booking.formResponses ?? []) {
      const qid = response.qid.trim();
      if (response.canonicalField || !candidateQids.has(qid)) {
        continue;
      }
      const previous = mostRecentlySeen.get(qid);
      if (previous === undefined || booking.createdAt > previous) {
        mostRecentlySeen.set(qid, booking.createdAt);
      }
    }
  }

  return [...columns]
    .sort((left, right) => {
      const leftSeen = mostRecentlySeen.get(left.qid) ?? -Infinity;
      const rightSeen = mostRecentlySeen.get(right.qid) ?? -Infinity;
      if (leftSeen !== rightSeen) return rightSeen - leftSeen;
      return compareDynamicQids(right, left);
    })
    .slice(0, MAX_VISIBLE_DYNAMIC_COLUMNS)
    .sort(compareDynamicQids);
}

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

function editableValues(booking: BookingRow): EditableValues {
  const responseValues: Record<string, string> = Object.create(null);
  for (const response of booking.formResponses ?? []) {
    if (
      !response.canonicalField &&
      JOTFORM_QID_PATTERN.test(response.qid)
    ) {
      responseValues[response.qid] = response.value;
    }
  }
  return {
    requesterName: booking.requesterName,
    requesterEmail: booking.requesterEmail,
    eventName: booking.eventName ?? "",
    purpose: booking.purpose ?? "",
    ministry: booking.ministry ?? "",
    responseValues,
  };
}

function draftIsDirty(draft: RowDraft): boolean {
  if (
    draft.values.requesterName !== draft.original.requesterName ||
    draft.values.requesterEmail !== draft.original.requesterEmail ||
    draft.values.eventName !== draft.original.eventName ||
    draft.values.purpose !== draft.original.purpose ||
    draft.values.ministry !== draft.original.ministry
  ) {
    return true;
  }
  const qids = new Set([
    ...Object.keys(draft.original.responseValues),
    ...Object.keys(draft.values.responseValues),
  ]);
  return [...qids].some(
    (qid) =>
      (draft.values.responseValues[qid] ?? "") !==
      (draft.original.responseValues[qid] ?? ""),
  );
}

function localDateStamp(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function requestId(prefix: string): string {
  const identifier =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${identifier}`;
}

export default function BookingDataPage() {
  const convex = useConvex();
  const profile = useQuery(api.users.me) as
    | { capabilities: Capability[] }
    | null
    | undefined;
  const {
    results,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.bookings.listTable,
    {},
    { initialNumItems: 50 },
  );
  const saveTableEdits = useMutation(api.bookings.saveTableEdits);
  const deleteBooking = useAction(api.googleCalendar.deleteBooking);
  const recordXlsxExport = useMutation(api.bookings.recordXlsxExport);

  const rows = results as BookingRow[];
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editMode, setEditMode] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const draftClearTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const [saving, setSaving] = useState(false);
  const [deletingRowId, setDeletingRowId] = useState<string | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  const canEdit =
    profile?.capabilities.includes("table.edit") ?? false;
  const canExport =
    profile?.capabilities.includes("bookings.export") ?? false;

  const allDynamicColumns = useMemo(
    () => collectDynamicColumns(rows),
    [rows],
  );
  const dynamicColumns = useMemo(
    () => selectVisibleDynamicColumns(rows, allDynamicColumns),
    [allDynamicColumns, rows],
  );
  const omittedDynamicColumnCount =
    allDynamicColumns.length - dynamicColumns.length;
  const processingRowIds = useMemo(
    () =>
      new Set(
        rows
          .filter(isBookingCalendarProcessing)
          .map((booking) => String(booking._id)),
      ),
    [rows],
  );
  const dirtyDrafts = useMemo(
    () =>
      Object.entries(drafts).filter(
        ([bookingId, draft]) =>
          !processingRowIds.has(bookingId) && draftIsDirty(draft),
      ),
    [drafts, processingRowIds],
  );
  const dirtyCount = dirtyDrafts.length;
  const cappedSnapshotCount = rows.filter(
    (booking) => booking.formResponsesTruncated,
  ).length;
  const unknownSnapshotCount = rows.filter(
    (booking) =>
      booking.formResponseCapturedCount === undefined ||
      booking.formResponseFieldCount === undefined,
  ).length;

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en");
    return rows.filter((booking) => {
      if (
        statusFilter !== "all" &&
        booking.status !== statusFilter
      ) {
        return false;
      }
      if (!needle) return true;
      return [
        booking.jotformSubmissionId,
        booking.requesterName,
        booking.requesterEmail,
        booking.room,
        booking.eventName ?? "",
        booking.purpose ?? "",
        booking.ministry ?? "",
        booking.recurrenceFrequency ?? "none",
        booking.calendarSyncStatus ?? "disabled",
        ...(booking.formResponses ?? []).map(
          (response) => response.value,
        ),
      ].some((value) =>
        value.toLocaleLowerCase("en").includes(needle),
      );
    });
  }, [query, rows, statusFilter]);

  useEffect(() => {
    if (processingRowIds.size === 0) return;
    const lockedIds = [...processingRowIds].filter(
      (bookingId) => !draftClearTimersRef.current.has(bookingId),
    );
    if (lockedIds.length === 0) return;
    const timer = setTimeout(() => {
      for (const bookingId of lockedIds) {
        if (draftClearTimersRef.current.get(bookingId) === timer) {
          draftClearTimersRef.current.delete(bookingId);
        }
      }
      setDrafts((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(
            ([bookingId]) => !lockedIds.includes(bookingId),
          ),
        );
        return Object.keys(next).length === Object.keys(current).length
          ? current
          : next;
      });
    }, 0);
    for (const bookingId of lockedIds) {
      draftClearTimersRef.current.set(bookingId, timer);
    }
  }, [processingRowIds]);

  useEffect(
    () => () => {
      for (const timer of new Set(
        draftClearTimersRef.current.values(),
      )) {
        clearTimeout(timer);
      }
      draftClearTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (dirtyCount === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () =>
      window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirtyCount]);

  useEffect(() => {
    if (dirtyCount === 0) return;
    const warnBeforeClientNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !target ||
        target.target === "_blank" ||
        target.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(target.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      ) {
        return;
      }
      if (
        window.confirm(
          "Leave this page and discard all unsaved booking-table changes?",
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener(
      "click",
      warnBeforeClientNavigation,
      true,
    );
    return () =>
      document.removeEventListener(
        "click",
        warnBeforeClientNavigation,
        true,
      );
  }, [dirtyCount]);

  function updateDraft(
    booking: BookingRow,
    update: (values: EditableValues) => EditableValues,
  ) {
    if (isBookingCalendarProcessing(booking)) return;
    setNotice("");
    setSaveError("");
    setDrafts((current) => {
      const key = String(booking._id);
      const existing = current[key];
      const original = existing?.original ?? editableValues(booking);
      const values = update(existing?.values ?? original);
      return {
        ...current,
        [key]: {
          expectedRevision:
            existing?.expectedRevision ?? booking.revision,
          original,
          values,
        },
      };
    });
  }

  function beginEditing() {
    setNotice("");
    setSaveError("");
    setDrafts({});
    setEditMode(true);
  }

  function cancelEditing() {
    if (
      dirtyCount > 0 &&
      !window.confirm(
        "Discard all unsaved changes in the booking table?",
      )
    ) {
      return;
    }
    setDrafts({});
    setSaveError("");
    setEditMode(false);
  }

  async function saveChanges() {
    if (dirtyCount === 0 || dirtyCount > MAX_SAVE_ROWS) return;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const edits = dirtyDrafts.map(([bookingId, draft]) => {
        const responseEdits = Object.keys(
          draft.values.responseValues,
        )
          .filter(
            (qid) =>
              (draft.values.responseValues[qid] ?? "") !==
              (draft.original.responseValues[qid] ?? ""),
          )
          .map((qid) => ({
            qid,
            value: draft.values.responseValues[qid] ?? "",
          }));
        return {
          bookingId: bookingId as Id<"bookings">,
          expectedRevision: draft.expectedRevision,
          requesterName: draft.values.requesterName,
          requesterEmail: draft.values.requesterEmail,
          eventName: draft.values.eventName || undefined,
          purpose: draft.values.purpose || undefined,
          ministry: draft.values.ministry || undefined,
          responseEdits,
        };
      });
      const result = await saveTableEdits({
        clientRequestId: requestId("table-save"),
        edits,
      });
      setDrafts({});
      setEditMode(false);
      setNotice(
        `${result.updated} booking${result.updated === 1 ? "" : "s"} saved to Convex.`,
      );
    } catch (caught) {
      // Keep every draft in place so a conflict or validation error never
      // discards the administrator's work.
      setSaveError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function downloadWorkbook() {
    if (!canExport || exporting || dirtyCount > 0) return;
    setExporting(true);
    setNotice("");
    setSaveError("");
    try {
      let cursor: string | null = null;
      let isDone = false;
      const exportRows: BookingRow[] = [];

      while (!isDone && exportRows.length < MAX_EXPORT_ROWS) {
        const page: ExportPageResult = await convex.query(
          api.bookings.exportPage,
          {
            paginationOpts: {
              cursor,
              numItems: Math.min(
                EXPORT_PAGE_SIZE,
                MAX_EXPORT_ROWS - exportRows.length,
              ),
            },
          },
        );
        exportRows.push(...page.page);
        cursor = page.continueCursor;
        isDone = page.isDone;
      }

      const rowsTruncated = !isDone;
      const { downloadBookingWorkbook } = await import(
        "@/lib/booking-export"
      );
      const summary = await downloadBookingWorkbook(
        exportRows,
        `room-bookings-${localDateStamp()}.xlsx`,
      );
      const columnsTruncated =
        summary.omittedDynamicColumnCount > 0;
      const truncated = rowsTruncated || columnsTruncated;

      const warnings = [
        rowsTruncated
          ? `Only the first ${MAX_EXPORT_ROWS.toLocaleString()} rows were included`
          : "",
        columnsTruncated
          ? `${summary.omittedDynamicColumnCount} older Jotform field column${summary.omittedDynamicColumnCount === 1 ? " was" : "s were"} omitted`
          : "",
      ].filter(Boolean);
      const downloadNotice =
        warnings.length > 0
          ? `Workbook downloaded. ${warnings.join("; ")}.`
          : `${summary.rowCount.toLocaleString()} booking${summary.rowCount === 1 ? "" : "s"} downloaded as .xlsx.`;

      try {
        await recordXlsxExport({
          clientRequestId: requestId("xlsx-export"),
          rowCount: summary.rowCount,
          columnCount: summary.columnCount,
          truncated,
        });
      } catch (auditError) {
        setNotice(downloadNotice);
        setSaveError(
          `The workbook downloaded, but RoomOps could not record the export in its audit log: ${messageFromError(auditError)}`,
        );
        return;
      }
      setNotice(downloadNotice);
    } catch (caught) {
      setSaveError(messageFromError(caught));
    } finally {
      setExporting(false);
    }
  }

  async function deleteRow(booking: BookingRow) {
    if (
      !canEdit ||
      editMode ||
      deletingRowId ||
      isBookingCalendarProcessing(booking)
    ) {
      return;
    }
    if (
      !window.confirm(
        `Permanently delete booking ${booking.jotformSubmissionId}? RoomOps will first remove every managed Google Calendar event, then delete the Convex row. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingRowId(String(booking._id));
    setNotice("");
    setSaveError("");
    try {
      const result = await deleteBooking({
        bookingId: booking._id,
        expectedRevision: booking.revision,
      });
      setNotice(
        result.deleted
          ? `Booking ${booking.jotformSubmissionId} and its managed Calendar events were deleted.`
          : "That booking row was already gone.",
      );
    } catch (caught) {
      setSaveError(messageFromError(caught));
    } finally {
      setDeletingRowId(null);
    }
  }

  const columnCount = 11 + dynamicColumns.length + (canEdit ? 1 : 0);

  return (
    <div className="page sheet-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">CONVEX BOOKING DATA</span>
          <h1>Booking data</h1>
          <p>
            Jotform submissions are stored in Convex. New form
            questions appear as additional columns without changing
            the core booking workflow.
          </p>
        </div>
        <div className="page-header-actions">
          {canExport && (
            <button
              type="button"
              className="button button-secondary"
              onClick={downloadWorkbook}
              disabled={
                exporting ||
                dirtyCount > 0 ||
                paginationStatus === "LoadingFirstPage"
              }
              title={
                dirtyCount > 0
                  ? "Save or discard table changes before exporting."
                  : `Download up to the ${MAX_EXPORT_ROWS.toLocaleString()} newest bookings from Convex, regardless of the current filters.`
              }
            >
              <Download size={16} />
              {exporting
                ? "Preparing workbook…"
                : "Download workbook (.xlsx)"}
            </button>
          )}
          {canEdit && !editMode && (
            <button
              type="button"
              className="button button-primary"
              onClick={beginEditing}
            >
              <Pencil size={16} />
              Edit table
            </button>
          )}
        </div>
      </header>

      <div className="info-banner sheet-notice">
        <LockKeyhole size={18} />
        <div>
          <strong>Reservation controls stay protected.</strong>
          <span>
            This table can update requester details, event name,
            purpose, ministry, and additional Jotform answers. Approved
            title changes are synchronized to Google Calendar. Change
            room or time and make approval decisions from Bookings.
          </span>
        </div>
      </div>

      {notice && (
        <div className="sheet-feedback sheet-feedback-success" role="status">
          {notice}
        </div>
      )}

      {editMode && processingRowIds.size > 0 && (
        <div className="sheet-feedback sheet-feedback-warning" role="status">
          {processingRowIds.size} loaded booking
          {processingRowIds.size === 1 ? " is" : "s are"} locked while
          Calendar processing runs in the background. Those rows cannot
          be edited or saved, and any draft for them has been cleared.
        </div>
      )}

      {cappedSnapshotCount > 0 && (
        <div className="sheet-feedback sheet-feedback-warning" role="status">
          {cappedSnapshotCount} loaded booking
          {cappedSnapshotCount === 1 ? " has" : "s have"} a capped
          Jotform answer snapshot. Core booking data is intact; see
          System logs for the capture details.
        </div>
      )}

      {omittedDynamicColumnCount > 0 && (
        <div className="sheet-feedback sheet-feedback-warning" role="status">
          Showing the {MAX_VISIBLE_DYNAMIC_COLUMNS} most recently seen
          additional Jotform fields for the loaded bookings.{" "}
          {omittedDynamicColumnCount} older field
          {omittedDynamicColumnCount === 1 ? " is" : "s are"} hidden
          in this table to keep it responsive. Their answers remain in
          Convex, and search still checks the hidden values.
        </div>
      )}

      {unknownSnapshotCount > 0 && (
        <div className="sheet-feedback sheet-feedback-warning" role="status">
          {unknownSnapshotCount} loaded booking
          {unknownSnapshotCount === 1 ? " predates" : "s predate"} submitted-answer
          capture tracking.{" "}
          {unknownSnapshotCount === 1 ? "Its" : "Their"} core booking
          data is intact, but historical non-core responses may be
          incomplete.
        </div>
      )}

      {editMode && (
        <section className="panel table-edit-bar" aria-live="polite">
          <div>
            <strong>Edit mode</strong>
            <span>
              {dirtyCount === 0
                ? "No unsaved changes"
                : `${dirtyCount} changed booking${dirtyCount === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="table-edit-actions">
            {dirtyCount > MAX_SAVE_ROWS && (
              <span className="edit-limit-warning">
                Save at most {MAX_SAVE_ROWS} changed rows at once.
              </span>
            )}
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={cancelEditing}
              disabled={saving}
            >
              <X size={15} />
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary button-small"
              onClick={saveChanges}
              disabled={
                saving ||
                dirtyCount === 0 ||
                dirtyCount > MAX_SAVE_ROWS
              }
            >
              <Save size={15} />
              {saving ? "Saving…" : "Save to Convex"}
            </button>
          </div>
          {saveError && (
            <div className="form-error table-save-error">
              {saveError} Your unsaved changes are still here.
            </div>
          )}
        </section>
      )}

      {!editMode && saveError && (
        <div className="form-error sheet-page-error" role="alert">
          {saveError}
        </div>
      )}

      <section className="toolbar panel sheet-toolbar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search loaded booking data"
            aria-label="Search loaded booking data"
          />
        </label>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by booking status"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <span className="sheet-row-summary">
          {filteredRows.length.toLocaleString()} shown ·{" "}
          {rows.length.toLocaleString()} loaded
        </span>
      </section>

      <section className="panel table-panel booking-data-panel">
        <div
          className="table-scroll booking-data-scroll"
          role="region"
          aria-label="Booking data table"
          tabIndex={0}
        >
          <table className="data-table convex-sheet-table">
            <thead>
              <tr>
                <th scope="col">Submission</th>
                <th scope="col">Requester name</th>
                <th scope="col">Requester email</th>
                <th scope="col">Room & time</th>
                <th scope="col">Status</th>
                <th scope="col">Event name</th>
                <th scope="col">Purpose</th>
                <th scope="col">Ministry</th>
                <th scope="col">Repeat</th>
                <th scope="col">Calendar sync</th>
                {dynamicColumns.map((column) => (
                  <th
                    key={column.qid}
                    scope="col"
                    className="dynamic-heading"
                    title={`Jotform question ID ${column.qid}`}
                  >
                    <span>{column.label}</span>
                    <small>QID {column.qid}</small>
                  </th>
                ))}
                <th scope="col">Updated</th>
                {canEdit && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {paginationStatus === "LoadingFirstPage" ? (
                <tr>
                  <td colSpan={columnCount} className="table-message">
                    Loading booking data…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="table-message">
                    No loaded bookings match this view.
                  </td>
                </tr>
              ) : (
                filteredRows.map((booking) => {
                  const key = String(booking._id);
                  const rowProcessing =
                    isBookingCalendarProcessing(booking);
                  const draft = drafts[key];
                  const values =
                    draft?.values ?? editableValues(booking);
                  const responseByQid = new Map(
                    (booking.formResponses ?? [])
                      .filter((response) => !response.canonicalField)
                      .map((response) => [response.qid, response]),
                  );
                  const protectedResponseQids = new Set(
                    (booking.formResponses ?? [])
                      .filter((response) => response.canonicalField)
                      .map((response) => response.qid),
                  );
                  return (
                    <tr
                      key={key}
                      className={[
                        draft && draftIsDirty(draft) ? "dirty-row" : "",
                        rowProcessing ? "booking-row-processing" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <td>
                        <div className="primary-cell submission-cell">
                          <strong>{booking.jotformSubmissionId}</strong>
                          <small>Revision {booking.revision}</small>
                          {rowProcessing && (
                            <small className="view-only-label">
                              Calendar processing · editing locked
                            </small>
                          )}
                        </div>
                      </td>
                      <td
                        className={
                          draft &&
                          values.requesterName !==
                            draft.original.requesterName
                            ? "dirty-cell"
                            : undefined
                        }
                      >
                        {editMode ? (
                          <input
                            className="sheet-cell-input"
                            value={values.requesterName}
                            maxLength={160}
                            disabled={rowProcessing}
                            aria-label={`Requester name for submission ${booking.jotformSubmissionId}`}
                            onChange={(event) =>
                              updateDraft(booking, (current) => ({
                                ...current,
                                requesterName: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          booking.requesterName
                        )}
                      </td>
                      <td
                        className={
                          draft &&
                          values.requesterEmail !==
                            draft.original.requesterEmail
                            ? "dirty-cell"
                            : undefined
                        }
                      >
                        {editMode ? (
                          <input
                            className="sheet-cell-input sheet-email-input"
                            type="email"
                            value={values.requesterEmail}
                            maxLength={254}
                            disabled={rowProcessing}
                            aria-label={`Requester email for submission ${booking.jotformSubmissionId}`}
                            onChange={(event) =>
                              updateDraft(booking, (current) => ({
                                ...current,
                                requesterEmail: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          booking.requesterEmail
                        )}
                      </td>
                      <td>
                        <div className="primary-cell room-time-cell">
                          <strong>{booking.room}</strong>
                          <span>
                            {formatDateTime(
                              booking.startAt,
                              booking.timezone,
                            )}
                          </span>
                          <small>
                            to{" "}
                            {formatDateTime(
                              booking.endAt,
                              booking.timezone,
                            )}
                          </small>
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={booking.status} />
                      </td>
                      <td
                        className={
                          draft &&
                          values.eventName !==
                            draft.original.eventName
                            ? "dirty-cell"
                            : undefined
                        }
                      >
                        {editMode ? (
                          <input
                            className="sheet-cell-input"
                            value={values.eventName}
                            maxLength={500}
                            disabled={rowProcessing}
                            aria-label={`Event name for submission ${booking.jotformSubmissionId}`}
                            onChange={(event) =>
                              updateDraft(booking, (current) => ({
                                ...current,
                                eventName: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="sheet-long-value">
                            {booking.eventName || "—"}
                          </span>
                        )}
                      </td>
                      <td
                        className={
                          draft &&
                          values.purpose !== draft.original.purpose
                            ? "dirty-cell"
                            : undefined
                        }
                      >
                        {editMode ? (
                          <textarea
                            className="sheet-cell-input sheet-cell-textarea"
                            rows={2}
                            value={values.purpose}
                            maxLength={2_000}
                            disabled={rowProcessing}
                            aria-label={`Purpose for submission ${booking.jotformSubmissionId}`}
                            onChange={(event) =>
                              updateDraft(booking, (current) => ({
                                ...current,
                                purpose: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="sheet-long-value">
                            {booking.purpose || "—"}
                          </span>
                        )}
                      </td>
                      <td
                        className={
                          draft &&
                          values.ministry !== draft.original.ministry
                            ? "dirty-cell"
                            : undefined
                        }
                      >
                        {editMode ? (
                          <input
                            className="sheet-cell-input"
                            value={values.ministry}
                            maxLength={300}
                            disabled={rowProcessing}
                            aria-label={`Ministry for submission ${booking.jotformSubmissionId}`}
                            onChange={(event) =>
                              updateDraft(booking, (current) => ({
                                ...current,
                                ministry: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="sheet-long-value">
                            {booking.ministry || "—"}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="primary-cell">
                          <strong>
                            {recurrenceLabel(
                              booking.recurrenceFrequency,
                            )}
                          </strong>
                          <span>
                            {booking.recurrenceCount ?? 1} occurrence
                            {(booking.recurrenceCount ?? 1) === 1
                              ? ""
                              : "s"}
                          </span>
                          {booking.recurrenceUntilAt && (
                            <small>
                              through{" "}
                              {formatDate(
                                booking.recurrenceUntilAt,
                                booking.timezone,
                              )}
                            </small>
                          )}
                          {(booking.occurrences?.length ?? 0) > 1 && (
                            <small>
                              final occurrence{" "}
                              {formatDateTime(
                                booking.occurrences!.at(-1)!.startAt,
                                booking.timezone,
                              )}{" "}
                              to{" "}
                              {formatDateTime(
                                booking.occurrences!.at(-1)!.endAt,
                                booking.timezone,
                              )}
                            </small>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="primary-cell">
                          <strong>
                            {(booking.calendarSyncStatus ?? "disabled")
                              .replaceAll("_", " ")}
                          </strong>
                          <small>
                            {booking.status === "approved"
                              ? "Managed event"
                              : "Approval creates event"}
                          </small>
                          {booking.deletionError && (
                            <small title={booking.deletionError}>
                              Previous deletion needs retry
                            </small>
                          )}
                        </div>
                      </td>
                      {dynamicColumns.map((column) => {
                        const response = responseByQid.get(column.qid);
                        const responseProtected =
                          protectedResponseQids.has(column.qid);
                        const responseValue =
                          values.responseValues[column.qid] ?? "";
                        const responseChanged =
                          draft &&
                          responseValue !==
                            (draft.original.responseValues[
                              column.qid
                            ] ?? "");
                        return (
                          <td
                            key={column.qid}
                            className={
                              responseChanged
                                ? "dirty-cell"
                                : undefined
                            }
                          >
                            {editMode && !responseProtected ? (
                              <textarea
                                className="sheet-cell-input sheet-cell-textarea"
                                rows={2}
                                value={responseValue}
                                maxLength={4_000}
                                disabled={rowProcessing}
                                aria-label={`${column.label} for submission ${booking.jotformSubmissionId}`}
                                onChange={(event) =>
                                  updateDraft(
                                    booking,
                                    (current) => ({
                                      ...current,
                                      responseValues: {
                                        ...current.responseValues,
                                        [column.qid]:
                                          event.target.value,
                                      },
                                    }),
                                  )
                                }
                                placeholder={
                                  response
                                    ? undefined
                                    : "No submitted value"
                                }
                              />
                            ) : editMode ? (
                              <span
                                className="view-only-label"
                                title="This question was a core booking field for this submission. Edit it through the Bookings page."
                              >
                                Core field
                              </span>
                            ) : (
                              <span className="sheet-long-value">
                                {response?.value || "—"}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td>
                        <span className="sheet-updated">
                          {formatDateTime(
                            booking.updatedAt,
                            booking.timezone,
                          )}
                        </span>
                      </td>
                      {canEdit && (
                        <td>
                          <button
                            type="button"
                            className="button button-danger button-tiny"
                            onClick={() => deleteRow(booking)}
                            disabled={
                              editMode ||
                              rowProcessing ||
                              booking.deletionInProgress === true ||
                              deletingRowId === String(booking._id)
                            }
                            title={
                              editMode
                                ? "Finish table editing before deleting rows."
                                : rowProcessing
                                  ? "Wait for the background Calendar operation to finish."
                                  : booking.deletionInProgress === true
                                    ? "Safe Calendar and booking deletion is already in progress."
                                    : booking.deletionError
                                      ? "Retry safe Calendar and booking deletion."
                                      : "Delete this booking and its managed Calendar events."
                            }
                          >
                            <Trash2 size={14} />
                            {deletingRowId === String(booking._id)
                              ? "Deleting"
                              : "Delete"}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <footer className="sheet-table-footer">
          <span>
            Search and filters apply to the{" "}
            {rows.length.toLocaleString()} rows loaded in this view.
          </span>
          {paginationStatus !== "Exhausted" && (
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => loadMore(50)}
              disabled={paginationStatus === "LoadingMore"}
            >
              {paginationStatus === "LoadingMore"
                ? "Loading…"
                : "Load 50 more"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
