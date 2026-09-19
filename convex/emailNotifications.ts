import { bookingWindow, filterMeetings, sortMeetings, meetingTable, escapeBookingHtml, type SubmitterMeeting } from "./lib/submitterBookings";
import { writeAuditLog } from "./lib/auditLog";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActionHeadAdmin } from "./lib/actionAuth";
import {
  formatLocalDate,
  formatLocalDateTime,
} from "./lib/emailText";
import {
  availabilityFollowupKind,
  bookingEmailDependencyGate,
  canRevokeTokenForTerminalNotification,
  cleanEmailLine,
  conflictAlertEpisodeKey,
  encodeGmailMime,
  initialBookingEmailDelay,
  isCurrentConflictAlertPair,
  isCurrentStandaloneCalendarConflict,
  isRetryableGmailStatus,
  normalizeEmailAddress,
  requiresRequesterReceipt,
  urgentConflictDeliveryRecoveryMode,
  type ConflictAlertBookingState,
} from "./lib/gmailMessage";
import { bookingDeletionInProgress } from "./lib/bookingDeletion";

type Booking = Doc<"bookings">;
type EmailDelivery = Doc<"emailDeliveries">;
type EmailDeliveryKind = EmailDelivery["kind"];

type GmailConfiguration = {
  appBaseUrl: string;
  clientId: string;
  clientSecret: string;
  fromEmail: string;
  refreshToken: string;
};

type GmailAccess = {
  token: string;
  expiresAt: number;
  scope?: string;
};

type DeliveryContext = {
  booking: Booking;
  decisionToken: Doc<"emailDecisionTokens"> | null;
  delivery: EmailDelivery;
  relatedBookings: Booking[];
};

type DeliveryContextLookup =
  | { state: "ready"; context: DeliveryContext }
  | { state: "cancel"; reason: string };

const DELIVERY_LEASE_MS = 2 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const REQUEST_TIMEOUT_MS = 15_000;
const DECISION_LINK_LIFETIME_MS = 14 * 24 * 60 * 60_000;

let cachedAccess: GmailAccess | undefined;

function conflictAlertState(
  booking: Booking,
): ConflictAlertBookingState {
  return {
    id: String(booking._id),
    status: booking.status,
    availabilityCheckPending: booking.availabilityCheckPending,
    calendarAvailabilityStatus: booking.calendarAvailabilityStatus,
    calendarSyncAttempts: booking.calendarSyncAttempts,
    conflictBookingId: booking.conflictBookingId
      ? String(booking.conflictBookingId)
      : undefined,
    conflictWarningBookingIds:
      booking.conflictWarningBookingIds?.map(String),
    deletionToken: booking.deletionToken,
    deletionLeaseExpiresAt: booking.deletionLeaseExpiresAt,
    revision: booking.revision,
  };
}

async function currentConflictRelatedBookings(
  ctx: MutationCtx | QueryCtx,
  booking: Booking,
  relatedBookingIds: readonly Id<"bookings">[],
  now: number,
): Promise<Booking[]> {
  const current: Booking[] = [];
  const seen = new Set<string>();
  for (const bookingId of relatedBookingIds) {
    const key = String(bookingId);
    if (seen.has(key)) continue;
    seen.add(key);
    const related = await ctx.db.get(bookingId);
    if (
      related &&
      isCurrentConflictAlertPair(
        conflictAlertState(booking),
        conflictAlertState(related),
        now,
      )
    ) {
      current.push(related);
    }
  }
  return current;
}

function hasCurrentConflictAlertCause(
  booking: Booking,
  relatedBookings: readonly Booking[],
  requestedRelatedCount: number,
  now: number,
): boolean {
  return (
    relatedBookings.length > 0 ||
    (requestedRelatedCount === 0 &&
      isCurrentStandaloneCalendarConflict(
        conflictAlertState(booking),
        now,
      ))
  );
}

async function cancelDeliveryRecord(
  ctx: MutationCtx,
  delivery: EmailDelivery,
  reason: string,
  now: number,
  gmailMessageId?: string,
) {
  const cleanReason = cleanSingleLine(reason);
  await ctx.db.patch(delivery._id, {
    status: "cancelled",
    gmailMessageId:
      gmailMessageId?.slice(0, 300) ?? delivery.gmailMessageId,
    lastError: cleanReason,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    updatedAt: now,
  });
  await writeAuditLog(ctx, {
    level: "warning",
    category: "system",
    action: `${delivery.kind}_cancelled`,
    actorType: "system",
    entityType: "booking",
    entityId: String(delivery.bookingId),
    message: "An obsolete email delivery was cancelled.",
    detailsJson: JSON.stringify({
      deliveryId: String(delivery._id),
      reason: cleanReason,
      gmailMessageId,
    }),
    createdAt: now,
  });
}

class GmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`${code}:${message}`);
    this.name = "GmailDeliveryError";
  }
}

class CancelDeliveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CancelDeliveryError";
  }
}

function cleanSingleLine(
  value: string | undefined,
  fallback = "",
  maxLength = 1_000,
): string {
  return cleanEmailLine(value, fallback, maxLength);
}

function normalizeEmail(value: string, code: string): string {
  try {
    return normalizeEmailAddress(value);
  } catch {
    throw new GmailDeliveryError(
      code,
      "The email address is invalid.",
      false,
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new GmailDeliveryError(
      "GMAIL_NOT_CONFIGURED",
      `${name} is not configured in this Convex deployment.`,
      false,
    );
  }
  return value;
}

function gmailConfiguration(): GmailConfiguration {
  const rawBaseUrl = requiredEnvironment("APP_BASE_URL").replace(
    /\/+$/,
    "",
  );
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new GmailDeliveryError(
      "APP_BASE_URL_INVALID",
      "APP_BASE_URL must be an absolute http or https URL.",
      false,
    );
  }
  if (
    parsedBaseUrl.protocol !== "https:" &&
    parsedBaseUrl.protocol !== "http:"
  ) {
    throw new GmailDeliveryError(
      "APP_BASE_URL_INVALID",
      "APP_BASE_URL must use http or https.",
      false,
    );
  }
  if (
    parsedBaseUrl.pathname !== "/" ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new GmailDeliveryError(
      "APP_BASE_URL_INVALID",
      "APP_BASE_URL must contain only the application origin.",
      false,
    );
  }

  return {
    appBaseUrl: parsedBaseUrl.origin,
    clientId: requiredEnvironment("GMAIL_CLIENT_ID"),
    clientSecret: requiredEnvironment("GMAIL_CLIENT_SECRET"),
    refreshToken: requiredEnvironment("GMAIL_REFRESH_TOKEN"),
    fromEmail: normalizeEmail(
      requiredEnvironment("GMAIL_FROM_EMAIL"),
      "GMAIL_FROM_EMAIL_INVALID",
    ),
  };
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
    };
    if (typeof payload.error_description === "string") {
      return cleanSingleLine(payload.error_description, "Unknown error");
    }
    if (typeof payload.error === "string") {
      return cleanSingleLine(payload.error, "Unknown error");
    }
    if (
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
    ) {
      return cleanSingleLine(payload.error.message, "Unknown error");
    }
  } catch {
    // Fall through to the HTTP status. Gmail sometimes returns an HTML
    // proxy response, which must not be copied verbatim into audit logs.
  }
  return `HTTP ${response.status}`;
}

async function gmailAccessToken(
  configuration: GmailConfiguration,
  forceRefresh = false,
): Promise<GmailAccess> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedAccess &&
    cachedAccess.expiresAt > now + 60_000
  ) {
    return cachedAccess;
  }

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        grant_type: "refresh_token",
        refresh_token: configuration.refreshToken,
      }),
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GmailDeliveryError(
      "GMAIL_TOKEN_REQUEST_FAILED",
      cleanSingleLine(
        error instanceof Error ? error.message : "Network request failed.",
      ),
      true,
    );
  }

  if (!response.ok) {
    throw new GmailDeliveryError(
      "GMAIL_TOKEN_FAILED",
      await responseMessage(response),
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof payload.access_token !== "string") {
    throw new GmailDeliveryError(
      "GMAIL_TOKEN_FAILED",
      "Google returned no access token.",
      false,
    );
  }
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in)
      ? Math.max(60, payload.expires_in)
      : 3_600;
  cachedAccess = {
    token: payload.access_token,
    expiresAt: now + expiresIn * 1_000,
    scope:
      typeof payload.scope === "string" ? payload.scope : undefined,
  };
  return cachedAccess;
}

