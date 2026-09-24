/**
 * Google Calendar helpers for Convex actions.
 *
 * This module deliberately uses only Web Platform APIs (`fetch`, Web Crypto,
 * `TextEncoder`, and `URLSearchParams`) so it can run in Convex's default
 * action runtime. Calendar IDs and service-account credentials must be
 * supplied through environment variables by the calling action.
 */

import {
  JOTFORM_BOOKABLE_VENUES,
  JOTFORM_VENUE_ALIASES,
  JOTFORM_VENUES,
} from "../../shared/jotformConstants";
import { ministryCalendarLabel } from "../../shared/requestFields";

export const GOOGLE_CALENDAR_VENUES = JOTFORM_VENUES;

// These are the only venues exposed for new bookings and on the Calendar
// page. The three office venues remain in GOOGLE_CALENDAR_VENUES so existing
// bookings can still be reconciled or safely removed from Google Calendar.
export const BOOKABLE_GOOGLE_CALENDAR_VENUES = JOTFORM_BOOKABLE_VENUES;

export type GoogleCalendarVenue =
  (typeof GOOGLE_CALENDAR_VENUES)[number];

export type GoogleCalendarVenueMap = Readonly<
  Record<GoogleCalendarVenue, readonly string[]>
>;

export type VenueSelection = {
  displayName: string;
  venues: readonly GoogleCalendarVenue[];
};

export type VenueCalendarTarget = {
  calendarId: string;
  requestedVenue: string;
  venue: GoogleCalendarVenue;
};

export type GoogleServiceAccountCredentials = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

export type GoogleCalendarEventInput = {
  bookingId: string;
  calendarId: string;
  venue: GoogleCalendarVenue;
  requestedVenue: string;
  summary: string;
  startAt: number;
  endAt: number;
  timeZone: string;
  description?: string;
  location?: string;
  sourceSubmissionId?: string;
  recurrence?: readonly string[];
};

export type GoogleCalendarEventRef = {
  calendarId: string;
  eventId: string;
  htmlLink?: string;
  status?: string;
};

export type GoogleCalendarAccess = {
  accessRole: string;
  calendarId: string;
  summary: string;
  timeZone?: string;
};

export type GoogleCalendarBusyPeriod = {
  calendarId: string;
  end: string;
  occurrenceSequence: number;
  start: string;
};

export type GoogleCalendarAvailability = {
  available: boolean;
  conflicts: GoogleCalendarBusyPeriod[];
};

export type GoogleCalendarOccurrence = {
  sequence: number;
  startAt: number;
  endAt: number;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ClientOptions = {
  credentials: GoogleServiceAccountCredentials;
  fetch?: FetchLike;
  maxAttempts?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type GoogleCalendarRuntime = {
  client: GoogleCalendarClient;
  credentials: GoogleServiceAccountCredentials;
  venueMap: GoogleCalendarVenueMap;
};

type AccessToken = {
  expiresAt: number;
  value: string;
};

const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_GOOGLE_TOKEN_URI =
  "https://oauth2.googleapis.com/token";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_CALENDAR_IDS_PER_VENUE = 3;

const individualVenueSelections = Object.fromEntries(
  GOOGLE_CALENDAR_VENUES.map((venue) => [
    venueKey(venue),
    { displayName: venue, venues: [venue] },
  ]),
) as Record<string, VenueSelection>;

// Every spelling of a combined room displays under one canonical name.
const combinedVenueDisplayNames: Record<string, string> = {
  "Ministry Centre A|Ministry Centre B": "Ministry Centre A & B",
  "Ministry Centre A|Ministry Centre B|Ministry Centre C":
    "Ministry Centre A, B & C",
};

const venueAliases: Record<string, VenueSelection> = {
  ...individualVenueSelections,
  ...Object.fromEntries(
    Object.entries(JOTFORM_VENUE_ALIASES).map(([alias, venues]) => [
      venueKey(alias),
      {
        displayName:
          venues.length === 1
            ? venues[0]
            : combinedVenueDisplayNames[venues.join("|")] ?? alias,
        venues: venues as readonly GoogleCalendarVenue[],
      },
    ]),
  ),
};

function venueKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^\d+\s*[.)-]?\s*/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .toLocaleLowerCase("en")
    .replace(/\bcentre\b/g, "center")
    .replace(/\bcounselling\b/g, "counseling")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanSingleLine(value: string, maxLength = 1_024): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function calendarConfigurationError(
  code: string,
  message: string,
): Error {
  return new Error(`${code}:${message}`);
}

export function googleCalendarEnabled(
  value: string | undefined,
): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en") ?? "";
  if (!normalized || normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  throw calendarConfigurationError(
    "GOOGLE_CALENDAR_ENABLED_INVALID",
    "GOOGLE_CALENDAR_ENABLED must be true or false.",
  );
}

export function resolveVenueSelection(input: string): VenueSelection {
  const selection = venueAliases[venueKey(input)];
  if (!selection) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_UNKNOWN",
      `Unsupported venue "${cleanSingleLine(input, 160)}".`,
    );
  }
  return selection;
}

