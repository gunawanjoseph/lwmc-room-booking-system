"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAction,
  useConvex,
  useMutation,
  useQuery,
} from "convex/react";
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
import { isBookingCalendarProcessing } from "@/lib/booking-conflict-transition";
import { BookingRemovalPanel } from "@/components/booking-removal-panel";
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
    room?: string;
    resolvedVenues?: string[];
    details?: { eventName?: string; purpose?: string; ministry?: string };
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
  close: (notice?: string) => void;
}) {
  const decide = useAction(api.googleCalendar.decide);
  const queueCalendarApproval = useMutation(
    api.bookings.queueCalendarApproval,
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictsConfirmed, setConflictsConfirmed] = useState(false);
  const processing = isBookingCalendarProcessing(booking);
  const hasConflictWarning =
    (booking.conflictWarningBookingIds?.length ?? 0) > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (processing) {
      setError(
        "This booking is already being checked. Wait for the background Calendar operation to finish.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (decision === "approve") {
        const result = await queueCalendarApproval({
          bookingId: booking._id,
          note: note || undefined,
          confirmConflicts: hasConflictWarning
            ? conflictsConfirmed
            : undefined,
        });
        if (result.state === "conflict_ack_required") {
          setConflictsConfirmed(false);
          setError(
            "A pending conflict was found. Review the warning, acknowledge it, then approve again.",
          );
          return;
        }
        if (result.state === "approval_in_progress") {
          setError(
            "An overlapping booking is already being approved. Wait for that background check to finish.",
          );
          return;
        }
        close(
          result.state === "unavailable"
            ? "The booking was marked unavailable because it conflicts with an approved reservation."
            : "The approval check is running in the background. Booking controls are locked until it finishes.",
        );
        return;
      } else {
        await decide({
          bookingId: booking._id,
          decision: "reject",
          note: note || undefined,
        });
      }
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
            onClick={() => close()}
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
        {hasConflictWarning && (
          <div className="booking-conflict-warning" role="note">
            <TriangleAlert size={17} aria-hidden="true" />
            <span>
              <strong>Conflict detected</strong>
              This request overlaps one or more pending bookings. Review
              all occurrences before making a decision.
            </span>
          </div>
        )}
        {decision === "approve" && (
          <div className="info-banner">
            All {booking.recurrenceCount} occurrence
            {booking.recurrenceCount === 1 ? "" : "s"} will be checked in
            the background. You can close this dialog as soon as the
            approval check starts.
          </div>
        )}
        {decision === "approve" && hasConflictWarning && (
          <label className="confirmation-check">
            <input
              type="checkbox"
              checked={conflictsConfirmed}
              disabled={busy || processing}
              onChange={(event) =>
                setConflictsConfirmed(event.target.checked)
              }
            />
            <span>
              I reviewed the conflicting bookings and understand that
              approving this request will make the overlapping requests
              unavailable.
            </span>
          </label>
        )}
        <label className="field">
          <span>Remark/comment to requester (optional)</span>
          <textarea
            rows={3}
            maxLength={1_000}
            value={note}
            disabled={busy || processing}
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
            onClick={() => close()}
          >
            Cancel
          </button>
          <button
            disabled={
              busy ||
              processing ||
              (decision === "approve" &&
                hasConflictWarning &&
                !conflictsConfirmed)
            }
            className={
              decision === "approve"
                ? "button button-primary"
                : "button button-danger"
            }
          >
            {busy
              ? decision === "approve"
                ? "Starting background check…"
                : "Saving…"
              : processing
                ? "Calendar check in progress"
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
  const convex = useConvex();
  const edit = useMutation(api.bookings.edit);
  const [notifySubmitter, setNotifySubmitter] = useState(false);
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
    editScope: "series" as "series" | "occurrence" | "following",
    occurrenceSequence: booking.occurrences[0]?.sequence ?? 0,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [irreversibleConfirmed, setIrreversibleConfirmed] =
    useState(false);
  const [conflictsConfirmed, setConflictsConfirmed] = useState(false);
  const [previewConflicts, setPreviewConflicts] = useState<
    Array<{
      bookingId: Id<"bookings">;
      status: Booking["status"];
      room: string;
      startAt: number;
      endAt: number;
      targetVenue: string;
      occurrenceSequence: number;
    }>
  >([]);
  const processing = isBookingCalendarProcessing(booking);
  const reservationEditable =
    booking.status === "pending" || booking.status === "approved";
  const occurrenceEditAvailable =
    reservationEditable && booking.occurrences.length > 1;

  function update<Key extends keyof typeof form>(
    key: Key,
    value: (typeof form)[Key],
  ) {
    if (processing) return;
    setForm((current) => ({ ...current, [key]: value }));
    setPreviewConflicts([]);
    setConflictsConfirmed(false);
  }

  function selectOccurrence(sequence: number) {
    if (processing) return;
    const occurrence = booking.occurrences.find(
      (item) => item.sequence === sequence,
    );
    if (!occurrence) return;
    setForm((current) => ({
      ...current,
      occurrenceSequence: sequence,
      room: occurrence.room ?? booking.room,
      eventName: occurrence.details?.eventName ?? booking.eventName ?? "",
      purpose: occurrence.details?.purpose ?? booking.purpose ?? "",
      ministry: occurrence.details?.ministry ?? booking.ministry ?? "",
      start: localInputValue(occurrence.startAt, booking.timezone),
      end: localInputValue(occurrence.endAt, booking.timezone),
    }));
    setPreviewConflicts([]);
    setConflictsConfirmed(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (processing) {
      setError(
        "Editing is locked while this booking is being checked and synchronized with Google Calendar.",
      );
      return;
    }
    if (!irreversibleConfirmed) {
      setError(
        "Confirm that you understand the Calendar replacement cannot be automatically undone.",
      );
      return;
    }
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
      const editArgs = {
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
        editScope: form.editScope,
        occurrenceSequence:
          form.editScope !== "series"
            ? form.occurrenceSequence
            : undefined,
      } as const;
      const preview = (await convex.query(
        api.bookings.previewEdit,
        editArgs,
      )) as {
        conflicts: typeof previewConflicts;
      };
      const nextConflictIds = preview.conflicts
        .map((conflict) => String(conflict.bookingId))
        .sort();
      const displayedConflictIds = previewConflicts
        .map((conflict) => String(conflict.bookingId))
        .sort();
      const conflictSetChanged =
        nextConflictIds.join(",") !== displayedConflictIds.join(",");
      if (preview.conflicts.length > 0) {
        setPreviewConflicts(preview.conflicts);
        if (
          preview.conflicts.some(
            (conflict) => conflict.status === "approved",
          ) ||
          booking.status === "approved"
        ) {
          setError(
            "The proposed change conflicts with an active booking and cannot be committed.",
          );
          return;
        }
        if (conflictSetChanged || !conflictsConfirmed) {
          setConflictsConfirmed(false);
          setError(
            "Conflicts were detected. Review the warning below, acknowledge it, then save again.",
          );
          return;
        }
      } else {
        setPreviewConflicts([]);
      }
      await edit({
        ...editArgs,
        notifySubmitter,
        acknowledgedConflictBookingIds: preview.conflicts.map(
          (conflict) => conflict.bookingId,
        ),
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
            onClick={() => close()}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {booking.status === "approved" && (
          <div className="booking-conflict-warning" role="note">
            <TriangleAlert size={17} aria-hidden="true" />
            <span>
              <strong>Irreversible Calendar replacement</strong>
              Saving changes replaces the managed
              Google Calendar events from the remaining meeting schedule.
              RoomOps cannot automatically restore the prior schedule.
            </span>
          </div>
        )}
        {(booking.conflictWarningBookingIds?.length ?? 0) > 0 &&
          previewConflicts.length === 0 && (
            <div className="booking-conflict-warning" role="note">
              <TriangleAlert size={17} aria-hidden="true" />
              <span>
                <strong>Existing booking conflict</strong>
                This booking currently overlaps{" "}
                {booking.conflictWarningBookingIds!.length} pending{" "}
                {booking.conflictWarningBookingIds!.length === 1
                  ? "request"
                  : "requests"}
                . Saving a reservation change will recheck the complete
                conflict set.
              </span>
            </div>
          )}
        {!reservationEditable && (
          <div className="info-banner">
            Reservation fields can be changed only while a booking is
            pending or approved.
          </div>
        )}
        {processing && (
          <div className="info-banner" role="status">
            Editing is locked while this booking is being checked and
            synchronized with Google Calendar.
          </div>
        )}
        <div className="form-grid">
          {occurrenceEditAvailable && (
            <>
              <label className="field form-grid-full">
                <span>Edit</span>
                <select
                  disabled={busy || processing}
                  value={form.editScope}
                  onChange={(event) => {
                    const scope = event.target.value as
                      | "series"
                      | "occurrence"
                      | "following";
                    update("editScope", scope);
                    if (scope !== "series") {
                      selectOccurrence(form.occurrenceSequence);
                    } else {
                      setForm((current) => ({
                        ...current,
                        room: booking.room,
                        eventName: booking.eventName ?? "",
                        purpose: booking.purpose ?? "",
                        ministry: booking.ministry ?? "",
                        start: localInputValue(
                          booking.startAt,
                          booking.timezone,
                        ),
                        end: localInputValue(
                          booking.endAt,
                          booking.timezone,
                        ),
                      }));
                    }
                  }}
                >
                  <option value="series">
                    All events
                  </option>
                  <option value="occurrence">
                    This event
                  </option>
                  <option value="following">This and following events</option>
                </select>
              </label>
              {form.editScope !== "series" && (
                <label className="field form-grid-full">
                  <span>Occurrence</span>
                  <select
                    disabled={busy || processing}
                    value={form.occurrenceSequence}
                    onChange={(event) =>
                      selectOccurrence(Number(event.target.value))
                    }
                  >
                    {booking.occurrences.map((occurrence) => (
                      <option
                        key={occurrence.sequence}
                        value={occurrence.sequence}
                      >
                        {formatDateTime(
                          occurrence.startAt,
                          booking.timezone,
                        )}{" "}
                        · {occurrence.room ?? booking.room}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <label className="field">
            <span>Requester name</span>
            <input
              required
              disabled={busy || processing || form.editScope !== "series"}
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
              disabled={busy || processing || form.editScope !== "series"}
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
              disabled={busy || processing || !reservationEditable}
              value={form.room}
              onChange={(event) => update("room", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Start ({booking.timezone})</span>
            <input
              required
              disabled={busy || processing || !reservationEditable}
              type="datetime-local"
              value={form.start}
              onChange={(event) => update("start", event.target.value)}
            />
          </label>
          <label className="field">
            <span>End ({booking.timezone})</span>
            <input
              required
              disabled={busy || processing || !reservationEditable}
              type="datetime-local"
              value={form.end}
              onChange={(event) => update("end", event.target.value)}
            />
          </label>
          <label className="field form-grid-full">
            <span>Event name</span>
            <input
              disabled={busy || processing}
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
              disabled={busy || processing}
              value={form.purpose}
              onChange={(event) => update("purpose", event.target.value)}
            />
          </label>
          <label className="field form-grid-full">
            <span>Ministry</span>
            <input
              disabled={busy || processing}
              value={form.ministry}
              onChange={(event) =>
                update("ministry", event.target.value)
              }
            />
          </label>
          {form.editScope !== "series" && <p className="form-grid-full">Event name, purpose, ministry, room and timing apply only to the selected scope. Contact details belong to the whole booking. “This and following” shifts each later meeting by the same amount and applies the selected duration; its existing repeat pattern is kept.</p>}
          {form.editScope === "series" && (
            <>
              <label className="field form-grid-full">
                <span>Repeat</span>
                <select
                  disabled={busy || processing || !reservationEditable}
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
                  <option value="biweekly_same_day">
                    Every 2 weeks
                  </option>
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
                    <span>
                      Does this recurring booking have an end date?
                    </span>
                    <select
                      disabled={
                        busy || processing || !reservationEditable
                      }
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
                        disabled={
                          busy || processing || !reservationEditable
                        }
                        type="date"
                        min={form.start.slice(0, 10)}
                        value={form.recurrenceUntil}
                        onChange={(event) =>
                          update(
                            "recurrenceUntil",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {previewConflicts.length > 0 && (
          <div className="booking-conflict-warning" role="alert">
            <TriangleAlert size={17} aria-hidden="true" />
            <span>
              <strong>
                {previewConflicts.length} conflict
                {previewConflicts.length === 1 ? "" : "s"} detected
              </strong>
              {previewConflicts.map((conflict) => (
                <small key={conflict.bookingId}>
                  {conflict.targetVenue} ·{" "}
                  {formatDateTime(
                    conflict.startAt,
                    booking.timezone,
                  )}{" "}
                  · {conflict.status}
                </small>
              ))}
            </span>
          </div>
        )}
        {previewConflicts.length > 0 &&
          booking.status === "pending" &&
          previewConflicts.every(
            (conflict) => conflict.status === "pending",
          ) && (
            <label className="confirmation-check">
              <input
                type="checkbox"
                disabled={busy || processing}
                checked={conflictsConfirmed}
                onChange={(event) =>
                  setConflictsConfirmed(event.target.checked)
                }
              />
              <span>
                I reviewed these pending conflicts and want to save the
                warned booking.
              </span>
            </label>
          )}
        <label className="confirmation-check">
          <input
            type="checkbox"
            disabled={busy || processing}
            checked={irreversibleConfirmed}
            onChange={(event) =>
              setIrreversibleConfirmed(event.target.checked)
            }
          />
          <span>
            I understand this action cannot be automatically undone and
            Calendar events may be replaced, including past dates when selected.
          </span>
        </label>
        {error && <div className="form-error">{error}</div>}
        <label className="notification-choice"><input type="checkbox" checked={notifySubmitter} disabled={busy} onChange={event=>setNotifySubmitter(event.target.checked)}/><span>Email the submitter after saving these changes</span></label>
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => close()}
          >
            Cancel
          </button>
          <button
            disabled={busy || processing || !irreversibleConfirmed}
            className="button button-primary"
          >
            {processing
              ? "Calendar processing in progress"
              : busy
                ? "Saving…"
                : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function BookingsPage() {

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
  const [requestedBooking, setRequestedBooking] = useState<string | null>(null);
  useEffect(() => { setRequestedBooking(new URLSearchParams(window.location.search).get("booking")); }, []);
  const [status, setStatus] = useState("all");
  const [decision, setDecision] = useState<{
    booking: Booking;
    decision: "approve" | "reject";
  } | null>(null);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [retryingBookingId, setRetryingBookingId] =
    useState<Id<"bookings"> | null>(null);
  const [removing, setRemoving] = useState<Booking | null>(null);
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");

  const canApprove =
    profile?.capabilities.includes("bookings.approve") ?? false;
  const canEdit =
    profile?.capabilities.includes("bookings.edit") ?? false;
  const currentEditingBooking = editing
    ? bookings?.find((booking) => booking._id === editing._id) ??
      editing
    : null;
  const currentDecisionBooking = decision
    ? bookings?.find(
        (booking) => booking._id === decision.booking._id,
      ) ?? decision.booking
    : null;

  useEffect(() => {
    if (
      currentEditingBooking &&
      isBookingCalendarProcessing(currentEditingBooking)
    ) {
      const timer = setTimeout(() => {
        setEditing(null);
        setPageNotice(
          "Editing closed because this booking is being checked in the background. Its controls will unlock when Calendar processing finishes.",
        );
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentEditingBooking]);

  useEffect(() => {
    if (
      currentDecisionBooking &&
      isBookingCalendarProcessing(currentDecisionBooking)
    ) {
      const timer = setTimeout(() => {
        setDecision(null);
        setPageNotice(
          "The approval check is running in the background. Booking controls are locked until it finishes.",
        );
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentDecisionBooking]);

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

  function removeBooking(booking: Booking) { setRemoving(booking); }

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en");
    return (bookings ?? []).filter((booking) => {
      if (requestedBooking && String(booking._id) !== requestedBooking) return false;
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
  }, [bookings, query, status, requestedBooking]);

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
        {requestedBooking && <button className="button button-secondary" onClick={() => setRequestedBooking(null)}>Show all bookings</button>}
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
                              isBookingCalendarProcessing(booking) ||
                              booking.deletionInProgress
                            }
                            title={
                              booking.availabilityCheckPending
                                ? "Wait for the intake availability check to finish."
                                : booking.deletionInProgress
                                  ? "Safe Calendar and booking deletion is in progress."
                                  : isBookingCalendarProcessing(booking)
                                    ? "Wait for the background Calendar operation to finish."
                                    : "Edit booking"
                            }
                            onClick={() => setEditing(booking)}
                          >
                            <Pencil size={16} />
                          </button>
                        )}
                        {canEdit &&
                          booking.status === "approved" &&
                          (booking.calendarSyncStatus === "failed" ||
                            booking.calendarSyncStatus === "synced") && (
                            <button
                              className="icon-button"
                              aria-label={`${booking.calendarSyncStatus === "synced" ? "Verify or repair" : "Retry"} Google Calendar synchronization for ${booking.room}`}
                              title={
                                booking.calendarSyncStatus === "synced"
                                  ? "Verify or repair Google Calendar synchronization"
                                  : "Retry Google Calendar synchronization"
                              }
                              disabled={
                                retryingBookingId === booking._id ||
                                isBookingCalendarProcessing(booking) ||
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
                              isBookingCalendarProcessing(booking)
                                ? "Wait for the background Calendar operation to finish."
                                : booking.deletionInProgress
                                  ? "Safe Calendar and booking deletion is already in progress."
                                  : "Delete booking and managed Calendar events"
                            }
                            disabled={
                              isBookingCalendarProcessing(booking) ||
                              booking.deletionInProgress ||
                              removing?._id === booking._id
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
                              disabled={
                                isBookingCalendarProcessing(booking) ||
                                booking.deletionInProgress
                              }
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
                              disabled={
                                isBookingCalendarProcessing(booking) ||
                                booking.deletionInProgress
                              }
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
                        {isBookingCalendarProcessing(booking) && (
                          <span className="view-only-label" role="status">
                            Calendar processing in progress
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

      {removing && <BookingRemovalPanel booking={removing} close={(notice) => { setRemoving(null); if (notice) setPageNotice(notice); }} />}
      {decision && (
        <DecisionDialog
          booking={currentDecisionBooking ?? decision.booking}
          decision={decision.decision}
          close={(notice) => {
            setDecision(null);
            if (notice) setPageNotice(notice);
          }}
        />
      )}
      {editing && currentEditingBooking && (
        <EditDialog
          booking={currentEditingBooking}
          close={() => setEditing(null)}
        />
      )}
    </div>
  );
}
