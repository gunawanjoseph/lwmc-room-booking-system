"use client";

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { DateTime } from "luxon";
import {
  Check,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Capability } from "@/shared/roles";
import {
  formatDate,
  formatDateTime,
  messageFromError,
} from "@/lib/ui";
import { StatusBadge } from "@/components/status-badge";

type Booking = {
  _id: Id<"bookings">;
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
  recurrenceFrequency:
    | "none"
    | "daily"
    | "weekly_same_day"
    | "biweekly_same_day"
    | "monthly_same_day"
    | "monthly_same_date";
  recurrenceHasEndDate: boolean;
  recurrenceCount: number;
  recurrenceUntilAt?: number;
  occurrences: Array<{
    sequence: number;
    startAt: number;
    endAt: number;
  }>;
  availabilityCheckPending: boolean;
  calendarAvailabilityStatus:
    | "unchecked"
    | "available"
    | "conflict";
  calendarConflictSummary?: string;
  conflictWarningBookingIds?: Id<"bookings">[];
  calendarSyncStatus:
    | "disabled"
    | "not_created"
    | "creating"
    | "synced"
    | "failed"
    | "conflict";
  calendarSyncError?: string;
  deletionInProgress: boolean;
  deletionError?: string;
  status: "pending" | "approved" | "rejected" | "unavailable";
  createdAt: number;
  revision: number;
};

const RECURRENCE_LABELS: Record<
  Booking["recurrenceFrequency"],
  string
> = {
  none: "No repeat",
  daily: "Daily",
  weekly_same_day: "Every week",
  biweekly_same_day: "Every 2 weeks",
  monthly_same_day: "Every month on the same day",
  monthly_same_date: "Every month on the same date",
};

function localInputValue(timestamp: number, timezone: string): string {
  return DateTime.fromMillis(timestamp)
    .setZone(timezone)
    .toFormat("yyyy-MM-dd'T'HH:mm");
}

function localDateValue(
  timestamp: number | undefined,
  timezone: string,
): string {
  return timestamp === undefined
    ? ""
    : DateTime.fromMillis(timestamp, { zone: timezone }).toFormat(
        "yyyy-MM-dd",
      );
}