const bookableVenueSet = new Set<string>(
  BOOKABLE_GOOGLE_CALENDAR_VENUES,
);

export function resolveBookableVenueSelection(
  input: string,
): VenueSelection {
  const selection = resolveVenueSelection(input);
  if (
    selection.venues.some((venue) => !bookableVenueSet.has(venue))
  ) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_NOT_BOOKABLE",
      `"${selection.displayName}" is retained for historical bookings but no longer accepts new bookings.`,
    );
  }
  return selection;
}

function parseCalendarIds(
  venue: GoogleCalendarVenue,
  value: unknown,
): readonly string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
      `"${venue}" must map to a calendar ID or non-empty array of IDs.`,
    );
  }
  if (values.length > MAX_CALENDAR_IDS_PER_VENUE) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
      `"${venue}" may map to at most ${MAX_CALENDAR_IDS_PER_VENUE} calendar IDs.`,
    );
  }

  const ids = values.map((entry) => {
    if (typeof entry !== "string") {
      throw calendarConfigurationError(
        "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
        `"${venue}" contains a non-string calendar ID.`,
      );
    }
    const id = cleanSingleLine(entry, 1_024);
    if (!id) {
      throw calendarConfigurationError(
        "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
        `"${venue}" contains an empty calendar ID.`,
      );
    }
    return id;
  });

  if (new Set(ids).size !== ids.length) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
      `"${venue}" contains a duplicate calendar ID.`,
    );
  }
  return ids;
}

/**
 * Parses GOOGLE_CALENDAR_VENUE_MAP_JSON.
 *
 * Keys may use supported aliases (for example "Ministry Center A"), while
 * each value may be either one calendar ID or an array of IDs. Combined-room
 * aliases are intentionally rejected as keys: configure the A and B calendars
 * separately and the booking resolver will fan out at runtime.
 */
export function parseGoogleCalendarVenueMap(
  raw: string | undefined,
  options: { requireAll?: boolean } = {},
): GoogleCalendarVenueMap {
  if (!raw?.trim()) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_MISSING",
      "GOOGLE_CALENDAR_VENUE_MAP_JSON is not configured.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
      "GOOGLE_CALENDAR_VENUE_MAP_JSON must be valid JSON.",
    );
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
      "GOOGLE_CALENDAR_VENUE_MAP_JSON must be a JSON object.",
    );
  }

  const parsed = new Map<GoogleCalendarVenue, readonly string[]>();
  const calendarOwners = new Map<string, GoogleCalendarVenue>();
  for (const [configuredName, configuredIds] of Object.entries(
    decoded,
  )) {
    const selection = resolveVenueSelection(configuredName);
    if (selection.venues.length !== 1) {
      throw calendarConfigurationError(
        "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
        `Configure "${configuredName}" as separate individual venue calendars.`,
      );
    }
    const venue = selection.venues[0];
    if (parsed.has(venue)) {
      throw calendarConfigurationError(
        "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
        `"${venue}" is configured more than once through aliases.`,
      );
    }
    const ids = parseCalendarIds(venue, configuredIds);
    for (const id of ids) {
      const existingOwner = calendarOwners.get(id);
      if (existingOwner) {
        throw calendarConfigurationError(
          "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
          `The same calendar ID is assigned to "${existingOwner}" and "${venue}".`,
        );
      }
      calendarOwners.set(id, venue);
    }
    parsed.set(venue, ids);
  }

  const requireAll = options.requireAll ?? true;
  const missing = GOOGLE_CALENDAR_VENUES.filter(
    (venue) => !parsed.has(venue),
  );
  if (requireAll && missing.length > 0) {
    throw calendarConfigurationError(
      "GOOGLE_CALENDAR_VENUE_MAP_INCOMPLETE",
      `Missing calendar IDs for: ${missing.join(", ")}.`,
    );
  }

  return Object.fromEntries(
    GOOGLE_CALENDAR_VENUES.map((venue) => [
      venue,
      parsed.get(venue) ?? [],
    ]),
  ) as unknown as GoogleCalendarVenueMap;
}

export function calendarTargetsForVenue(
  requestedVenue: string,
  venueMap: GoogleCalendarVenueMap,
): VenueCalendarTarget[] {
  const selection = resolveVenueSelection(requestedVenue);
  return selection.venues.flatMap((venue) => {
    const ids = venueMap[venue];
    if (!ids || ids.length === 0) {
      throw calendarConfigurationError(
        "GOOGLE_CALENDAR_ID_MISSING",
        `No Google Calendar ID is configured for "${venue}".`,
      );
    }
    return ids.map((calendarId) => ({
      calendarId,
      requestedVenue: selection.displayName,
      venue,
    }));
  });
}

/**
 * Produces: `[Venue] Event Name or Purpose of Booking Ministry`.
 */
