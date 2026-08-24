"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleSlash2,
  Clock3,
  ExternalLink,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/ui";
import { StatusBadge } from "@/components/status-badge";

import { JOTFORM_FORM_ID, JOTFORM_FORM_URL } from "@/shared/jotformConstants";
type Booking = {
  _id: string;
  room: string;
  requesterName: string;
  startAt: number;
  timezone: string;
  status: string;
  conflictWarningBookingIds?: string[];
};

type OverviewCounts = {
  pending: number;
  availabilityChecking: number;
  approved: number;
  unavailable: number;
  detectedConflictRequests: number;
  pendingConflictRequests: number;
  pendingConflictPairs: number;
  unavailableConflictRequests: number;
};

export default function HomePage() {
  const profile = useQuery(api.users.me);
  const bookings = (useQuery(api.bookings.list) ?? []) as Booking[];
  const overview = useQuery(
    api.bookings.overviewCounts,
  ) as OverviewCounts | undefined;
  const counts: OverviewCounts = overview ?? {
    pending: 0,
    availabilityChecking: 0,
    approved: 0,
    unavailable: 0,
    detectedConflictRequests: 0,
    pendingConflictRequests: 0,
    pendingConflictPairs: 0,
    unavailableConflictRequests: 0,
  };
  const displayCount = (value: number) =>
    overview === undefined ? "—" : value;

  return (
    <div className="page">
      <header className="page-header overview-header">
        <div>
          <span className="eyebrow">OPERATIONS OVERVIEW</span>
          <h1>Good to see you, {profile?.displayName ?? "admin"}.</h1>
          <p>
            New Jotform requests appear here as soon as Convex processes
            them.
          </p>
        </div>
        <a
          className="button button-secondary"
          href={JOTFORM_FORM_URL}
          target="_blank"
          rel="noreferrer"
        >
          Open Jotform <ExternalLink size={16} aria-hidden="true" />
        </a>
      </header>

      <section
        className="metric-grid"
        aria-label="Booking overview"
        aria-busy={overview === undefined}
      >
        <article className="metric-card metric-warm">
          <span className="metric-icon">
            <Clock3 size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>{displayCount(counts.pending)}</strong>
            <span>
              Awaiting decision
              {overview !== undefined &&
                counts.availabilityChecking > 0 &&
                ` · ${counts.availabilityChecking} availability ${
                  counts.availabilityChecking === 1
                    ? "check"
                    : "checks"
                } pending`}
            </span>
          </div>
        </article>
        <article className="metric-card metric-green">
          <span className="metric-icon">
            <CheckCircle2 size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>{displayCount(counts.approved)}</strong>
            <span>Approved bookings</span>
          </div>
        </article>
        <article className="metric-card metric-rose">
          <span className="metric-icon">
            <CircleSlash2 size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>{displayCount(counts.unavailable)}</strong>
            <span>Unavailable bookings</span>
          </div>
        </article>
        <article className="metric-card metric-conflict">
          <span className="metric-icon">
            <TriangleAlert size={20} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {displayCount(counts.detectedConflictRequests)}
            </strong>
            <span>
              Detected conflict requests
              {overview !== undefined &&
                ` · ${counts.pendingConflictRequests} pending, ${counts.unavailableConflictRequests} auto-unavailable · ${counts.pendingConflictPairs} overlap ${
                  counts.pendingConflictPairs === 1 ? "pair" : "pairs"
                }`}
            </span>
          </div>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">LIVE QUEUE</span>
              <h2>Recent requests</h2>
            </div>
            <Link href="/bookings" className="text-link">
              View all <ArrowRight size={15} />
            </Link>
          </div>
          <div className="recent-list">
            {bookings.length === 0 ? (
              <div className="empty-state compact-empty">
                <CalendarClock size={25} />
                <p>No Jotform bookings have arrived yet.</p>
              </div>
            ) : (
              bookings.slice(0, 6).map((booking) => (
                <div className="recent-row" key={booking._id}>
                  <span className="room-avatar" aria-hidden="true">
                    {booking.room.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="recent-main">
                    <strong>{booking.room}</strong>
                    <span>
                      {booking.requesterName} ·{" "}
                      {formatDateTime(
                        booking.startAt,
                        booking.timezone,
                      )}
                    </span>
                  </div>
                  <div className="recent-status">
                    {(booking.conflictWarningBookingIds?.length ?? 0) >
                      0 && (
                      <span
                        className="recent-conflict-indicator"
                        role="img"
                        aria-label="Pending booking conflict"
                        title="Overlaps another pending request"
                      >
                        <TriangleAlert
                          size={15}
                          aria-hidden="true"
                        />
                      </span>
                    )}
                    <StatusBadge status={booking.status} />
                  </div>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="panel workflow-panel">
          <span className="panel-kicker">AUTOMATION</span>
          <h2>Request flow</h2>
          <ol className="workflow-list">
            <li>
              <span>1</span>
              <div>
                <strong>Jotform received</strong>
                <p>The webhook queues only the submission ID.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Conflict checked</strong>
                <p>
                  Convex reservations and every physical Google Calendar
                  are checked for all occurrences.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Review or unavailable</strong>
                <p>
                  Available slots enter the approver queue automatically.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Approved and scheduled</strong>
                <p>
                  Approval checks availability again, creates the venue
                  calendar event, and records the result in Convex.
                </p>
              </div>
            </li>
          </ol>
        </article>
      </section>
    </div>
  );
}