function DecisionDialog({
  booking,
  decision,
  close,
}: {
  booking: Booking;
  decision: "approve" | "reject";
  close: () => void;
}) {
  const decide = useAction(api.googleCalendar.decide);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await decide({
        bookingId: booking._id,
        decision,
        note: note || undefined,
      });
      close();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="modal panel"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`decision-title-${booking._id}`}
      >
        <div className="modal-heading">
          <div>
            <span className="panel-kicker">BOOKING DECISION</span>
            <h2 id={`decision-title-${booking._id}`}>
              {decision === "approve" ? "Approve" : "Reject"}{" "}
              {booking.room}?
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="decision-summary">
          <span>{booking.requesterName}</span>
          <strong>
            {formatDateTime(booking.startAt, booking.timezone)} –{" "}
            {formatDateTime(booking.endAt, booking.timezone)}
          </strong>
        </div>
        {(booking.conflictWarningBookingIds?.length ?? 0) > 0 && (
          <div className="booking-conflict-warning" role="note">
            <TriangleAlert size={17} aria-hidden="true" />
            <span>
              <strong>Pending conflict</strong>
              Review this request together with its overlapping pending
              request before making a decision.
            </span>
          </div>
        )}
        {decision === "approve" && (
          <div className="info-banner">
            All {booking.recurrenceCount} occurrence
            {booking.recurrenceCount === 1 ? "" : "s"} will be checked
            again. Approval completes only after every required Google
            Calendar event is created.
          </div>
        )}
        <label className="field">
          <span>Remark/comment to requester (optional)</span>
          <textarea
            rows={3}
            maxLength={1_000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="This comment will be included in the email sent to the requester."
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={close}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className={
              decision === "approve"
                ? "button button-primary"
                : "button button-danger"
            }
          >
            {busy
              ? decision === "approve"
                ? "Checking and scheduling…"
                : "Saving…"
              : decision === "approve"
                ? "Approve request"
                : "Reject request"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditDialog({
  booking,
  close,
}: {
  booking: Booking;
  close: () => void;
}) {
  const edit = useMutation(api.bookings.edit);
  const [form, setForm] = useState({
    requesterName: booking.requesterName,
    requesterEmail: booking.requesterEmail,
    room: booking.room,
    start: localInputValue(booking.startAt, booking.timezone),
    end: localInputValue(booking.endAt, booking.timezone),
    eventName: booking.eventName ?? "",
    purpose: booking.purpose ?? "",
    ministry: booking.ministry ?? "",
    recurrenceFrequency: booking.recurrenceFrequency,
    recurrenceHasEndDate: booking.recurrenceHasEndDate
      ? "yes"
      : "no",
    recurrenceUntil: localDateValue(
      booking.recurrenceUntilAt,
      booking.timezone,
    ),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reservationEditable = booking.status === "pending";

  function update<Key extends keyof typeof form>(
    key: Key,
    value: (typeof form)[Key],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const startAt = DateTime.fromISO(form.start, {
        zone: booking.timezone,
      }).toMillis();
      const endAt = DateTime.fromISO(form.end, {
        zone: booking.timezone,
      }).toMillis();
      const isRecurring = form.recurrenceFrequency !== "none";
      const recurrenceHasEndDate =
        isRecurring && form.recurrenceHasEndDate === "yes";
      const recurrenceUntilAt = recurrenceHasEndDate
        ? DateTime.fromFormat(form.recurrenceUntil, "yyyy-MM-dd", {
            zone: booking.timezone,
          })
            .endOf("day")
            .toMillis()
        : undefined;
      await edit({
        bookingId: booking._id,
        expectedRevision: booking.revision,
        requesterName: form.requesterName,
        requesterEmail: form.requesterEmail,
        room: form.room,
        startAt,
        endAt,
        eventName: form.eventName || undefined,
        purpose: form.purpose || undefined,
        ministry: form.ministry || undefined,
        recurrenceFrequency: form.recurrenceFrequency,
        recurrenceHasEndDate,
        recurrenceUntilAt,
      });
      close();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal modal-wide panel" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <span className="panel-kicker">EDIT BOOKING</span>
            <h2>{booking.room}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {!reservationEditable && (
          <div className="info-banner">
            Room, time, and recurrence are locked after a decision so the
            managed Google Calendar series cannot drift from Convex.
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Requester name</span>
            <input
              required
              value={form.requesterName}
              onChange={(event) =>
                update("requesterName", event.target.value)
              }
            />
          </label>
          <label className="field">
            <span>Requester email</span>
            <input
              required
              type="email"
              value={form.requesterEmail}
              onChange={(event) =>
                update("requesterEmail", event.target.value)
              }
            />
          </label>
          <label className="field form-grid-full">
            <span>Room</span>
            <input
              required
              disabled={!reservationEditable}
              value={form.room}
              onChange={(event) => update("room", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Start ({booking.timezone})</span>
            <input
              required
              disabled={!reservationEditable}
              type="datetime-local"
              value={form.start}
              onChange={(event) => update("start", event.target.value)}
            />
          </label>
          <label className="field">
            <span>End ({booking.timezone})</span>
            <input
              required
              disabled={!reservationEditable}
              type="datetime-local"
              value={form.end}
              onChange={(event) => update("end", event.target.value)}
            />
          </label>
          <label className="field form-grid-full">
            <span>Event name</span>
            <input
              value={form.eventName}
              onChange={(event) =>
                update("eventName", event.target.value)
              }
            />
          </label>
          <label className="field form-grid-full">
            <span>Purpose</span>
            <textarea
              rows={3}
              value={form.purpose}
              onChange={(event) => update("purpose", event.target.value)}
            />
          </label>
          <label className="field form-grid-full">
            <span>Ministry</span>
            <input
              value={form.ministry}
              onChange={(event) =>
                update("ministry", event.target.value)
              }
            />
          </label>
          <label className="field form-grid-full">
            <span>Repeat</span>
            <select
              disabled={!reservationEditable}
              value={form.recurrenceFrequency}
              onChange={(event) =>
                update(
                  "recurrenceFrequency",
                  event.target
                    .value as Booking["recurrenceFrequency"],
                )
              }
            >
              <option value="none">No repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly_same_day">Every week</option>
              <option value="biweekly_same_day">Every 2 weeks</option>
              <option value="monthly_same_day">
                Every month on the same day
              </option>
              <option value="monthly_same_date">
                Every month on the same date
              </option>
            </select>
          </label>
          {form.recurrenceFrequency !== "none" && (
            <>
              <label className="field">
                <span>Does this recurring booking have an end date?</span>
                <select
                  disabled={!reservationEditable}
                  value={form.recurrenceHasEndDate}
                  onChange={(event) =>
                    update(
                      "recurrenceHasEndDate",
                      event.target.value,
                    )
                  }
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </label>
              {form.recurrenceHasEndDate === "yes" && (
                <label className="field">
                  <span>Last date required</span>
                  <input
                    required
                    disabled={!reservationEditable}
                    type="date"
                    min={form.start.slice(0, 10)}
                    value={form.recurrenceUntil}
                    onChange={(event) =>
                      update("recurrenceUntil", event.target.value)
                    }
                  />
                </label>
              )}
            </>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={close}
          >
            Cancel
          </button>
          <button disabled={busy} className="button button-primary">
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function BookingsPage() {
  const deleteBooking = useAction(api.googleCalendar.deleteBooking);
  const retryCalendarSync = useMutation(
    api.bookings.retryCalendarSync,
  );
  const profile = useQuery(api.users.me) as
    | { capabilities: Capability[] }
    | undefined;
  const bookings = useQuery(api.bookings.list) as
    | Booking[]
    | undefined;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [decision, setDecision] = useState<{
    booking: Booking;
    decision: "approve" | "reject";
  } | null>(null);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [retryingBookingId, setRetryingBookingId] =
    useState<Id<"bookings"> | null>(null);
  const [deletingBookingId, setDeletingBookingId] =
    useState<Id<"bookings"> | null>(null);
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");

  const canApprove =
    profile?.capabilities.includes("bookings.approve") ?? false;
  const canEdit =
    profile?.capabilities.includes("bookings.edit") ?? false;

  async function retryCalendar(booking: Booking) {
    setRetryingBookingId(booking._id);
    setPageError("");
    try {
      await retryCalendarSync({ bookingId: booking._id });
    } catch (caught) {
      setPageError(messageFromError(caught));
    } finally {
      setRetryingBookingId(null);
    }
  }

  async function removeBooking(booking: Booking) {
    if (
      !window.confirm(
        `Permanently delete booking ${booking.jotformSubmissionId}? RoomOps will first remove every managed Google Calendar event, then delete the Convex record. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingBookingId(booking._id);
    setPageError("");
    setPageNotice("");
    try {
      const result = await deleteBooking({
        bookingId: booking._id,
        expectedRevision: booking.revision,
      });
      setPageNotice(
        result.deleted
          ? `Booking ${booking.jotformSubmissionId} and its managed Calendar events were deleted.`
          : "That booking was already gone.",
      );
    } catch (caught) {
      setPageError(messageFromError(caught));
    } finally {
      setDeletingBookingId(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en");
    return (bookings ?? []).filter((booking) => {
      const matchesStatus =
        status === "all" || booking.status === status;
      const matchesQuery =
        !needle ||
        [
          booking.room,
          booking.requesterName,
          booking.requesterEmail,
          booking.jotformSubmissionId,
          booking.eventName ?? "",
          booking.purpose ?? "",
          booking.ministry ?? "",
        ].some((value) =>
          value.toLocaleLowerCase("en").includes(needle),
        );
      return matchesStatus && matchesQuery;
    });
  }, [bookings, query, status]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">BOOKING OPERATIONS</span>
          <h1>Requests</h1>
          <p>
            Pending and approved requests block overlapping bookings for
            the same room.
          </p>
        </div>
      </header>

      {pageError && (
        <div className="form-error page-error" role="alert">
          {pageError}
        </div>
      )}
      {pageNotice && (
        <div className="sheet-feedback sheet-feedback-success" role="status">
          {pageNotice}
        </div>
      )}

      <section className="toolbar panel">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search room, requester, email, or submission ID"
            aria-label="Search booking requests"
          />
        </label>
        <select
          className="filter-select"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="unavailable">Unavailable</option>
        </select>
      </section>

      <section className="panel table-panel">
        <div className="table-scroll">
          <table className="data-table booking-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Room & time</th>
                <th>Status</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!bookings ? (
                <tr>
                  <td colSpan={4} className="table-message">
                    Loading booking requests…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-message">
                    No booking requests match this view.
                  </td>
                </tr>
              ) : (
                filtered.map((booking) => (
                  <tr
                    key={booking._id}
                    className={
                      (booking.conflictWarningBookingIds?.length ?? 0) >
                      0
                        ? "booking-row-conflict"
                        : undefined
                    }
                  >
                    <td>
                      <div className="primary-cell">
                        <strong>{booking.requesterName}</strong>
                        <span>{booking.requesterEmail}</span>
                        <small>
                          JF {booking.jotformSubmissionId}
                        </small>
                        {(booking.eventName ||
                          booking.purpose ||
                          booking.ministry) && (
                          <small>
                            {booking.eventName ||
                              booking.purpose ||
                              "Room Booking"}
                            {booking.ministry
                              ? ` · ${booking.ministry}`
                              : ""}
                          </small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="primary-cell">
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
                        {booking.recurrenceFrequency !== "none" && (
                          <>
                            <small>
                              {
                                RECURRENCE_LABELS[
                                  booking.recurrenceFrequency
                                ]
                              }{" "}
                              · {booking.recurrenceCount} occurrences
                            </small>
                            {booking.recurrenceUntilAt && (
                              <small>
                                Requested through{" "}
                                {formatDate(
                                  booking.recurrenceUntilAt,
                                  booking.timezone,
                                )}
                              </small>
                            )}
                            {booking.occurrences.length > 1 && (
                              <small>
                                Final occurrence{" "}
                                {formatDateTime(
                                  booking.occurrences.at(-1)!.startAt,
                                  booking.timezone,
                                )}
                              </small>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="primary-cell">
                        <StatusBadge status={booking.status} />
                        <small>
                          Availability:{" "}
                          {booking.availabilityCheckPending
                            ? "checking — automatic retry pending"
                            : booking.calendarAvailabilityStatus}
                        </small>
                        {booking.calendarConflictSummary && (
                          <small
                            title={booking.calendarConflictSummary}
                          >
                            {booking.calendarConflictSummary}
                          </small>
                        )}
                        {(booking.conflictWarningBookingIds?.length ??
                          0) > 0 && (
                          <div
                            className="booking-conflict-warning"
                            id={`booking-conflict-${booking._id}`}
                            role="note"
                          >
                            <TriangleAlert
                              size={16}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>Pending conflict</strong>
                              Overlaps{" "}
                              {
                                booking.conflictWarningBookingIds!
                                  .length
                              }{" "}
                              other pending{" "}
                              {booking.conflictWarningBookingIds!
                                .length === 1
                                ? "request"
                                : "requests"}
                              . Review together before approving.
                            </span>
                          </div>
                        )}
                        <small>
                          Calendar:{" "}
                          {booking.calendarSyncStatus.replaceAll(
                            "_",
                            " ",
                          )}
                        </small>
                        {booking.calendarSyncError && (
                          <small title={booking.calendarSyncError}>
                            Calendar action needs attention
                          </small>
                        )}
                        {booking.deletionError && (
                          <small title={booking.deletionError}>
                            Previous deletion needs retry
                          </small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        {canEdit && (
                          <button
                            className="icon-button"
                            aria-label={`Edit ${booking.room} booking`}
                            disabled={
                              booking.availabilityCheckPending ||
                              booking.calendarSyncStatus === "creating" ||
                              booking.deletionInProgress
                            }
                            title={
                              booking.availabilityCheckPending
                                ? "Wait for the intake availability check to finish."
                                : booking.deletionInProgress
                                  ? "Safe Calendar and booking deletion is in progress."
                                : booking.calendarSyncStatus === "creating"
                                ? "Wait for Google Calendar synchronization to finish."
                                : "Edit booking"
                            }
                            onClick={() => setEditing(booking)}
                          >
                            <Pencil size={16} />
                          </button>
                        )}
                        {canEdit &&
                          booking.status === "approved" &&
                          booking.calendarSyncStatus === "failed" && (
                            <button
                              className="icon-button"
                              aria-label={`Retry Google Calendar synchronization for ${booking.room}`}
                              title="Retry Google Calendar synchronization"
                              disabled={
                                retryingBookingId === booking._id ||
                                booking.deletionInProgress
                              }
                              onClick={() =>
                                void retryCalendar(booking)
                              }
                            >
                              <RotateCcw size={16} />
                            </button>
                          )}
                        {canEdit && (
                          <button
                            className="icon-button action-reject"
                            aria-label={`Delete ${booking.room} booking`}
                            title={
                              booking.deletionInProgress
                                ? "Safe Calendar and booking deletion is already in progress."
                                : "Delete booking and managed Calendar events"
                            }
                            disabled={
                              booking.deletionInProgress ||
                              deletingBookingId === booking._id
                            }
                            onClick={() => void removeBooking(booking)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                        {canApprove &&
                          booking.status === "pending" &&
                          !booking.availabilityCheckPending && (
                          <>
                            <button
                              className="icon-button action-approve"
                              aria-label={`Approve ${booking.room} booking`}
                              aria-describedby={
                                (booking.conflictWarningBookingIds
                                  ?.length ?? 0) > 0
                                  ? `booking-conflict-${booking._id}`
                                  : undefined
                              }
                              onClick={() =>
                                setDecision({
                                  booking,
                                  decision: "approve",
                                })
                              }
                              disabled={booking.deletionInProgress}
                            >
                              <Check size={17} />
                            </button>
                            <button
                              className="icon-button action-reject"
                              aria-label={`Reject ${booking.room} booking`}
                              aria-describedby={
                                (booking.conflictWarningBookingIds
                                  ?.length ?? 0) > 0
                                  ? `booking-conflict-${booking._id}`
                                  : undefined
                              }
                              onClick={() =>
                                setDecision({
                                  booking,
                                  decision: "reject",
                                })
                              }
                              disabled={booking.deletionInProgress}
                            >
                              <X size={17} />
                            </button>
                          </>
                        )}
                        {booking.status === "pending" &&
                          booking.availabilityCheckPending && (
                            <span className="view-only-label">
                              Availability check pending
                            </span>
                          )}
                        {!canEdit &&
                          (!canApprove ||
                            booking.status !== "pending") &&
                          !booking.availabilityCheckPending && (
                            <span className="view-only-label">
                              View only
                            </span>
                          )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {decision && (
        <DecisionDialog
          booking={decision.booking}
          decision={decision.decision}
          close={() => setDecision(null)}
        />
      )}
      {editing && (
        <EditDialog
          booking={editing}
          close={() => setEditing(null)}
        />
      )}
    </div>
  );
}
