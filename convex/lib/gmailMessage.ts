import { bookingDeletionInProgress } from "./bookingDeletion";

export function cleanEmailLine(
  value: string | undefined,
  fallback = "",
  maxLength = 1_000,
): string {
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, maxLength) || fallback
  );
}

export function normalizeEmailAddress(value: string): string {
  const email = cleanEmailLine(value, "", 254).toLowerCase();
  if (
    !email ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      email,
    )
  ) {
    throw new Error("EMAIL_ADDRESS_INVALID");
  }
  return email;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + 16_384),
    );
  }
  return btoa(binary);
}

function utf8Base64Url(value: string): string {
  return utf8Base64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodedSubject(value: string): string {
  const subject = cleanEmailLine(
    value,
    "RoomOps notification",
    240,
  );
  return /[^\x20-\x7e]/.test(subject)
    ? `=?UTF-8?B?${utf8Base64(subject)}?=`
    : subject;
}

export function encodeGmailMime(input: {
  boundary: string;
  from: string;
  html: string;
  messageKey: string;
  subject: string;
  text: string;
  to: string;
}): string {
  const from = normalizeEmailAddress(input.from);
  const to = normalizeEmailAddress(input.to);
  const boundary = cleanEmailLine(input.boundary, "", 120).replace(
    /[^a-z0-9_-]/gi,
    "",
  );
  if (!boundary) throw new Error("MIME_BOUNDARY_INVALID");
  const domain = from.split("@")[1] ?? "roomops.invalid";
  const safeMessageKey =
    input.messageKey.replace(/[^a-z0-9_-]/gi, "") || "notification";
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject(input.subject)}`,
    `Message-ID: <roomops-${safeMessageKey}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html,
    "",
    `--${boundary}--`,
  ].join("\r\n");
  return utf8Base64Url(message);
}

export function isRetryableGmailStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

export function initialBookingEmailDelay(
  kind: Extract<
    BookingEmailKind,
    | "requester_submission_received"
    | "requester_unavailable"
    | "approver_request"
  >,
): number {
  return kind === "requester_submission_received" ? 0 : 1_500;
}

export function canRevokeTokenForTerminalNotification(
  token: {
    claimExpiresAt?: number;
    claimToken?: string;
    revokedAt?: number;
    usedAt?: number;
  },
  now: number,
): boolean {
  return (
    token.usedAt === undefined &&
    token.revokedAt === undefined &&
    !(
      token.claimToken !== undefined &&
      (token.claimExpiresAt ?? 0) > now
    )
  );
}

export function emailDependencyGate(
  status:
    | "pending"
    | "sending"
    | "sent"
    | "failed"
    | "cancelled"
    | "blocked"
    | undefined,
): "ready" | "wait" | "block" {
  if (status === "sent") return "ready";
  if (status === "pending" || status === "sending") return "wait";
  return "block";
}

export type BookingEmailKind =
  | "requester_submission_received"
  | "requester_unavailable"
  | "approver_request"
  | "requester_approved"
  | "requester_rejected"
  | "approver_conflict_urgent";

export function urgentConflictDeliveryRecoveryMode(
  status:
    | "pending"
    | "sending"
    | "sent"
    | "failed"
    | "cancelled"
    | "blocked",
  hasObsoleteDependency: boolean,
): "none" | "clear_dependency" | "requeue" {
  if (
    hasObsoleteDependency &&
    (status === "pending" || status === "blocked")
  ) {
    return "requeue";
  }
  if (status === "sending" && hasObsoleteDependency) {
    return "clear_dependency";
  }
  return "none";
}

export type ConflictAlertBookingState = {
  id: string;
  status: "pending" | "approved" | "rejected" | "unavailable" | "cancelled";
  availabilityCheckPending?: boolean;
  calendarAvailabilityStatus?: "unchecked" | "available" | "conflict";
  calendarSyncAttempts?: number;
  conflictBookingId?: string;
  conflictWarningBookingIds?: readonly string[];
  deletionToken?: string;
  deletionLeaseExpiresAt?: number;
  revision?: number;
};

