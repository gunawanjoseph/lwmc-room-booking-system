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

export function availabilityFollowupKind(input: {
  availabilityCheckPending?: boolean;
  status: "pending" | "approved" | "rejected" | "unavailable";
}): "approver_request" | "requester_unavailable" | null {
  if (input.availabilityCheckPending === true) return null;
  if (input.status === "pending") return "approver_request";
  if (input.status === "unavailable") return "requester_unavailable";
  return null;
}

export function requiresRequesterReceipt(
  kind: BookingEmailKind,
): boolean {
  return kind !== "requester_submission_received";
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