async function sendGmail(input: {
  html: string;
  messageKey: string;
  subject: string;
  text: string;
  to: string;
}): Promise<{ id?: string }> {
  const configuration = gmailConfiguration();
  const recipient = normalizeEmail(input.to, "GMAIL_RECIPIENT_INVALID");
  const access = await gmailAccessToken(configuration);

  let response: Response;
  try {
    response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        body: JSON.stringify({
          raw: encodeGmailMime({
            ...input,
            boundary: `roomops_${crypto
              .randomUUID()
              .replaceAll("-", "")}`,
            from: configuration.fromEmail,
            to: recipient,
          }),
        }),
        headers: {
          Authorization: `Bearer ${access.token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new GmailDeliveryError(
      "GMAIL_SEND_REQUEST_FAILED",
      cleanSingleLine(
        error instanceof Error ? error.message : "Network request failed.",
      ),
      true,
    );
  }

  if (!response.ok) {
    if (response.status === 401) cachedAccess = undefined;
    throw new GmailDeliveryError(
      "GMAIL_SEND_FAILED",
      await responseMessage(response),
      isRetryableGmailStatus(response.status),
      response.status,
    );
  }
  const payload = (await response.json()) as { id?: unknown };
  return {
    id: typeof payload.id === "string" ? payload.id : undefined,
  };
}

function bookingTitle(booking: Booking): string {
  return cleanSingleLine(
    booking.eventName || booking.purpose,
    "Room booking request",
  );
}

function recurrenceLabel(booking: Booking): string | undefined {
  const frequency = booking.recurrenceFrequency ?? "none";
  if (frequency === "none") return undefined;
  const labels: Record<string, string> = {
    daily: "Daily",
    weekly_same_day: "Every week",
    biweekly_same_day: "Every 2 weeks",
    monthly_same_day: "Every month on the same day",
    monthly_same_date: "Every month on the same date",
  };
  return `${labels[frequency] ?? frequency} · ${
    booking.recurrenceCount ?? booking.occurrences?.length ?? 1
  } occurrences`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type EmailDetailRow = {
  href?: string;
  kind?: "chip" | "link" | "text";
  label: string;
  value: string;
};

type EmailTemplateInput = {
  actionHref?: string;
  actionLabel?: string;
  detailRows: EmailDetailRow[];
  introLines: string[];
  subtitle?: string;
  title: string;
  topNote?: string;
  extraHtml?: string;
  footerNote?: string;
};

const LWMC_LOGO_URL =
  "https://www.jotform.com/uploads/lwmcsg/form_files/2023%20LWMC%20large%20transparent%20back%20%281%29.68e7eaaf2f2660.53410791.png";
const APPROVED_BOOKING_ACCESS_NOTICE =
  "The door unlocks 15 minutes before your booking begins.";
const APPROVED_BOOKING_SHUTDOWN_NOTICE =
  "The door will lock again, and the lights and air-conditioning will be switched off 10 minutes after your booking ends.";

function responseLabel(value: string): string {
  return cleanSingleLine(value, "", 200).toLowerCase();
}

function extractPhoneNumber(booking: Booking): string | undefined {
  const response = booking.formResponses?.find((item) => {
    const haystack = [item.label, item.name, item.type, item.value]
      .filter(Boolean)
      .map((part) => responseLabel(String(part)))
      .join(" ");
    return haystack.includes("phone");
  });
  const value = cleanSingleLine(response?.value, "", 80);
  return value || undefined;
}

function bookingRepeatLabel(booking: Booking): string {
  return recurrenceLabel(booking) ?? "One time";
}

function bookingDetailRows(booking: Booking): EmailDetailRow[] {
  const rows: EmailDetailRow[] = [
    {
      label: "Request ID",
      value: cleanSingleLine(booking.jotformSubmissionId),
    },
    {
      label: "Name",
      value: cleanSingleLine(booking.requesterName),
    },
    {
      label: "Email",
      value: cleanSingleLine(booking.requesterEmail),
      kind: "link",
      href: `mailto:${cleanSingleLine(booking.requesterEmail)}`,
    },
  ];

  const phoneNumber = extractPhoneNumber(booking);
  if (phoneNumber) {
    rows.push({ label: "Phone Number", value: phoneNumber });
  }

  if (booking.ministry) {
    rows.push({
      label: "Ministry",
      value: cleanSingleLine(booking.ministry),
      kind: "chip",
    });
  }

  rows.push(
    {
      label: "Event Name or Purpose of Booking",
      value: bookingTitle(booking),
    },
    {
      label: "Venue",
      value: cleanSingleLine(booking.room),
      kind: "chip",
    },
    {
      label: "Start Date and Time",
      value: formatLocalDateTime(booking.startAt, booking.timezone),
    },
    {
      label: "End Date and Time",
      value: formatLocalDateTime(booking.endAt, booking.timezone),
    },
    {
      label: "Repeat Option",
      value: bookingRepeatLabel(booking),
      kind: "chip",
    },
  );

  const occurrences =
    booking.occurrences && booking.occurrences.length > 0
      ? booking.occurrences
      : [
          {
            sequence: 0,
            startAt: booking.startAt,
            endAt: booking.endAt,
          },
        ];
  const recurrence = recurrenceLabel(booking);
  const lastOccurrence = occurrences.at(-1);
  if (recurrence && lastOccurrence) {
    if (booking.recurrenceUntilAt !== undefined) {
      rows.push({
        label: "Requested last date",
        value: formatLocalDate(
          booking.recurrenceUntilAt,
          booking.timezone,
        ),
      });
    }
    rows.push({
      label: "Final occurrence",
      value: `${formatLocalDateTime(
        lastOccurrence.startAt,
        booking.timezone,
      )} to ${formatLocalDateTime(lastOccurrence.endAt, booking.timezone)}`,
    });
  }

  return rows;
}

function bookingLines(booking: Booking): string[] {
  return bookingDetailRows(booking)
    .map((row) => `${row.label}: ${row.value}`)
    .filter(Boolean);
}

function renderDetailValue(row: EmailDetailRow): string {
  const safeValue = escapeHtml(row.value);
  if (row.kind === "chip") {
    return `<span style="display:inline-block;background:#d7eefb;color:#183a6d;padding:8px 14px;border-radius:6px;font-weight:700;line-height:1.2">${safeValue}</span>`;
  }
  if (row.kind === "link" && row.href) {
    return `<a href="${escapeHtml(row.href)}" style="color:#1f5fbf;text-decoration:underline;font-weight:700">${safeValue}</a>`;
  }
  return `<span style="color:#1f2f6f;font-weight:700">${safeValue}</span>`;
}

function renderIntroParagraphs(lines: string[]): string {
  return lines
    .filter(Boolean)
    .map(
      (line) =>
        `<p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#333">${escapeHtml(line)}</p>`,
    )
    .join("");
}

function renderDetailRows(rows: EmailDetailRow[]): string {
  return rows
    .map(
      (row) => `
        <tr>
          <td style="padding:12px 0 12px 0;width:210px;vertical-align:top;font-size:14px;line-height:1.5;color:#6b78bb;font-weight:400">${escapeHtml(
            row.label,
          )}</td>
          <td style="padding:12px 0 12px 12px;vertical-align:top;font-size:14px;line-height:1.5">${renderDetailValue(
            row,
          )}</td>
        </tr>`,
    )
    .join("");
}

function actionButtonLink(label: string, href: string): string {
  return `<a href="${escapeHtml(
    href,
  )}" style="display:inline-block;background:#2f6fdd;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;padding:12px 18px;border-radius:8px">${escapeHtml(
    label,
  )}</a>`;
}

function renderActionButton(label: string, href: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 0 0"><tr><td>${actionButtonLink(label, href)}</td></tr></table>`;
}

// Buttons share one table row so they sit side by side in email clients.
function renderActionButtonRow(
  buttons: ReadonlyArray<{ label: string; href: string }>,
): string {
  const cells = buttons
    .map(
      (button, index) =>
        `<td style="padding:0 ${index < buttons.length - 1 ? 12 : 0}px 0 0">${actionButtonLink(button.label, button.href)}</td>`,
    )
    .join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 0 0"><tr>${cells}</tr></table>`;
}

function renderApprovedBookingAccessNotice(): string {
  return `<div style="margin:20px 0 0 0;padding:16px;background:#fff7f6;border-left:4px solid #d92d20;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7">
    <p style="margin:0 0 8px 0;color:#333">${escapeHtml(APPROVED_BOOKING_ACCESS_NOTICE)}</p>
    <p style="margin:0;color:#b42318;font-weight:700">${escapeHtml(APPROVED_BOOKING_SHUTDOWN_NOTICE)}</p>
  </div>`;
}

function renderEmailTemplate(input: EmailTemplateInput): string {
  const rowsHtml = renderDetailRows(input.detailRows);
  const actionHtml =
    input.actionHref && input.actionLabel
      ? renderActionButton(input.actionLabel, input.actionHref)
      : "";
  const footerHtml = input.footerNote
    ? `<p style="margin:20px 0 0 0;font-size:13px;line-height:1.6;color:#6a6f8c">${escapeHtml(
        input.footerNote,
      )}</p>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f1ff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f1ff;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:16px 12px 28px;">
          <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:620px;max-width:620px;background:#ffffff;border-collapse:collapse;">
            <tr>
              <td align="center" style="padding:16px 28px 8px;">
                <img src="${escapeHtml(LWMC_LOGO_URL)}" alt="Living Waters Methodist Church" style="display:block;width:360px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;">
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 12px;">
                <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;line-height:1.25;color:#1d2e67;font-weight:700;text-align:left;">${escapeHtml(
                  input.title,
                )}</h1>
                ${input.subtitle ? `<p style="margin:8px 0 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#4d5686;font-weight:700">${escapeHtml(input.subtitle)}</p>` : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 6px;">
                ${renderIntroParagraphs(input.introLines)}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 0;">
                <div style="border-top:1px solid #eef0f4;font-size:0;line-height:0;height:1px">&nbsp;</div>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 40px 40px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  ${rowsHtml}
                </table>
                ${actionHtml}
                ${input.extraHtml ?? ""}
                ${footerHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function htmlFromText(text: string): string {
  return renderEmailTemplate({
    detailRows: [{ label: "Message", value: text }],
    introLines: [],
    title: "RoomOps notification",
  });
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof GmailDeliveryError) {
    return {
      code: error.code,
      message: cleanSingleLine(error.message, "Email delivery failed."),
      retryable: error.retryable,
    };
  }
  return {
    code: "EMAIL_DELIVERY_FAILED",
    message: cleanSingleLine(
      error instanceof Error ? error.message : "Email delivery failed.",
    ),
    retryable: true,
  };
}

async function logEmail(
  ctx: ActionCtx,
  input: {
    action: string;
    actorId?: string;
    actorType?: "user" | "system";
    bookingId?: Id<"bookings">;
    details?: Record<string, unknown>;
    level: "info" | "warning" | "error";
    message: string;
  },
) {
  await ctx.runMutation(internal.logs.write, {
    level: input.level,
    category: "system",
    action: input.action,
    actorType: input.actorType ?? "system",
    actorId: input.actorId,
    entityType: input.bookingId ? "booking" : "gmail",
    entityId: input.bookingId ? String(input.bookingId) : undefined,
    message: input.message,
    detailsJson: JSON.stringify(input.details ?? {}),
  });
}

function deliveryDedupeKey(
  bookingId: Id<"bookings">,
  kind: EmailDeliveryKind,
  recipientEmail: string,
  relatedBookingIds: readonly Id<"bookings">[] = [],
  discriminator?: string,
): string {
  const related = [...new Set(relatedBookingIds.map(String))]
    .sort()
    .join(",");
  const parts = [
    String(bookingId),
    kind,
    recipientEmail.toLowerCase(),
    related,
  ];
  if (discriminator) parts.push(discriminator);
  return parts.join(":");
}

async function enqueueDelivery(
  ctx: MutationCtx,
  input: {
    bookingId: Id<"bookings">;
    decisionTokenId?: Id<"emailDecisionTokens">;
    delayMs?: number;
    kind: EmailDeliveryKind;
    recipientEmail: string;
    relatedBookingIds?: Id<"bookings">[];
    dedupeDiscriminator?: string;
  },
): Promise<Id<"emailDeliveries">> {
  const dependsOnDeliveryId = requiresRequesterReceipt(input.kind)
    ? await ensureRequesterReceiptDelivery(ctx, input.bookingId)
    : undefined;
  let recipientEmail: string;
  let recipientError: GmailDeliveryError | undefined;
  try {
    recipientEmail = normalizeEmail(
      input.recipientEmail,
      "GMAIL_RECIPIENT_INVALID",
    );
  } catch (error) {
    recipientError =
      error instanceof GmailDeliveryError
        ? error
        : new GmailDeliveryError(
            "GMAIL_RECIPIENT_INVALID",
            "The email address is invalid.",
            false,
          );
    recipientEmail = cleanSingleLine(
      input.recipientEmail,
      "invalid-recipient",
      254,
    ).toLowerCase();
  }
  const relatedBookingIds = [
    ...new Set((input.relatedBookingIds ?? []).map(String)),
  ].map((bookingId) => bookingId as Id<"bookings">);
  const dedupeKey = deliveryDedupeKey(
    input.bookingId,
    input.kind,
    recipientEmail,
    relatedBookingIds,
    input.dedupeDiscriminator,
  );
  let existing = await ctx.db
    .query("emailDeliveries")
    .withIndex("by_dedupe_key", (range) =>
      range.eq("dedupeKey", dedupeKey),
    )
    .unique();
  if (
    !existing &&
    input.kind === "approver_conflict_urgent" &&
    input.dedupeDiscriminator
  ) {
    const legacyDedupeKey = deliveryDedupeKey(
      input.bookingId,
      input.kind,
      recipientEmail,
      relatedBookingIds,
    );
    const legacyDelivery = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_dedupe_key", (range) =>
        range.eq("dedupeKey", legacyDedupeKey),
      )
      .unique();
    if (
      legacyDelivery &&
      (legacyDelivery.status === "pending" ||
        legacyDelivery.status === "sending" ||
        legacyDelivery.status === "blocked")
    ) {
      await ctx.db.patch(legacyDelivery._id, { dedupeKey });
      existing = { ...legacyDelivery, dedupeKey };
    }
  }
  if (existing) {
    const urgentConflictRecovery =
      input.kind === "approver_conflict_urgent"
        ? urgentConflictDeliveryRecoveryMode(
            existing.status,
            existing.dependsOnDeliveryId !== undefined,
          )
        : "none";
    if (urgentConflictRecovery !== "none") {
      const now = Date.now();
      const requeue = urgentConflictRecovery === "requeue";
      await ctx.db.patch(existing._id, {
        dependsOnDeliveryId: undefined,
        status: requeue ? "pending" : existing.status,
        nextAttemptAt: requeue ? now : existing.nextAttemptAt,
        lastError: requeue ? undefined : existing.lastError,
        leaseToken: requeue ? undefined : existing.leaseToken,
        leaseExpiresAt: requeue
          ? undefined
          : existing.leaseExpiresAt,
        updatedAt: now,
      });
      if (requeue) {
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.dispatchDelivery,
          { deliveryId: existing._id },
        );
      }
      return existing._id;
    }
    if (
      dependsOnDeliveryId &&
      existing.dependsOnDeliveryId !== dependsOnDeliveryId &&
      existing.status !== "sent" &&
      existing.status !== "cancelled"
    ) {
      const resumeBlocked = existing.status === "blocked";
      const now = Date.now();
      await ctx.db.patch(existing._id, {
        dependsOnDeliveryId,
        status: resumeBlocked ? "pending" : existing.status,
        nextAttemptAt: resumeBlocked ? now : existing.nextAttemptAt,
        lastError: resumeBlocked ? undefined : existing.lastError,
        updatedAt: now,
      });
      if (resumeBlocked) {
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.dispatchDelivery,
          { deliveryId: existing._id },
        );
      }
    }
    return existing._id;
  }

  const now = Date.now();
  const delayMs = Math.min(
    Math.max(Math.floor(input.delayMs ?? 0), 0),
    60_000,
  );
  const deliveryId = await ctx.db.insert("emailDeliveries", {
    bookingId: input.bookingId,
    relatedBookingIds:
      relatedBookingIds.length > 0 ? relatedBookingIds : undefined,
    decisionTokenId: input.decisionTokenId,
    dependsOnDeliveryId,
    kind: input.kind,
    recipientEmail,
    dedupeKey,
    status: recipientError ? "failed" : "pending",
    attempts: 0,
    nextAttemptAt: recipientError ? undefined : now + delayMs,
    lastError: recipientError?.message.slice(0, 1_000),
    createdAt: now,
    updatedAt: now,
  });
  if (recipientError) {
    await writeAuditLog(ctx, {
      level: "error",
      category: "system",
      action: `${input.kind}_failed`,
      actorType: "system",
      entityType: "booking",
      entityId: String(input.bookingId),
      message:
        "Email delivery could not be queued because the recipient address is invalid.",
      detailsJson: JSON.stringify({
        deliveryId: String(deliveryId),
        errorCode: recipientError.code,
      }),
      createdAt: now,
    });
    return deliveryId;
  }
  await ctx.scheduler.runAfter(
    delayMs,
    internal.emailNotifications.dispatchDelivery,
    { deliveryId },
  );
  return deliveryId;
}

async function ensureRequesterReceiptDelivery(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
): Promise<Id<"emailDeliveries"> | undefined> {
  const booking = await ctx.db.get(bookingId);
  if (!booking) return undefined;
  return await enqueueDelivery(ctx, {
    bookingId,
    kind: "requester_submission_received",
    delayMs: initialBookingEmailDelay(
      "requester_submission_received",
    ),
    recipientEmail: booking.requesterEmail,
  });
}

async function revokeBookingTokens(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  reason: string,
  exceptTokenId?: Id<"emailDecisionTokens">,
) {
  const tokens = await ctx.db
    .query("emailDecisionTokens")
    .withIndex("by_booking", (range) => range.eq("bookingId", bookingId))
    .collect();
  const now = Date.now();
  for (const token of tokens) {
    if (
      token._id === exceptTokenId ||
      !canRevokeTokenForTerminalNotification(token, now)
    ) {
      continue;
    }
    await ctx.db.patch(token._id, {
      revokedAt: now,
      revokedReason: reason.slice(0, 160),
      claimToken: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
    });
  }
}

async function enqueueAvailabilityFollowups(
  ctx: MutationCtx,
  booking: Booking,
): Promise<number> {
  const followupKind = availabilityFollowupKind(booking);
  if (followupKind === "requester_unavailable") {
    await enqueueDelivery(ctx, {
      bookingId: booking._id,
      delayMs: initialBookingEmailDelay("requester_unavailable"),
      kind: "requester_unavailable",
      recipientEmail: booking.requesterEmail,
    });
    return 1;
  }
  if (followupKind !== "approver_request") return 0;

  const approvers = await ctx.db
    .query("approverEmails")
    .withIndex("by_active", (range) => range.eq("active", true))
    .collect();
  if (approvers.length === 0) {
    await writeAuditLog(ctx, {
      level: "error",
      category: "system",
      action: "approver_recipients_missing",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "The pending booking has no active approval-email recipients.",
      detailsJson: JSON.stringify({
        submissionId: booking.jotformSubmissionId,
      }),
      createdAt: Date.now(),
    });
    return 0;
  }

  let queued = 0;
  for (const approver of approvers) {
    const recipientEmail = normalizeEmail(
      approver.email,
      "APPROVER_EMAIL_INVALID",
    );
    const dedupeKey = deliveryDedupeKey(
      booking._id,
      "approver_request",
      recipientEmail,
    );
    const existing = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_dedupe_key", (range) =>
        range.eq("dedupeKey", dedupeKey),
      )
      .unique();
    if (existing) continue;

    const now = Date.now();
    const decisionTokenId = await ctx.db.insert(
      "emailDecisionTokens",
      {
        bookingId: booking._id,
        approverEmail: recipientEmail,
        token: crypto.randomUUID(),
        expiresAt: now + DECISION_LINK_LIFETIME_MS,
        createdAt: now,
      },
    );
    await enqueueDelivery(ctx, {
      bookingId: booking._id,
      decisionTokenId,
      delayMs: initialBookingEmailDelay("approver_request"),
      kind: "approver_request",
      recipientEmail,
    });
    queued += 1;
  }
  return queued;
}

export const prepareBookingReceipt = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      bookingDeletionInProgress(booking, Date.now())
    ) {
      return { queued: 0 };
    }
    await ensureRequesterReceiptDelivery(ctx, booking._id);
    return { queued: 1 };
  },
});

export const prepareBookingAvailabilityCompleted = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.availabilityCheckPending === true ||
      bookingDeletionInProgress(booking, Date.now())
    ) {
      return { queued: 0 };
    }
    return {
      queued: await enqueueAvailabilityFollowups(ctx, booking),
    };
  },
});

// Compatibility entry point for a worker that began before staged intake was
// deployed. New intake calls the receipt and availability mutations
// separately, which guarantees no approver or terminal follow-up is created
// while the availability check remains unfinished.
export const prepareBookingCreated = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      bookingDeletionInProgress(booking, Date.now())
    ) {
      return { queued: 0 };
    }
    await ensureRequesterReceiptDelivery(ctx, booking._id);
    if (booking.availabilityCheckPending === true) {
      return { queued: 1 };
    }
    return {
      queued: 1 + (await enqueueAvailabilityFollowups(ctx, booking)),
    };
  },
});

export const prepareBookingDecision = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.availabilityCheckPending === true ||
      bookingDeletionInProgress(booking, Date.now()) ||
      (booking.status !== "approved" &&
        booking.status !== "rejected" &&
        booking.status !== "unavailable")
    ) {
      return { queued: 0 };
    }
    await revokeBookingTokens(
      ctx,
      booking._id,
      `booking_${booking.status}`,
    );
    const kind: EmailDeliveryKind =
      booking.status === "approved"
        ? "requester_approved"
        : booking.status === "rejected"
          ? "requester_rejected"
          : "requester_unavailable";
    await enqueueDelivery(ctx, {
      bookingId: booking._id,
      kind,
      recipientEmail: booking.requesterEmail,
    });
    return { queued: 1 };
  },
});

export const prepareConflictAlert = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    relatedBookingIds: v.array(v.id("bookings")),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    const now = Date.now();
    if (
      !booking ||
      booking.availabilityCheckPending === true ||
      bookingDeletionInProgress(booking, now)
    ) {
      return { queued: 0 };
    }
    const requestedRelatedBookingIds = [
      ...new Set(
        args.relatedBookingIds
          .filter((bookingId) => bookingId !== booking._id)
          .map(String),
      ),
    ]
      .slice(0, 20)
      .map((bookingId) => bookingId as Id<"bookings">);
    const relatedBookings = await currentConflictRelatedBookings(
      ctx,
      booking,
      requestedRelatedBookingIds,
      now,
    );
    if (
      !hasCurrentConflictAlertCause(
        booking,
        relatedBookings,
        requestedRelatedBookingIds.length,
        now,
      )
    ) {
      return { queued: 0 };
    }
    const relatedBookingIds = relatedBookings.map(
      (related) => related._id,
    );
    const dedupeDiscriminator = conflictAlertEpisodeKey(
      conflictAlertState(booking),
      relatedBookingIds.map(String),
    );
    const conflictAdmins = await ctx.db
      .query("conflictAdmins")
      .withIndex("by_active", (range) => range.eq("active", true))
      .collect();
    if (conflictAdmins.length === 0) {
      await writeAuditLog(ctx, {
        level: "error",
        category: "system",
        action: "conflict_alert_recipients_missing",
        actorType: "system",
        entityType: "booking",
        entityId: String(booking._id),
        message:
          "An urgent booking conflict was detected, but no conflict administrator is active.",
        detailsJson: JSON.stringify({
          relatedBookingIds: relatedBookingIds.map(String),
        }),
        createdAt: now,
      });
      return { queued: 0 };
    }
    for (const conflictAdmin of conflictAdmins) {
      await enqueueDelivery(ctx, {
        bookingId: booking._id,
        relatedBookingIds,
        dedupeDiscriminator,
        kind: "approver_conflict_urgent",
        recipientEmail: conflictAdmin.email,
      });
    }
    return { queued: conflictAdmins.length };
  },
});

export const notifyBookingCreated = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<{ queued: number }> =>
    (await ctx.runMutation(
      internal.emailNotifications.prepareBookingCreated,
      args,
    )) as { queued: number },
});

export const notifyBookingReceipt = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<{ queued: number }> =>
    (await ctx.runMutation(
      internal.emailNotifications.prepareBookingReceipt,
      args,
    )) as { queued: number },
});

export const notifyBookingAvailabilityCompleted = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<{ queued: number }> =>
    (await ctx.runMutation(
      internal.emailNotifications.prepareBookingAvailabilityCompleted,
      args,
    )) as { queued: number },
});

export const notifyBookingDecision = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<{ queued: number }> =>
    (await ctx.runMutation(
      internal.emailNotifications.prepareBookingDecision,
      args,
    )) as { queued: number },
});

export const notifyConflictAlert = internalAction({
  args: {
    bookingId: v.id("bookings"),
    relatedBookingIds: v.array(v.id("bookings")),
  },
  handler: async (ctx, args): Promise<{ queued: number }> =>
    (await ctx.runMutation(
      internal.emailNotifications.prepareConflictAlert,
      args,
    )) as { queued: number },
});

export const dispatchDelivery = internalMutation({
  args: { deliveryId: v.id("emailDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.status === "sent" ||
      delivery.status === "cancelled" ||
      delivery.status === "failed" ||
      delivery.status === "blocked"
    ) {
      return;
    }
    const now = Date.now();
    const booking = await ctx.db.get(delivery.bookingId);
    if (!booking || booking.requesterOperationId || bookingDeletionInProgress(booking, now)) {
      await cancelDeliveryRecord(
        ctx,
        delivery,
        booking
          ? "BOOKING_DELETION_IN_PROGRESS:No email may start while the booking is being deleted."
          : "BOOKING_MISSING:The booking no longer exists.",
        now,
      );
      return;
    }
    if (delivery.kind === "approver_conflict_urgent") {
      const requestedRelatedIds = delivery.relatedBookingIds ?? [];
      const relatedBookings = await currentConflictRelatedBookings(
        ctx,
        booking,
        requestedRelatedIds,
        now,
      );
      if (
        !hasCurrentConflictAlertCause(
          booking,
          relatedBookings,
          requestedRelatedIds.length,
          now,
        )
      ) {
        await cancelDeliveryRecord(
          ctx,
          delivery,
          "CONFLICT_ALERT_OBSOLETE:The related bookings are no longer in a current conflict.",
          now,
        );
        return;
      }
    }
    if (requiresRequesterReceipt(delivery.kind)) {
      let dependencyId = delivery.dependsOnDeliveryId;
      let dependency = dependencyId
        ? await ctx.db.get(dependencyId)
        : null;
      if (
        !dependency ||
        dependency.bookingId !== delivery.bookingId ||
        dependency.kind !== "requester_submission_received"
      ) {
        dependencyId = await ensureRequesterReceiptDelivery(
          ctx,
          delivery.bookingId,
        );
        dependency = dependencyId
          ? await ctx.db.get(dependencyId)
          : null;
        if (
          dependencyId &&
          dependencyId !== delivery.dependsOnDeliveryId
        ) {
          await ctx.db.patch(delivery._id, {
            dependsOnDeliveryId: dependencyId,
            updatedAt: now,
          });
        }
      }
      const gate = bookingEmailDependencyGate(
        delivery.kind,
        String(delivery.bookingId),
        dependency
          ? {
              bookingId: String(dependency.bookingId),
              kind: dependency.kind,
              status: dependency.status,
            }
          : null,
      );
      if (gate === "block") {
        await ctx.db.patch(delivery._id, {
          status: "blocked",
          nextAttemptAt: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          lastError:
            "EMAIL_DEPENDENCY_NOT_DELIVERED:The requester receipt must be delivered before this follow-up.",
          updatedAt: now,
        });
        await writeAuditLog(ctx, {
          level: "error",
          category: "system",
          action: `${delivery.kind}_blocked`,
          actorType: "system",
          entityType: "booking",
          entityId: String(delivery.bookingId),
          message:
            "A follow-up email was blocked because the requester receipt was not delivered.",
          detailsJson: JSON.stringify({
            deliveryId: String(delivery._id),
            dependsOnDeliveryId: dependencyId
              ? String(dependencyId)
              : undefined,
            dependencyStatus: dependency?.status ?? "missing",
          }),
          createdAt: now,
        });
        return;
      }
      if (gate === "wait") {
        const dependencyReadyCheckAt = Math.min(
          Math.max(
            dependency?.nextAttemptAt ?? now + 5_000,
            now + 1_000,
          ),
          now + 15_000,
        );
        await ctx.db.patch(delivery._id, {
          nextAttemptAt: dependencyReadyCheckAt,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          dependencyReadyCheckAt - now,
          internal.emailNotifications.dispatchDelivery,
          args,
        );
        return;
      }
    }
    if (
      delivery.status === "sending" &&
      (delivery.leaseExpiresAt ?? 0) > now
    ) {
      return;
    }
    if ((delivery.nextAttemptAt ?? 0) > now) {
      await ctx.scheduler.runAfter(
        (delivery.nextAttemptAt ?? now) - now,
        internal.emailNotifications.dispatchDelivery,
        args,
      );
      return;
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(delivery._id, {
      status: "sending",
      attempts: delivery.attempts + 1,
      leaseToken,
      leaseExpiresAt: now + DELIVERY_LEASE_MS,
      nextAttemptAt: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.sendDelivery,
      {
        deliveryId: delivery._id,
        leaseToken,
      },
    );
    await ctx.scheduler.runAfter(
      DELIVERY_LEASE_MS,
      internal.emailNotifications.recoverDeliveryLease,
      {
        deliveryId: delivery._id,
        leaseToken,
      },
    );
  },
});

export const getDeliveryContext = internalQuery({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args): Promise<DeliveryContextLookup> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.status !== "sending" ||
      delivery.leaseToken !== args.leaseToken
    ) {
      return {
        state: "cancel",
        reason: "EMAIL_DELIVERY_LEASE_LOST",
      };
    }
    const now = Date.now();
    const booking = await ctx.db.get(delivery.bookingId);
    if (!booking || booking.requesterOperationId || bookingDeletionInProgress(booking, now)) {
      return {
        state: "cancel",
        reason: booking
          ? "BOOKING_DELETION_IN_PROGRESS:No email may start while the booking is being deleted."
          : "BOOKING_MISSING:The booking no longer exists.",
      };
    }
    if (requiresRequesterReceipt(delivery.kind)) {
      const dependency = delivery.dependsOnDeliveryId
        ? await ctx.db.get(delivery.dependsOnDeliveryId)
        : null;
      if (
        bookingEmailDependencyGate(
          delivery.kind,
          String(delivery.bookingId),
          dependency
            ? {
                bookingId: String(dependency.bookingId),
                kind: dependency.kind,
                status: dependency.status,
              }
            : null,
        ) !== "ready"
      ) {
        return {
          state: "cancel",
          reason:
            "EMAIL_DEPENDENCY_NOT_DELIVERED:The requester receipt is no longer a valid prerequisite.",
        };
      }
    }
    const decisionToken = delivery.decisionTokenId
      ? await ctx.db.get(delivery.decisionTokenId)
      : null;
    let relatedBookings: Booking[] = [];
    if (delivery.kind === "approver_conflict_urgent") {
      const requestedRelatedIds = delivery.relatedBookingIds ?? [];
      relatedBookings = await currentConflictRelatedBookings(
        ctx,
        booking,
        requestedRelatedIds,
        now,
      );
      if (
        !hasCurrentConflictAlertCause(
          booking,
          relatedBookings,
          requestedRelatedIds.length,
          now,
        )
      ) {
        return {
          state: "cancel",
          reason:
            "CONFLICT_ALERT_OBSOLETE:The related bookings are no longer in a current conflict.",
        };
      }
    }
    return {
      state: "ready",
      context: {
        delivery,
        booking,
        decisionToken,
        relatedBookings,
      },
    };
  },
});

function composeDelivery(context: DeliveryContext): {
  html: string;
  subject: string;
  text: string;
} {
  const { booking, decisionToken, delivery, relatedBookings } = context;
  const detailRows = bookingDetailRows(booking);
  const details = bookingLines(booking).join("\n");
  const noteText = booking.reviewNote
    ? `\n\nApprover comment:\n${cleanSingleLine(booking.reviewNote)}`
    : "";

  switch (delivery.kind) {
    case "requester_submission_received": {
      const text = `Your room booking submission was received.\n\n${details}`;
      return {
        subject: `Room booking received: ${booking.room}`,
        text,
        html: renderEmailTemplate({
          detailRows,
          introLines: [
            `Hi, ${booking.requesterName}`,
            "We have received your booking request. Now pending Church Office approval.",
            "You can see the booking request below:",
          ],
          title: "Welcome to LWMC Facilities Booking Request Form",
        }),
      };
    }
    case "requester_unavailable": {
      const reason =
        cleanSingleLine(booking.calendarConflictSummary) ||
        "The venue is already booked for another event.";
      const text = `Your room booking request was automatically rejected because the venue is unavailable.\n\nReason: ${reason}${noteText}\n\n${details}`;
      return {
        subject: `Room booking unavailable: ${booking.room}`,
        text,
        html: renderEmailTemplate({
          detailRows,
          introLines: [
            `Hi, ${booking.requesterName}`,
            "We have reviewed your booking request. The venue is unavailable for the selected time.",
            `Reason: ${reason}`,
            ...(booking.reviewNote
              ? [`Approver comment: ${cleanSingleLine(booking.reviewNote)}`]
              : []),
          ],
          title: "LWMC Facilities Booking Request Update",
        }),
      };
    }
    case "requester_approved": {
      const text = `Your room booking request was approved.${noteText}

${APPROVED_BOOKING_ACCESS_NOTICE}
IMPORTANT: ${APPROVED_BOOKING_SHUTDOWN_NOTICE}

${details}`;
      return {
        subject: `Room booking approved: ${booking.room}`,
        text,
        html: renderEmailTemplate({
          detailRows,
          extraHtml: renderApprovedBookingAccessNotice() + "<!--booking-management-->",
          introLines: [
            `Hi, ${booking.requesterName}`,
            "Your booking request has been approved.",
            ...(booking.reviewNote
              ? [`Approver comment: ${cleanSingleLine(booking.reviewNote)}`]
              : []),
          ],
          title: "LWMC Facilities Booking Request Update",
        }),
      };
    }
    case "requester_rejected": {
      const text = `Your room booking request was rejected.${noteText}\n\n${details}`;
      return {
        subject: `Room booking rejected: ${booking.room}`,
        text,
        html: renderEmailTemplate({
          detailRows,
          introLines: [
            `Hi, ${booking.requesterName}`,
            "Your booking request was rejected.",
            ...(booking.reviewNote
              ? [`Approver comment: ${cleanSingleLine(booking.reviewNote)}`]
              : []),
          ],
          title: "LWMC Facilities Booking Request Update",
        }),
      };
    }
    case "approver_request": {
      if (
        !decisionToken ||
        decisionToken.bookingId !== booking._id ||
        decisionToken.usedAt !== undefined ||
        decisionToken.revokedAt !== undefined ||
        decisionToken.expiresAt <= Date.now() ||
        booking.status !== "pending"
      ) {
        throw new CancelDeliveryError(
          "The approval link is no longer actionable.",
        );
      }
      const configuration = gmailConfiguration();
      const decisionLink = `${configuration.appBaseUrl}/email-decision/${decisionToken.token}`;
      const warning =
        (booking.conflictWarningBookingIds?.length ?? 0) > 0
          ? "\n\nWARNING: Another pending request overlaps this venue and time. Review the conflict before deciding."
          : "";
      const text = `A room booking request needs review.${warning}\n\n${details}\n\nApprove or reject without signing in:\n${decisionLink}`;
      return {
        subject: `${
          warning ? "[Conflict warning] " : ""
        }Room booking approval needed: ${booking.room}`,
        text,
        html: renderEmailTemplate({
          detailRows,
          extraHtml: warning
            ? `<p style="margin:16px 0 0 0;padding:14px 16px;background:#fff4db;border-left:4px solid #e3b341;font-size:14px;line-height:1.6;color:#6b4f00;font-weight:700">WARNING: Another pending request overlaps this venue and time. Review the conflict before deciding.</p>`
            : "",
          introLines: [
            "Hi, Church Office",
            "A room booking request needs review.",
            ...(warning ? ["There is a conflict warning for this booking."] : []),
          ],
          title: "LWMC Facilities Booking Request Needs Review",
          actionHref: decisionLink,
          actionLabel: "Review booking request",
        }),
      };
    }
    case "approver_conflict_urgent": {
      const configuration = gmailConfiguration();
      const bookingLink = `${configuration.appBaseUrl}/bookings`;
      const related = relatedBookings
        .map(
          (item) =>
            `- ${item.room}: ${bookingTitle(item)} (${formatLocalDateTime(
              item.startAt,
              item.timezone,
            )})`,
        )
        .join("\n");
      const text = `URGENT: RoomOps detected booking requests that conflict and require administrator review.\n\nPrimary request:\n${details}${
        related ? `\n\nRelated requests:\n${related}` : ""
      }\n\nOpen RoomOps:\n${bookingLink}`;
      return {
        subject: `[Urgent conflict] ${booking.room} booking requires review`,
        text,
        html: renderEmailTemplate({
          detailRows,
          extraHtml: related
            ? `<div style="margin-top:16px"><p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#4d5686;font-weight:700">Related requests</p><div style="padding:14px 16px;background:#f7f9ff;border:1px solid #e4e9ff;border-radius:8px">${related
                .split("\n")
                .map(
                  (line) => `<p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#24336b">${escapeHtml(
                    line,
                  )}</p>`,
                )
                .join("")}</div></div>`
            : "",
          introLines: [
            "URGENT: RoomOps detected booking requests that conflict and require administrator review.",
          ],
          title: "LWMC Facilities Booking Request Needs Review",
          actionHref: bookingLink,
          actionLabel: "Open RoomOps bookings",
        }),
      };
    }
  }
}

export const sendDelivery = internalAction({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const lookup = (await ctx.runQuery(
      internal.emailNotifications.getDeliveryContext,
      args,
    )) as DeliveryContextLookup;
    if (lookup.state === "cancel") {
      await ctx.runMutation(
        internal.emailNotifications.cancelDelivery,
        {
          deliveryId: args.deliveryId,
          leaseToken: args.leaseToken,
          reason: lookup.reason,
        },
      );
      return;
    }
    const context = lookup.context;
    try {
      let composed = composeDelivery(context);
      if (context.delivery.kind === "requester_approved") {
        const token = await ctx.runMutation(internal.bookingRequests.issueLink, args);
        if (!token) throw new CancelDeliveryError("BOOKING_CHANGED:Approval recipient or status changed.");
        // Fragment tokens are not sent in HTTP requests or Referer headers.
        const link = `${gmailConfiguration().appBaseUrl}/booking-request#token=${token}`;
        const explanation = "Request changes or cancel at least two hours before the selected meeting starts. Changes require approval. Cancellation takes effect after you confirm and Calendar cleanup succeeds. Keep these private links to yourself.";
        const cancelLink = `${link}&action=cancel`;
        const section = `<div style="margin-top:24px;padding-top:20px;border-top:1px solid #eef0f4">${renderActionButtonRow([{ label: "Request Changes", href: link }, { label: "Cancel Booking", href: cancelLink }])}<p style="font-size:13px;line-height:1.6;color:#667085">${explanation}</p></div>`;
        composed = { ...composed, text: `${composed.text}\n\nRequest Changes: ${link}\nCancel Booking: ${cancelLink}\n${explanation}`,
          html: composed.html.replace("<!--booking-management-->", section) };
      }
      const message = context.delivery.kind.startsWith("requester_")
        ? await withSubmitterBookings(ctx,context.delivery.recipientEmail,composed)
        : composed;
      const result = await sendGmail({
        ...message,
        messageKey: String(context.delivery._id),
        to: context.delivery.recipientEmail,
      });
      await ctx.runMutation(
        internal.emailNotifications.completeDelivery,
        {
          deliveryId: context.delivery._id,
          leaseToken: args.leaseToken,
          gmailMessageId: result.id,
        },
      );
    } catch (error) {
      if (error instanceof CancelDeliveryError) {
        await ctx.runMutation(
          internal.emailNotifications.cancelDelivery,
          {
            deliveryId: context.delivery._id,
            leaseToken: args.leaseToken,
            reason: error.reason,
          },
        );
        return;
      }
      const details = errorDetails(error);
      await ctx.runMutation(
        internal.emailNotifications.recordDeliveryFailure,
        {
          deliveryId: context.delivery._id,
          leaseToken: args.leaseToken,
          errorCode: details.code,
          errorMessage: details.message,
          retryable: details.retryable,
        },
      );
    }
  },
});