/**
 * Identifies one persisted conflict episode without making delivery retries
 * produce new messages. RoomOps conflicts advance with the booking revision;
 * standalone Calendar conflicts also include the sync attempt because a retry
 * can discover a fresh conflict without changing the approved booking revision.
 */
export function conflictAlertEpisodeKey(
  booking: ConflictAlertBookingState,
  relatedBookingIds: readonly string[],
): string {
  const related = [
    ...new Set(
      relatedBookingIds.filter(
        (bookingId) => bookingId !== booking.id,
      ),
    ),
  ].sort();
  const revision = Math.max(
    0,
    Math.floor(booking.revision ?? 0),
  );
  if (related.length > 0) {
    const cause = booking.conflictBookingId
      ? `decided:${booking.conflictBookingId}`
      : booking.status === "pending"
        ? "pending-warning"
        : `related:${booking.status}`;
    return [
      `revision=${revision}`,
      `cause=${cause}`,
      `related=${related.join(",")}`,
    ].join("|");
  }

  return [
    `revision=${revision}`,
    `cause=calendar:${booking.status}`,
    `attempt=${Math.max(
      0,
      Math.floor(booking.calendarSyncAttempts ?? 0),
    )}`,
  ].join("|");
}

/**
 * Conflict-alert deliveries are durable and can run after either booking has
 * changed. Only persisted, current RoomOps conflict edges are safe to include.
 */
export function isCurrentConflictAlertPair(
  primary: ConflictAlertBookingState,
  related: ConflictAlertBookingState,
  now: number,
): boolean {
  if (
    primary.id === related.id ||
    primary.availabilityCheckPending === true ||
    related.availabilityCheckPending === true ||
    bookingDeletionInProgress(primary, now) ||
    bookingDeletionInProgress(related, now)
  ) {
    return false;
  }

  const pendingWarning =
    primary.status === "pending" &&
    related.status === "pending" &&
    (primary.conflictWarningBookingIds ?? []).includes(related.id) &&
    (related.conflictWarningBookingIds ?? []).includes(primary.id);
  const decidedConflict =
    (primary.status === "unavailable" &&
      related.status === "approved" &&
      primary.conflictBookingId === related.id) ||
    (primary.status === "approved" &&
      related.status === "unavailable" &&
      related.conflictBookingId === primary.id);

  return pendingWarning || decidedConflict;
}

export function isCurrentStandaloneCalendarConflict(
  booking: ConflictAlertBookingState,
  now: number,
): boolean {
  return (
    booking.availabilityCheckPending !== true &&
    !bookingDeletionInProgress(booking, now) &&
    (booking.status === "unavailable" ||
      booking.status === "approved") &&
    booking.calendarAvailabilityStatus === "conflict" &&
    booking.conflictBookingId === undefined
  );
}

export function availabilityFollowupKind(input: {
  availabilityCheckPending?: boolean;
  status: "pending" | "approved" | "rejected" | "unavailable" | "cancelled";
}): "approver_request" | "requester_unavailable" | null {
  if (input.availabilityCheckPending === true) return null;
  if (input.status === "pending") return "approver_request";
  if (input.status === "unavailable") return "requester_unavailable";
  return null;
}

export function requiresRequesterReceipt(
  kind: BookingEmailKind,
): boolean {
  return (
    kind !== "requester_submission_received" &&
    kind !== "approver_conflict_urgent"
  );
}

/**
 * A follow-up may only use a sent receipt from the same booking as its
 * durable prerequisite. A missing or cross-booking pointer fails closed.
 */
export function bookingEmailDependencyGate(
  kind: BookingEmailKind,
  bookingId: string,
  dependency:
    | {
        bookingId: string;
        kind: BookingEmailKind;
        status:
          | "pending"
          | "sending"
          | "sent"
          | "failed"
          | "cancelled"
          | "blocked";
      }
    | null
    | undefined,
): "ready" | "wait" | "block" {
  if (!requiresRequesterReceipt(kind)) return "ready";
  if (
    !dependency ||
    dependency.bookingId !== bookingId ||
    dependency.kind !== "requester_submission_received"
  ) {
    return "block";
  }
  return emailDependencyGate(dependency.status);
}