export function buildGoogleCalendarTitle(input: {
  venue: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
}): string {
  const venue = resolveVenueSelection(input.venue).displayName;
  const eventNameOrPurpose =
    cleanSingleLine(input.eventName ?? "", 500) ||
    cleanSingleLine(input.purpose ?? "", 500) ||
    "Room Booking";
  const ministry = cleanSingleLine(
    ministryCalendarLabel(input.ministry ?? ""),
    300,
  );
  return cleanSingleLine(
    `[${venue}] ${eventNameOrPurpose}${ministry ? ` ${ministry}` : ""}`,
  );
}

export function buildGoogleCalendarEventText(input: {
  venue: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  requesterName: string;
}): {
  description: string;
  location: string;
  summary: string;
} {
  const venue = resolveVenueSelection(input.venue).displayName;
  const ministry =
    cleanSingleLine(ministryCalendarLabel(input.ministry ?? ""), 300) ||
    "-";
  const eventNameOrPurpose =
    cleanSingleLine(input.eventName ?? "", 500) ||
    cleanSingleLine(input.purpose ?? "", 2_000) ||
    "Room Booking";
  const requesterName =
    cleanSingleLine(input.requesterName, 160) || "-";
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  return {
    description: [
      "<b>Ministry:</b>",
      escapeHtml(ministry),
      "",
      "<b>Event Name or Purpose of Booking:</b>",
      escapeHtml(eventNameOrPurpose),
      "",
      "<b>Name:</b>",
      escapeHtml(requesterName),
      "",
      "<b>Venue:</b>",
      escapeHtml(venue),
    ].join("<br>"),
    location: venue,
    summary: buildGoogleCalendarTitle({
      eventName: input.eventName,
      ministry: input.ministry,
      purpose: input.purpose,
      venue,
    }),
  };
}

export function buildGoogleCalendarPrivateProperties(input: {
  bookingId: string;
  requestedVenue: string;
  targetVenue: GoogleCalendarVenue;
  sourceSubmissionId?: string;
}): Record<string, string> {
  const properties: Record<string, string> = {
    roomopsBookingId: cleanSingleLine(input.bookingId, 1_024),
    roomopsManaged: "true",
    roomopsRequestedVenue: resolveVenueSelection(
      input.requestedVenue,
    ).displayName,
    roomopsSchemaVersion: "1",
    roomopsTargetVenue: input.targetVenue,
  };
  const submissionId = cleanSingleLine(
    input.sourceSubmissionId ?? "",
    1_024,
  );
  if (submissionId) {
    properties.roomopsSubmissionId = submissionId;
  }
  return properties;
}

export function parseGoogleServiceAccount(
  raw: string | undefined,
): GoogleServiceAccountCredentials {
  if (!raw?.trim()) {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_MISSING",
      "GOOGLE_SERVICE_ACCOUNT_JSON is not configured.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON.",
    );
  }
  if (!decoded || typeof decoded !== "object") {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.",
    );
  }

  const record = decoded as Record<string, unknown>;
  const clientEmail =
    typeof record.client_email === "string"
      ? cleanSingleLine(record.client_email, 320)
      : "";
  const privateKey =
    typeof record.private_key === "string"
      ? record.private_key.replace(/\\n/g, "\n").trim()
      : "";
  const tokenUri =
    typeof record.token_uri === "string"
      ? cleanSingleLine(record.token_uri, 1_024)
      : DEFAULT_GOOGLE_TOKEN_URI;

  if (!clientEmail || !privateKey) {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "The service-account JSON must contain client_email and private_key.",
    );
  }
  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "private_key must be a PKCS#8 PEM private key.",
    );
  }
  let parsedTokenUri: URL;
  try {
    parsedTokenUri = new URL(tokenUri);
  } catch {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "token_uri must be a valid HTTPS URL.",
    );
  }
  if (parsedTokenUri.protocol !== "https:") {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "token_uri must be a valid HTTPS URL.",
    );
  }
  if (parsedTokenUri.origin !== "https://oauth2.googleapis.com") {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "token_uri must use Google's oauth2.googleapis.com endpoint.",
    );
  }

  return { clientEmail, privateKey, tokenUri };
}

export function parseGoogleServiceAccountBase64(
  raw: string | undefined,
): GoogleServiceAccountCredentials {
  if (!raw?.trim()) {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_MISSING",
      "GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64 is not configured.",
    );
  }
  try {
    const encoded = raw.replace(/\s+/g, "");
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      encoded.length % 4 === 1
    ) {
      throw new Error("INVALID_BASE64");
    }
    const decoded = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );
    return parseGoogleServiceAccount(
      new TextDecoder("utf-8", { fatal: true }).decode(decoded),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("GOOGLE_SERVICE_ACCOUNT_")
    ) {
      throw error;
    }
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64 is not valid base64 JSON.",
    );
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export async function deterministicGoogleCalendarEventId(input: {
  bookingId: string;
  calendarId: string;
  venue: GoogleCalendarVenue;
  generation?: string;
}): Promise<string> {
  const sourceParts = [
    cleanSingleLine(input.bookingId, 1_024),
    cleanSingleLine(input.calendarId, 1_024),
    input.venue,
  ];
  const generation = cleanSingleLine(input.generation ?? "", 120);
  if (generation) sourceParts.push(generation);
  const source = sourceParts.join("\u0000");
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    ),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // Google event IDs accept the base32hex alphabet (a-v and 0-9). A SHA-256
  // hexadecimal digest is a valid subset and makes ambiguous retries safe.
  return `roomops${hex.slice(0, 48)}`;
}