export const completeDelivery = internalMutation({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
    gmailMessageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.status !== "sending" ||
      delivery.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const now = Date.now();
    const booking = await ctx.db.get(delivery.bookingId);
    if (!booking || booking.requesterOperationId || bookingDeletionInProgress(booking, now)) {
      await cancelDeliveryRecord(
        ctx,
        delivery,
        booking
          ? "BOOKING_DELETION_STARTED_AFTER_GMAIL_ACCEPTED:Gmail may have accepted this message before deletion began."
          : "BOOKING_DELETED_AFTER_GMAIL_ACCEPTED:Gmail may have accepted this message before the booking was removed.",
        now,
        args.gmailMessageId,
      );
      return;
    }
    if (delivery.kind === "approver_conflict_urgent") {
      const requestedRelatedIds = delivery.relatedBookingIds ?? [];
      const relatedBookings = await currentConflictRelatedBookings(
        ctx,
        booking,
        requestedRelatedIds,
        now,
      );
      if (
        !hasCurrentConflictAlertCause(
          booking,
          relatedBookings,
          requestedRelatedIds.length,
          now,
        )
      ) {
        await cancelDeliveryRecord(
          ctx,
          delivery,
          "CONFLICT_OBSOLETE_AFTER_GMAIL_ACCEPTED:Gmail may have accepted this message before the conflict became obsolete.",
          now,
          args.gmailMessageId,
        );
        return;
      }
    }
    await ctx.db.patch(delivery._id, {
      status: "sent",
      gmailMessageId: args.gmailMessageId?.slice(0, 300),
      sentAt: now,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      updatedAt: now,
    });
    await writeAuditLog(ctx, {
      level: "info",
      category: "system",
      action: delivery.kind,
      actorType: "system",
      entityType: "booking",
      entityId: String(delivery.bookingId),
      message: `Email sent to ${delivery.recipientEmail}.`,
      detailsJson: JSON.stringify({
        deliveryId: String(delivery._id),
        attempts: delivery.attempts,
        gmailMessageId: args.gmailMessageId,
      }),
      createdAt: now,
    });
    const dependents = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_dependency", (range) =>
        range.eq("dependsOnDeliveryId", delivery._id),
      )
      .collect();
    for (const dependent of dependents) {
      if (
        dependent.status !== "pending" &&
        dependent.status !== "blocked"
      ) {
        continue;
      }
      await ctx.db.patch(dependent._id, {
        status: "pending",
        nextAttemptAt: now,
        lastError: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.dispatchDelivery,
        { deliveryId: dependent._id },
      );
    }
  },
});

