"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { Check, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { PublicEmailDecisionView } from "@/convex/lib/emailDecisionView";
import {
  formatDate,
  formatDateTime,
  messageFromError,
} from "@/lib/ui";

type DecisionInfo = PublicEmailDecisionView;

const recurrenceLabels = {
  none: "Does not repeat",
  daily: "Daily",
  weekly_same_day: "Every week",
  biweekly_same_day: "Every 2 weeks",
  monthly_same_day: "Every month on the same day",
  monthly_same_date: "Every month on the same date",
} as const;

export default function EmailDecisionPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const info = useQuery(api.approvers.getDecisionByToken, {
    token,
  }) as DecisionInfo | undefined;
  const decide = useAction(api.googleCalendar.decide);
  const [decision, setDecision] = useState<"approve" | "reject">(
    "approve",
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!info || info.state !== "actionable") return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const result = (await decide({
        bookingId: info.booking._id,
        decision,
        note: note || undefined,
        token,
      })) as {
        status: "approved" | "rejected" | "unavailable";
      };
      setDone(
        result.status === "approved"
          ? "Booking approved and added to Google Calendar."
          : result.status === "unavailable"
            ? "The request could not be approved because the venue is no longer available."
            : "Booking rejected.",
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="email-decision-page">
      <section className="panel email-decision-card">
        <span className="eyebrow">ROOMOPS EMAIL DECISION</span>
        <h1>Review booking request</h1>

        {done ? (
          <div className="sheet-feedback sheet-feedback-success">
            {done}
          </div>
        ) : info === undefined ? (
          <p>Loading approval link…</p>
        ) : info.state === "invalid" ? (
          <p>This approval link is invalid.</p>
        ) : info.state === "terminal" ? (
          <div className="info-banner">
            This approval link has already reached a final state and can
            no longer be used.
          </div>
        ) : (
          <>
            <div className="decision-summary public-decision-summary">
              <span>{info.booking.room}</span>
              <strong>
                {info.booking.eventName ||
                  info.booking.purpose ||
                  "Room booking"}
              </strong>
              <small>
                {formatDateTime(
                  info.booking.startAt,
                  info.booking.timezone,
                )}{" "}
                to{" "}
                {formatDateTime(
                  info.booking.endAt,
                  info.booking.timezone,
                )}
              </small>
              <small>
                Requested by {info.booking.requesterName} ·{" "}
                {info.booking.requesterEmail}
              </small>
              {info.booking.ministry && (
                <small>Ministry: {info.booking.ministry}</small>
              )}
              {info.booking.recurrenceFrequency !== "none" && (
                <>
                  <small>
                    Repeat:{" "}
                    {
                      recurrenceLabels[
                        info.booking.recurrenceFrequency
                      ]
                    }{" "}
                    · {info.booking.recurrenceCount} occurrences
                  </small>
                  {info.booking.recurrenceUntilAt !== undefined && (
                    <small>
                      Requested last date:{" "}
                      {formatDate(
                        info.booking.recurrenceUntilAt,
                        info.booking.timezone,
                      )}
                    </small>
                  )}
                  {info.booking.occurrences.length > 1 && (
                    <small>
                      Final occurrence:{" "}
                      {formatDateTime(
                        info.booking.occurrences.at(-1)!.startAt,
                        info.booking.timezone,
                      )}{" "}
                      to{" "}
                      {formatDateTime(
                        info.booking.occurrences.at(-1)!.endAt,
                        info.booking.timezone,
                      )}
                    </small>
                  )}
                </>
              )}
            </div>

            {info.booking.conflictWarningCount > 0 && (
              <div className="info-banner">
                Warning: this request overlaps{" "}
                {info.booking.conflictWarningCount} other pending{" "}
                {info.booking.conflictWarningCount === 1
                  ? "request"
                  : "requests"}
                . Review the conflict before deciding.
              </div>
            )}

            {info.claimed && !busy ? (
              <div className="info-banner">
                This decision is currently being processed. Refresh after
                it finishes; a failed processing claim releases
                automatically.
              </div>
            ) : (
              <form onSubmit={submit} className="email-decision-form">
                <div className="decision-toggle">
                  <button
                    type="button"
                    className={
                      decision === "approve"
                        ? "button button-primary"
                        : "button button-secondary"
                    }
                    onClick={() => setDecision("approve")}
                  >
                    <Check size={16} />
                    Approve
                  </button>
                  <button
                    type="button"
                    className={
                      decision === "reject"
                        ? "button button-danger"
                        : "button button-secondary"
                    }
                    onClick={() => setDecision("reject")}
                  >
                    <X size={16} />
                    Reject
                  </button>
                </div>
                <label className="field">
                  <span>Remark/comment to requester</span>
                  <textarea
                    rows={4}
                    maxLength={1_000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="This comment will be included in the email sent to the requester."
                  />
                </label>
                {error && <div className="form-error">{error}</div>}
                <button className="button button-primary" disabled={busy}>
                  {busy ? "Submitting…" : "Submit decision"}
                </button>
              </form>
            )}
          </>
        )}

        <Link href="/" className="text-link">
          Return to RoomOps
        </Link>
      </section>
    </main>
  );
}