function pemToPkcs8(privateKey: string): ArrayBuffer {
  const encoded = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!encoded) {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "The service-account private key is empty.",
    );
  }
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    throw calendarConfigurationError(
      "GOOGLE_SERVICE_ACCOUNT_INVALID",
      "The service-account private key is not valid PEM/base64 data.",
    );
  }
}

export async function createServiceAccountAssertion(
  credentials: GoogleServiceAccountCredentials,
  nowMs = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1_000);
  const encodedHeader = textToBase64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const encodedClaims = textToBase64Url(
    JSON.stringify({
      aud: credentials.tokenUri,
      exp: issuedAt + 3_600,
      iat: issuedAt,
      iss: credentials.clientEmail,
      scope: GOOGLE_CALENDAR_SCOPE,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(credentials.privateKey),
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(
    new Uint8Array(signature),
  )}`;
}

async function responseMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fallback;
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error_description === "string") {
      return cleanSingleLine(record.error_description, 500);
    }
    if (typeof record.error === "string") {
      return cleanSingleLine(record.error, 500);
    }
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") {
        return cleanSingleLine(nested.message, 500);
      }
    }
  }
  return fallback;
}

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(
  response: Response | undefined,
  failedAttempt: number,
  now: number,
): number {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        Math.max(retryAt - now, 0),
        MAX_RETRY_DELAY_MS,
      );
    }
  }
  return Math.min(
    250 * 2 ** Math.max(failedAttempt - 1, 0),
    MAX_RETRY_DELAY_MS,
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function eventBody(
  input: GoogleCalendarEventInput,
  eventId?: string,
): Record<string, unknown> {
  if (
    !Number.isFinite(input.startAt) ||
    !Number.isFinite(input.endAt) ||
    input.endAt <= input.startAt
  ) {
    throw new Error(
      "GOOGLE_CALENDAR_TIME_INVALID:Event end time must be after its start time.",
    );
  }
  const timeZone = cleanSingleLine(input.timeZone, 120);
  if (!timeZone) {
    throw new Error(
      "GOOGLE_CALENDAR_TIMEZONE_MISSING:A booking timezone is required.",
    );
  }
  const recurrence = input.recurrence?.map((rule) =>
    cleanSingleLine(rule, 1_024),
  );
  if (recurrence?.some((rule) => !rule)) {
    throw new Error(
      "GOOGLE_CALENDAR_RECURRENCE_INVALID:Recurrence rules cannot be empty.",
    );
  }

  return {
    description: input.description
      ? input.description.trim().slice(0, 8_192)
      : undefined,
    end: {
      dateTime: new Date(input.endAt).toISOString(),
      timeZone,
    },
    extendedProperties: {
      private: buildGoogleCalendarPrivateProperties({
        bookingId: input.bookingId,
        requestedVenue: input.requestedVenue,
        sourceSubmissionId: input.sourceSubmissionId,
        targetVenue: input.venue,
      }),
    },
    id: eventId,
    location: input.location
      ? cleanSingleLine(input.location, 1_024)
      : undefined,
    recurrence: recurrence?.length ? recurrence : undefined,
    start: {
      dateTime: new Date(input.startAt).toISOString(),
      timeZone,
    },
    summary: cleanSingleLine(input.summary),
  };
}

export class GoogleCalendarClient {
  private accessToken?: AccessToken;
  private readonly credentials: GoogleServiceAccountCredentials;
  private readonly fetch: FetchLike;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.credentials = options.credentials;
    this.fetch = options.fetch ?? fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 5
    ) {
      throw new Error(
        "GOOGLE_CALENDAR_CLIENT_INVALID:maxAttempts must be an integer from 1 to 5.",
      );
    }
    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      this.requestTimeoutMs > 30_000
    ) {
      throw new Error(
        "GOOGLE_CALENDAR_CLIENT_INVALID:requestTimeoutMs must be from 1 to 30000.",
      );
    }
  }

  private async fetchOnce(
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutError = new Error(
      `GOOGLE_CALENDAR_REQUEST_TIMEOUT:Google did not respond within ${this.requestTimeoutMs}ms.`,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetch(input, {
            ...init,
            signal: controller.signal,
          });
          // `fetch` may resolve as soon as response headers arrive. Buffer the
          // small Google API response while the same timeout is still active
          // so a stalled response body cannot hold a Convex action open.
          const body = response.body
            ? await response.arrayBuffer()
            : null;
          return new Response(body, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          });
        })(),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async resilientFetch(
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchOnce(input, init);
      } catch (error) {
        lastError = error;
      }

      if (response && !retryableStatus(response.status)) {
        return response;
      }
      if (response) {
        lastError = new Error(
          `${response.status} ${response.statusText}`.trim(),
        );
      }
      if (attempt === this.maxAttempts) {
        if (response) return response;
        throw lastError;
      }

      // Release the buffered response before retrying. Google errors are
      // normally tiny, but avoiding retained response bodies keeps retries
      // predictable in long-lived action isolates.
      try {
        await response?.body?.cancel();
      } catch {
        // A failed body cleanup must not mask the retryable Google response.
      }
      await this.sleep(
        retryDelayMs(response, attempt, this.now()),
      );
    }
    // The constructor enforces at least one attempt, so this is unreachable.
    throw lastError;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.accessToken &&
      this.accessToken.expiresAt - 60_000 > this.now()
    ) {
      return this.accessToken.value;
    }
    const assertion = await createServiceAccountAssertion(
      this.credentials,
      this.now(),
    );
    const response = await this.resilientFetch(
      this.credentials.tokenUri,
      {
        body: new URLSearchParams({
          assertion,
          grant_type:
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
    );
    if (!response.ok) {
      throw new Error(
        `GOOGLE_OAUTH_FAILED:${await responseMessage(response)}`,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.access_token !== "string") {
      throw new Error(
        "GOOGLE_OAUTH_FAILED:Google did not return an access token.",
      );
    }
    const expiresIn =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 3_600;
    this.accessToken = {
      expiresAt: this.now() + expiresIn * 1_000,
      value: body.access_token,
    };
    return this.accessToken.value;
  }

  private async request(
    path: string,
    init: RequestInit,
    retryAuthentication = true,
  ): Promise<Response> {
    const token = await this.getAccessToken(!retryAuthentication);
    const response = await this.resilientFetch(
      `${GOOGLE_CALENDAR_API}${path}`,
      {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      },
    );
    if (response.status === 401 && retryAuthentication) {
      this.accessToken = undefined;
      return await this.request(path, init, false);
    }
    return response;
  }

  async getCalendarAccess(
    calendarId: string,
  ): Promise<GoogleCalendarAccess> {
    let response = await this.request(
      `/users/me/calendarList/${encodeURIComponent(calendarId)}`,
      { method: "GET" },
    );
    if (response.status === 404) {
      response = await this.request("/users/me/calendarList", {
        body: JSON.stringify({ id: calendarId }),
        method: "POST",
      });
      if (response.status === 409) {
        response = await this.request(
          `/users/me/calendarList/${encodeURIComponent(calendarId)}`,
          { method: "GET" },
        );
      }
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_METADATA_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    const calendar = (await response.json()) as Record<
      string,
      unknown
    >;
    if (
      typeof calendar.id !== "string" ||
      typeof calendar.summary !== "string" ||
      typeof calendar.accessRole !== "string"
    ) {
      throw new Error(
        "GOOGLE_CALENDAR_METADATA_FAILED:Google returned incomplete calendar metadata.",
      );
    }
    return {
      accessRole: cleanSingleLine(calendar.accessRole, 80),
      calendarId: calendar.id,
      summary: cleanSingleLine(calendar.summary, 500),
      timeZone:
        typeof calendar.timeZone === "string"
          ? cleanSingleLine(calendar.timeZone, 120)
          : undefined,
    };
  }

  async checkAvailability(input: {
    calendarIds: readonly string[];
    occurrences: readonly GoogleCalendarOccurrence[];
    timeZone: string;
  }): Promise<GoogleCalendarAvailability> {
    if (input.occurrences.length === 0) {
      throw new Error(
        "GOOGLE_CALENDAR_TIME_INVALID:At least one occurrence is required.",
      );
    }
    for (const occurrence of input.occurrences) {
      if (
        !Number.isInteger(occurrence.sequence) ||
        occurrence.sequence < 0 ||
        !Number.isFinite(occurrence.startAt) ||
        !Number.isFinite(occurrence.endAt) ||
        occurrence.endAt <= occurrence.startAt
      ) {
        throw new Error(
          "GOOGLE_CALENDAR_TIME_INVALID:Every occurrence must have a valid interval and sequence.",
        );
      }
    }
    const calendarIds = [...new Set(input.calendarIds)];
    if (calendarIds.length === 0) {
      throw new Error(
        "GOOGLE_CALENDAR_IDS_MISSING:At least one calendar ID is required.",
      );
    }
    const conflicts: GoogleCalendarBusyPeriod[] = [];

    for (const occurrence of input.occurrences) {
      const response = await this.request("/freeBusy", {
        body: JSON.stringify({
          items: calendarIds.map((id) => ({ id })),
          timeMax: new Date(occurrence.endAt).toISOString(),
          timeMin: new Date(occurrence.startAt).toISOString(),
          timeZone: cleanSingleLine(input.timeZone, 120),
        }),
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          `GOOGLE_CALENDAR_FREEBUSY_FAILED:${await responseMessage(
            response,
          )}`,
        );
      }
      const payload = (await response.json()) as {
        calendars?: Record<
          string,
          {
            busy?: Array<{ end?: unknown; start?: unknown }>;
            errors?: unknown[];
          }
        >;
      };
      for (const calendarId of calendarIds) {
        const calendar = payload.calendars?.[calendarId];
        if (!calendar || (calendar.errors?.length ?? 0) > 0) {
          throw new Error(
            `GOOGLE_CALENDAR_FREEBUSY_FAILED:Google could not read calendar "${calendarId}".`,
          );
        }
        for (const period of calendar.busy ?? []) {
          if (
            typeof period.start === "string" &&
            typeof period.end === "string"
          ) {
            const busyStart = Date.parse(period.start);
            const busyEnd = Date.parse(period.end);
            if (
              !Number.isFinite(busyStart) ||
              !Number.isFinite(busyEnd) ||
              busyEnd <= busyStart
            ) {
              throw new Error(
                `GOOGLE_CALENDAR_FREEBUSY_FAILED:Google returned an invalid busy interval for "${calendarId}".`,
              );
            }
            if (
              busyStart < occurrence.endAt &&
              busyEnd > occurrence.startAt
            ) {
              conflicts.push({
                calendarId,
                end: period.end,
                occurrenceSequence: occurrence.sequence,
                start: period.start,
              });
            }
          }
        }
      }
    }
    return { available: conflicts.length === 0, conflicts };
  }

  async createEvent(
    input: GoogleCalendarEventInput,
    generation?: string,
  ): Promise<GoogleCalendarEventRef> {
    const eventId = await deterministicGoogleCalendarEventId({
      bookingId: input.bookingId,
      calendarId: input.calendarId,
      venue: input.venue,
      generation,
    });
    const response = await this.request(
      `/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events?sendUpdates=none`,
      {
        body: JSON.stringify(eventBody(input, eventId)),
        method: "POST",
      },
    );
    if (response.status === 409) {
      const existing = await this.request(
        `/calendars/${encodeURIComponent(
          input.calendarId,
        )}/events/${encodeURIComponent(eventId)}`,
        { method: "GET" },
      );
      if (!existing.ok) {
        throw new Error(
          `GOOGLE_CALENDAR_CREATE_FAILED:${await responseMessage(
            existing,
          )}`,
        );
      }
      const event = (await existing.json()) as {
        extendedProperties?: {
          private?: Record<string, unknown>;
        };
      };
      const privateProperties =
        event.extendedProperties?.private;
      if (
        privateProperties?.roomopsManaged !== "true" ||
        privateProperties?.roomopsBookingId !== input.bookingId ||
        privateProperties?.roomopsTargetVenue !== input.venue
      ) {
        throw new Error(
          "GOOGLE_CALENDAR_EVENT_ID_COLLISION:The deterministic event ID belongs to another event.",
        );
      }
      return await this.updateEvent(eventId, input);
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_CREATE_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    const event = (await response.json()) as Record<string, unknown>;
    if (typeof event.id !== "string") {
      throw new Error(
        "GOOGLE_CALENDAR_CREATE_FAILED:Google did not return an event ID.",
      );
    }
    return {
      calendarId: input.calendarId,
      eventId: event.id,
      htmlLink:
        typeof event.htmlLink === "string"
          ? event.htmlLink
          : undefined,
      status:
        typeof event.status === "string" ? event.status : undefined,
    };
  }

  async updateEvent(
    eventId: string,
    input: GoogleCalendarEventInput,
    replacementGeneration?: string,
  ): Promise<GoogleCalendarEventRef> {
    const response = await this.request(
      `/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      {
        body: JSON.stringify(eventBody(input)),
        method: "PATCH",
      },
    );
    if (
      (response.status === 404 || response.status === 410) &&
      replacementGeneration
    ) {
      return await this.createEvent(input, replacementGeneration);
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_UPDATE_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    const event = (await response.json()) as Record<string, unknown>;
    if (typeof event.id !== "string") {
      throw new Error(
        "GOOGLE_CALENDAR_UPDATE_FAILED:Google did not return an event ID.",
      );
    }
    return {
      calendarId: input.calendarId,
      eventId: event.id,
      htmlLink:
        typeof event.htmlLink === "string"
          ? event.htmlLink
          : undefined,
      status:
        typeof event.status === "string" ? event.status : undefined,
    };
  }

  /**
   * Reads an event back from Google and verifies that it is still owned by
   * the expected RoomOps booking. A successful insert/PATCH response is not
   * enough for reconciliation: an event can subsequently be deleted, or the
   * configured calendar can be different from the calendar an administrator
   * is looking at.
   */
  async verifyManagedEvent(input: {
    bookingId: string;
    calendarId: string;
    eventId: string;
    venue: GoogleCalendarVenue;
  }): Promise<GoogleCalendarEventRef> {
    const response = await this.request(
      `/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
      { method: "GET" },
    );
    if (response.status === 404 || response.status === 410) {
      throw new Error(
        `GOOGLE_CALENDAR_EVENT_MISSING:Google could not find event "${input.eventId}" in calendar "${input.calendarId}".`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_EVENT_VERIFY_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    const event = (await response.json()) as {
      id?: unknown;
      htmlLink?: unknown;
      status?: unknown;
      extendedProperties?: {
        private?: Record<string, unknown>;
      };
    };
    const properties = event.extendedProperties?.private;
    if (
      properties?.roomopsManaged !== "true" ||
      properties?.roomopsBookingId !== input.bookingId ||
      properties?.roomopsTargetVenue !== input.venue
    ) {
      throw new Error(
        "GOOGLE_CALENDAR_EVENT_OWNERSHIP_INVALID:The Calendar event does not belong to this RoomOps booking.",
      );
    }
    if (event.status === "cancelled") {
      throw new Error(
        `GOOGLE_CALENDAR_EVENT_CANCELLED:The managed event "${input.eventId}" is cancelled in Google Calendar.`,
      );
    }
    if (event.id !== input.eventId) {
      throw new Error(
        "GOOGLE_CALENDAR_EVENT_VERIFY_FAILED:Google returned a different event ID.",
      );
    }
    return {
      calendarId: input.calendarId,
      eventId: input.eventId,
      htmlLink:
        typeof event.htmlLink === "string"
          ? event.htmlLink
          : undefined,
      status:
        typeof event.status === "string" ? event.status : undefined,
    };
  }

  /** Free/busy cannot exclude the booking itself. Expand events and exclude
   * only verified RoomOps ownership, retaining manual/private/recurring conflicts. */
  async availableExceptBooking(input: { calendarId: string; bookingId: string; startAt: number; endAt: number; timeZone: string }): Promise<boolean> {
    const owned = new Set((await this.listManagedEvents(input.bookingId, input.calendarId)).map(event => event.eventId));
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ timeMin: new Date(input.startAt).toISOString(), timeMax: new Date(input.endAt).toISOString(),
        timeZone: input.timeZone, singleEvents: "true", showDeleted: "false", maxResults: "2500",
        fields: "accessRole,nextPageToken,items(id,recurringEventId,status,transparency,extendedProperties/private)" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request(`/calendars/${encodeURIComponent(input.calendarId)}/events?${query}`, { method: "GET" });
      if (!response.ok) throw Error("Google Calendar availability could not be checked.");
      const result = await response.json() as { accessRole?: string; nextPageToken?: string; items?: Array<{ id?: string; recurringEventId?: string; status?: string; transparency?: string; extendedProperties?: { private?: Record<string, string> } }> };
      if (!["writer", "owner"].includes(result.accessRole ?? "")) throw Error("Full Calendar read/write permission is required.");
      for (const event of result.items ?? []) {
        if (event.status === "cancelled" || event.transparency === "transparent") continue;
        const properties = event.extendedProperties?.private;
        const own = properties?.roomopsManaged === "true" && properties.roomopsBookingId === input.bookingId;
        if (!own && !owned.has(event.recurringEventId ?? event.id ?? "")) return false;
      }
      pageToken = result.nextPageToken;
      if (pageToken && (seen.has(pageToken) || seen.size >= 100)) throw Error("Calendar pagination exceeded safe limits.");
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return true;
  }

  /** Read the actual schedule, including externally-created and expanded recurring events. */
  async listPublicSchedule(calendarId:string,timeMin:string,timeMax:string,timeZone:string):Promise<import("./googlePublicCalendar").PublicGoogleEvent[]> {
    const events:import("./googlePublicCalendar").PublicGoogleEvent[]=[];
    let pageToken:string|undefined;const seen=new Set<string>();
    do {
      const query=new URLSearchParams({timeMin,timeMax,timeZone,singleEvents:"true",showDeleted:"false",maxResults:"250",orderBy:"startTime",fields:"accessRole,nextPageToken,items(id,status,summary,visibility,start,end,extendedProperties/private)"});
      if(pageToken)query.set("pageToken",pageToken);
      const response=await this.request(`/calendars/${encodeURIComponent(calendarId)}/events?${query}`,{method:"GET"});
      if(!response.ok)throw Error("Google Calendar schedule could not be read.");
      const result=await response.json() as {accessRole?:string;items?:import("./googlePublicCalendar").PublicGoogleEvent[];nextPageToken?:string};
      if(!["reader","writer","owner","writerWithoutPrivateAccess"].includes(result.accessRole??""))throw Error("Calendar event read permission is required.");
      events.push(...(result.items??[]));pageToken=result.nextPageToken;
      if(events.length>2500||seen.size>=20||pageToken&&seen.has(pageToken))throw Error("Calendar schedule exceeds safe read limits.");
      if(pageToken)seen.add(pageToken);
    }while(pageToken);
    return events;
  }

  /** Discover all owned events, including recurring parents and lost references. */
  async listManagedEvents(bookingId: string, calendarId: string): Promise<Array<{
    calendarId: string;
    eventId: string;
    targetVenue: GoogleCalendarVenue;
  }>> {
    const events: Array<{ calendarId: string; eventId: string; targetVenue: GoogleCalendarVenue }> = [];
    const seenPages = new Set<string>();
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        privateExtendedProperty: `roomopsBookingId=${bookingId}`,
        singleEvents: "false",
        showDeleted: "false",
        maxResults: "2500",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request(
        `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
        { method: "GET" },
      );
      if (!response.ok) {
        throw new Error(`GOOGLE_CALENDAR_DISCOVERY_FAILED:${await responseMessage(response)}`);
      }
      const payload = await response.json() as {
        accessRole?: string;
        nextPageToken?: string;
        items?: Array<{
          id?: string;
          status?: string;
          extendedProperties?: { private?: Record<string, string> };
        }>;
      };
      // A missing event must not be confused with lost Calendar permissions.
      if (payload.accessRole !== "writer" && payload.accessRole !== "owner") {
        throw new Error("GOOGLE_CALENDAR_DISCOVERY_FAILED:Full write access is required to verify booking deletion.");
      }
      for (const event of payload.items ?? []) {
        if (event.status === "cancelled") continue;
        const properties = event.extendedProperties?.private;
        if (properties?.roomopsManaged !== "true" || properties.roomopsBookingId !== bookingId ||
            !event.id || !(GOOGLE_CALENDAR_VENUES as readonly string[]).includes(properties.roomopsTargetVenue)) {
          throw new Error("GOOGLE_CALENDAR_DISCOVERY_FAILED:An event has incomplete or unexpected ownership metadata.");
        }
        events.push({ calendarId, eventId: event.id, targetVenue: properties.roomopsTargetVenue as GoogleCalendarVenue });
      }
      pageToken = payload.nextPageToken;
      if (pageToken && seenPages.has(pageToken)) {
        throw new Error("GOOGLE_CALENDAR_DISCOVERY_FAILED:Google repeated a pagination token.");
      }
      if (pageToken) seenPages.add(pageToken);
    } while (pageToken);
    return events;
  }

  private async verifyEventAbsent(calendarId: string, eventId: string): Promise<void> {
    const response = await this.request(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "GET" },
    );
    if (response.status === 404 || response.status === 410) return;
    if (response.ok) {
      const event = await response.json() as { id?: string; status?: string };
      if (event.id === eventId && event.status === "cancelled") return;
    }
    throw new Error("GOOGLE_CALENDAR_DELETE_UNVERIFIED:The event could not be confirmed absent after deletion. Retry deletion.");
  }

  /**
   * Returns false when the event was already absent, making cleanup safe to
   * retry after partial failures.
   */
  async deleteEvent(
    calendarId: string,
    eventId: string,
    expectedEtag?: string,
  ): Promise<boolean> {
    const response = await this.request(
      `/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      {
        headers: expectedEtag
          ? { "if-match": expectedEtag }
          : undefined,
        method: "DELETE",
      },
    );
    if (response.status === 404 || response.status === 410) {
      return false;
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_DELETE_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    return true;
  }

  /**
   * Deletes only an event carrying RoomOps ownership metadata for the exact
   * booking and physical venue. A deterministic-ID collision is never
   * deleted.
   */
  async deleteManagedEvent(input: {
    bookingId: string;
    calendarId: string;
    eventId: string;
    venue: GoogleCalendarVenue;
  }): Promise<boolean> {
    const response = await this.request(
      `/calendars/${encodeURIComponent(
        input.calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
      { method: "GET" },
    );
    if (response.status === 404 || response.status === 410) {
      return false;
    }
    if (!response.ok) {
      throw new Error(
        `GOOGLE_CALENDAR_EVENT_LOOKUP_FAILED:${await responseMessage(
          response,
        )}`,
      );
    }
    const event = (await response.json()) as {
      id?: unknown;
      status?: unknown;
      etag?: unknown;
      extendedProperties?: {
        private?: Record<string, unknown>;
      };
    };
    // Deleted resources may contain only id/status, without ownership or ETag.
    // No destructive request is made for a tombstone.
    if (event.id === input.eventId && event.status === "cancelled") return false;
    const properties = event.extendedProperties?.private;
    if (
      properties?.roomopsManaged !== "true" ||
      properties?.roomopsBookingId !== input.bookingId ||
      properties?.roomopsTargetVenue !== input.venue
    ) {
      throw new Error(
        "GOOGLE_CALENDAR_EVENT_ID_COLLISION:The event selected for cleanup is not owned by this RoomOps booking.",
      );
    }
    if (typeof event.etag !== "string" || !event.etag) {
      throw new Error(
        "GOOGLE_CALENDAR_EVENT_LOOKUP_FAILED:Google did not return an event ETag for safe cleanup.",
      );
    }
    const deleted = await this.deleteEvent(
      input.calendarId,
      input.eventId,
      event.etag,
    );
    await this.verifyEventAbsent(input.calendarId, input.eventId);
    return deleted;
  }
}

export function googleCalendarRuntimeFromEnv(
  env: Record<string, string | undefined>,
): GoogleCalendarRuntime | null {
  if (!googleCalendarEnabled(env.GOOGLE_CALENDAR_ENABLED)) {
    return null;
  }
  const credentials = parseGoogleServiceAccountBase64(
    env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64,
  );
  const venueMap = parseGoogleCalendarVenueMap(
    env.GOOGLE_CALENDAR_VENUE_MAP_JSON,
  );
  return {
    client: new GoogleCalendarClient({ credentials }),
    credentials,
    venueMap,
  };
}