export const cancelDelivery = internalMutation({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.status !== "sending" ||
      delivery.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const now = Date.now();
    await cancelDeliveryRecord(ctx, delivery, args.reason, now);
  },
});

export const recordDeliveryFailure = internalMutation({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
    errorCode: v.string(),
    errorMessage: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.status !== "sending" ||
      delivery.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const now = Date.now();
    const willRetry =
      args.retryable && delivery.attempts < MAX_DELIVERY_ATTEMPTS;
    const retryDelay = willRetry
      ? RETRY_DELAYS_MS[
          Math.min(
            Math.max(delivery.attempts - 1, 0),
            RETRY_DELAYS_MS.length - 1,
          )
        ]
      : undefined;
    await ctx.db.patch(delivery._id, {
      status: willRetry ? "pending" : "failed",
      nextAttemptAt: willRetry ? now + retryDelay! : undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastError: `${cleanSingleLine(
        args.errorCode,
        "EMAIL_DELIVERY_FAILED",
        120,
      )}:${cleanSingleLine(args.errorMessage)}`.slice(0, 1_000),
      updatedAt: now,
    });
    await writeAuditLog(ctx, {
      level: willRetry ? "warning" : "error",
      category: "system",
      action: willRetry
        ? `${delivery.kind}_retry_scheduled`
        : `${delivery.kind}_failed`,
      actorType: "system",
      entityType: "booking",
      entityId: String(delivery.bookingId),
      message: willRetry
        ? "Email delivery failed and was scheduled for retry."
        : "Email delivery failed and needs administrator attention.",
      detailsJson: JSON.stringify({
        deliveryId: String(delivery._id),
        recipient: delivery.recipientEmail,
        attempt: delivery.attempts,
        errorCode: cleanSingleLine(args.errorCode, "", 120),
        error: cleanSingleLine(args.errorMessage),
        retryAt: willRetry ? now + retryDelay! : undefined,
      }),
      createdAt: now,
    });
    if (willRetry) {
      await ctx.scheduler.runAfter(
        retryDelay!,
        internal.emailNotifications.dispatchDelivery,
        { deliveryId: delivery._id },
      );
    }
  },
});

export const recoverDeliveryLease = internalMutation({
  args: {
    deliveryId: v.id("emailDeliveries"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    const now = Date.now();
    if (
      !delivery ||
      delivery.status !== "sending" ||
      delivery.leaseToken !== args.leaseToken ||
      (delivery.leaseExpiresAt ?? 0) > now
    ) {
      return;
    }
    const willRetry = delivery.attempts < MAX_DELIVERY_ATTEMPTS;
    await ctx.db.patch(delivery._id, {
      status: willRetry ? "pending" : "failed",
      nextAttemptAt: willRetry ? now : undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastError: "EMAIL_DELIVERY_LEASE_EXPIRED",
      updatedAt: now,
    });
    if (willRetry) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.dispatchDelivery,
        { deliveryId: delivery._id },
      );
    } else {
      await writeAuditLog(ctx, {
        level: "error",
        category: "system",
        action: `${delivery.kind}_failed`,
        actorType: "system",
        entityType: "booking",
        entityId: String(delivery.bookingId),
        message:
          "Email delivery exhausted its retries after worker timeouts.",
        detailsJson: JSON.stringify({
          deliveryId: String(delivery._id),
          recipient: delivery.recipientEmail,
        }),
        createdAt: now,
      });
    }
  },
});

export const retryFailedInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const failed = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_status_next_attempt", (range) =>
        range.eq("status", "failed"),
      )
      .take(50);
    const now = Date.now();
    for (const delivery of failed) {
      await ctx.db.patch(delivery._id, {
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.dispatchDelivery,
        { deliveryId: delivery._id },
      );
    }
    const notices=await ctx.db.query("bookingNotices").withIndex("by_status",q=>q.eq("status","failed")).take(50);
    for(const notice of notices){
      await ctx.db.patch(notice._id,{status:"pending",attempts:0,token:undefined,leaseExpiresAt:undefined,error:undefined,updatedAt:now});
      await ctx.scheduler.runAfter(0,internal.emailNotifications.sendBookingNotice,{noticeId:notice._id});
    }
    return { queued: failed.length + notices.length };
  },
});

export const inspectConfiguration = action({
  args: {},
  handler: async (ctx) => {
    await requireActionHeadAdmin(ctx);
    const configuration = gmailConfiguration();
    const access = await gmailAccessToken(configuration, true);
    const scopes = access.scope?.split(/\s+/).filter(Boolean) ?? [];
    return {
      appBaseUrl: configuration.appBaseUrl,
      fromEmail: configuration.fromEmail,
      refreshTokenOperational: true,
      gmailSendScopeConfirmed:
        scopes.length === 0 ||
        scopes.includes("https://www.googleapis.com/auth/gmail.send"),
      scopeWasReturned: scopes.length > 0,
    };
  },
});

export const sendTestEmail = action({
  args: { to: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActionHeadAdmin(ctx);
    const to = normalizeEmail(args.to, "GMAIL_RECIPIENT_INVALID");
    const configuration = gmailConfiguration();
    const text = `RoomOps successfully connected to the Gmail API.\n\nApplication: ${configuration.appBaseUrl}\nSender: ${configuration.fromEmail}\nTested: ${new Date().toISOString()}`;
    try {
      const result = await sendGmail({
        to,
        subject: "RoomOps Gmail integration test",
        text,
        html: htmlFromText(text),
        messageKey: crypto.randomUUID(),
      });
      await logEmail(ctx, {
        action: "gmail_test_email_sent",
        actorType: "user",
        actorId: user.clerkUserId,
        level: "info",
        message: `A Gmail integration test was sent to ${to}.`,
        details: { gmailMessageId: result.id },
      });
      return { ok: true, gmailMessageId: result.id };
    } catch (error) {
      const details = errorDetails(error);
      await logEmail(ctx, {
        action: "gmail_test_email_failed",
        actorType: "user",
        actorId: user.clerkUserId,
        level: "error",
        message: details.message,
        details: { code: details.code, recipient: to },
      });
      throw new ConvexError({
        code: details.code,
        message: details.message,
      });
    }
  },
});

export const retryFailedDeliveries = action({
  args: {},
  handler: async (ctx): Promise<{ queued: number }> => {
    await requireActionHeadAdmin(ctx);
    return (await ctx.runMutation(
      internal.emailNotifications.retryFailedInternal,
      {},
    )) as { queued: number };
  },
});

export const sendTechAlert = internalAction({
  args: { deliveryId: v.id("techAlertDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const token = crypto.randomUUID();
    const delivery = await ctx.runMutation(internal.techSupport.claim, { ...args, token });
    if (!delivery) return;
    let errorMessage: string | undefined;
    try {
      const configuration = gmailConfiguration();
      // Raw detailsJson can contain tokens or personal form answers. Keep those
      // behind authenticated logs; send a useful bounded summary and record ID.
      const log = delivery.log;
      const message = log.message.replace(/https?:\/\/\S+/gi, "[link omitted]")
        .replace(/(token|secret|password|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 1500);
      const text = ["RoomOps developer alert", `Severity: ${log.level}`,
        `Category: ${log.category}`, `Action: ${log.action}`, `Time: ${new Date(log.createdAt).toISOString()}`,
        `Log ID: ${log._id}`, "", message, "", `Review: ${configuration.appBaseUrl}/logs`].join("\n");
      await sendGmail({ to: delivery.email, subject: `[RoomOps ${log.level.toUpperCase()}] ${log.action}`,
        text, html: htmlFromText(text), messageKey: `tech-alert-${args.deliveryId}` });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Developer email failed.";
    }
    await ctx.runMutation(internal.techSupport.finish, { ...args, token, error: errorMessage });
  },
});

export const sendSupportMessage = internalAction({
  args: { deliveryId: v.id("supportDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const token=crypto.randomUUID();
    const delivery=await ctx.runMutation(internal.support.claimDelivery,{...args,token});
    if(!delivery)return;
    let errorMessage:string|undefined;
    try {
      const {message,thread}=delivery;
      const configuration=gmailConfiguration();
      const link=`${configuration.appBaseUrl}/support?thread=${encodeURIComponent(String(thread._id))}`;
      const text=[
        `${thread.kind==="announcement"?"RoomOps update":"RoomOps bug report"}: ${thread.title}`,
        `Severity: ${thread.severity} | Status: ${thread.status}`,
        `From: ${message.authorName} (${message.authorKind})`,"",message.body,"",
        message.attachmentIds.length?`${message.attachmentIds.length} picture(s) attached. Sign in to view them.`:"",
        `View and reply: ${link}`,"",
        "Reply in the Support tab. Replies to this notification email are not imported into RoomOps.",
      ].filter(line=>line!==undefined).join("\n");
      await sendGmail({to:delivery.email,subject:`[RoomOps ${thread.kind==="announcement"?"update":thread.severity}] ${thread.title}`,
        text,html:htmlFromText(text),messageKey:`support-${args.deliveryId}`});
    }catch(error){errorMessage=error instanceof Error?error.message:"Support email failed.";}
    await ctx.runMutation(internal.support.finishDelivery,{...args,token,error:errorMessage});
  },
});

/** Adds recipient-owned bookings only to submitter mail, never administrator mail. */
async function withSubmitterBookings(ctx: ActionCtx, email: string, message: {subject:string;text:string;html:string}, snapshotJson?:string) {
  const snapshot=snapshotJson ? JSON.parse(snapshotJson) as {capturedAt:number;timezone:string;rows:SubmitterMeeting[]} : null;
  const now=snapshot?.capturedAt??Date.now();
  let cursor:string|null=null;
  const rows: SubmitterMeeting[]=[];
  let timezone=snapshot?.timezone??"Asia/Singapore";
  if(snapshot) rows.push(...snapshot.rows);
  else do {
    const result: {page:SubmitterMeeting[];isDone:boolean;continueCursor:string;timezone:string} = await ctx.runQuery(internal.myBookings.emailPage,{email,paginationOpts:{numItems:20,cursor}});
    timezone=result.timezone;
    rows.push(...filterMeetings(result.page,"outstanding",now,timezone));
    cursor=result.isDone?null:result.continueCursor;
  } while(cursor!==null);
  const ordered=sortMeetings(rows,"booking","asc");
  const {today}=bookingWindow(now,timezone);
  const table=meetingTable(ordered);
  const link=`${gmailConfiguration().appBaseUrl}/booking-calendar`;
  const heading=`Your outstanding bookings (from ${today}, ${timezone})`;
  const snapshotLabel=snapshot ? `Snapshot when your change was saved (${new Date(now).toISOString()}).` : "Snapshot at email sending time.";
  const text=`${message.text}\n\n${heading}\nPending and approved meetings. ${snapshotLabel}\n${table.text}\n\nView the public booking calendar: ${link}\nNo sign-in required.`;
  const footer=`<section style="max-width:640px;margin:24px auto;padding:24px;background:#fff;font-family:Arial,sans-serif"><h2 style="font-size:18px">${escapeBookingHtml(heading)}</h2><p>Pending and approved meetings. ${snapshotLabel}</p>${table.html}<p><a href="${escapeBookingHtml(link)}">View the public booking calendar</a> · No sign-in required.</p></section>`;
  return {...message,text,html:message.html.includes("</body>")?message.html.replace("</body>",`${footer}</body>`):`${message.html}${footer}`};
}

export const sendBookingNotice=internalAction({args:{noticeId:v.id("bookingNotices")},handler:async(ctx,args):Promise<void>=>{
  const token=crypto.randomUUID();
  const notice=await ctx.runMutation(internal.bookingNotices.claim,{...args,token});
  if(!notice)return;
  let error:string|undefined;
  try {
    if (notice.requestSubject) {
      const before = meetingTable(JSON.parse(notice.beforeJson) as SubmitterMeeting[]);
      const after = meetingTable(JSON.parse(notice.afterJson) as SubmitterMeeting[]);
      const reviewLink = `${gmailConfiguration().appBaseUrl}/booking-requests`;
      const details = notice.detailChanges;
      let message = { subject: notice.requestSubject,
        text: `${notice.requestText}\n${details}\n\nOriginal booking\n${before.text}\n\nRequested / updated booking\n${after.text}${notice.approverNotice ? `\nReview in RoomOps: ${reviewLink}` : ""}`,
        html: renderEmailTemplate({ title: notice.requestSubject, introLines: [notice.requestText ?? ""], detailRows: [],
          extraHtml: `<p style="white-space:pre-wrap;background:#eef5f0;padding:14px;border-radius:8px">${escapeBookingHtml(details)}</p><h2 style="font-size:16px">Original booking</h2>${before.html}${notice.kind === "edited" ? `<h2 style="font-size:16px">Requested / updated booking</h2>${after.html}` : ""}`,
          ...(notice.approverNotice ? { actionHref: reviewLink, actionLabel: "View Edit Requests" } : {}) }),
      };
      if (!notice.approverNotice) message = await withSubmitterBookings(ctx, notice.recipientEmail, message, notice.outstandingJson);
      await sendGmail({ ...message, to: notice.recipientEmail, messageKey: `booking-request-${args.noticeId}` });
    } else {
    const before=meetingTable(JSON.parse(notice.beforeJson) as SubmitterMeeting[]);
    const after=meetingTable(JSON.parse(notice.afterJson) as SubmitterMeeting[]);
    const scope=notice.scope==="occurrence"?"This event":notice.scope==="following"?"This and following events":"All events";
    const summary=notice.kind==="deleted"&&notice.scope!=="series"
      ? `Selected meetings in booking ${notice.bookingReference} were removed. Scope: ${scope}.`
      : `Your booking ${notice.bookingReference} was ${notice.kind}. Scope: ${scope}.`;
    const calendar=notice.calendarPending?"The change is saved in RoomOps. Google Calendar synchronization may still be pending; this email does not confirm room-control changes.":"Please check the latest booking status in the booking calendar.";
    const message=await withSubmitterBookings(ctx,notice.recipientEmail,{
      subject:`Room booking ${notice.kind}: ${notice.bookingReference}`,
      text:`${summary}\n${calendar}\n${notice.detailChanges}\n\n${notice.kind==="deleted"?"Removed meetings":"Previous details"}\n${before.text}${notice.kind==="edited"?`\n\nUpdated details\n${after.text}`:""}`,
      html:`<html><body><main style="max-width:640px;margin:auto;padding:24px;font-family:Arial,sans-serif"><h1 style="font-size:22px">${escapeBookingHtml(summary)}</h1><p>${escapeBookingHtml(calendar)}</p>${notice.detailChanges?`<p style="white-space:pre-wrap">${escapeBookingHtml(notice.detailChanges)}</p>`:""}<h2>${notice.kind==="deleted"?"Removed meetings":"Previous details"}</h2>${before.html}${notice.kind==="edited"?`<h2>Updated details</h2>${after.html}`:""}</main></body></html>`,
    },notice.outstandingJson);
    await sendGmail({...message,to:notice.recipientEmail,messageKey:`booking-change-${args.noticeId}`});
    }
  }catch(caught){error=caught instanceof Error?caught.message:"Booking change email failed.";}
  await ctx.runMutation(internal.bookingNotices.finish,{...args,token,error});
}});
