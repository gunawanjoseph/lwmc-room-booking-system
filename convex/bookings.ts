import { DateTime } from "luxon";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCapability, requireHeadAdmin } from "./lib/auth";
import {
  calendarEventRefValidator,
  jotformResponseValidator,
  recurrenceFrequencyValidator,
} from "./schema";
import {
  BookingRuleError,
  assertConflictLookupRangesWithinLimit,
  assertSortedNonOverlappingOccurrences,
  assertTotalClaimSlotsWithinLimit,
  isClaimMigrationPageSizeValid,
  normalizeRoomKey,
  uniqueConflictClaimRoomTargets,
  utcDaysForInterval,
} from "./lib/bookingRules";
import {
  BOOKABLE_GOOGLE_CALENDAR_VENUES,
  parseGoogleCalendarVenueMap,
  resolveBookableVenueSelection,
  resolveVenueSelection,
} from "./lib/googleCalendar";
import {
  expandRecurrence,
  MAX_RECURRENCE_OCCURRENCES,
  recurrenceCountForAdminEdit,
  recurrenceDefinitionChanged,
  type RecurrenceFrequency,
  type RecurrenceOccurrence,
} from "./lib/recurrence";
import {
  EMAIL_DECISION_TOKEN_PATTERN,
  emailDecisionClaimError as terminalEmailDecisionClaimError,
} from "./lib/emailDecisionClaim";
import {
  needsCalendarAttemptCleanup,
  partitionCalendarCleanupCandidates,
} from "./lib/calendarTransition";
import { calculateConflictOverview } from "./lib/bookingOverview";
import {
  applyOccurrenceEdit,
  conflictIdsAcknowledged,
  type EditableOccurrence,
} from "./lib/bookingEdit";
import {
  bookingDeletionInProgress,
  hasActiveEmailDeliveryLease,
  managedCalendarEventsForDeletion,
  mergeManagedCalendarEvents,
} from "./lib/bookingDeletion";

type BookingInput = {
  room: string;
  startAt: number;
  endAt: number;
  timezone: string;
  recurrenceFrequency?: RecurrenceFrequency;
  recurrenceCount?: number;
  recurrenceUntilAt?: number;
};

type BookingOccurrence = RecurrenceOccurrence &
  Pick<EditableOccurrence, "room" | "resolvedVenues">;

const MAX_TABLE_EDITS = 50;
const MAX_RESPONSE_EDITS_PER_BOOKING = 40;
const MAX_RESPONSE_VALUE_LENGTH = 4_000;
const MAX_STORED_RESPONSES_PER_BOOKING = 150;
const MAX_CLAIM_SLOTS_PER_BOOKING = 2_000;
// Convex actions have a 30-minute runtime limit. Keeping the durable lease
// slightly longer means an expired worker cannot still be writing Google
// Calendar when a replacement worker takes ownership.
const CALENDAR_SYNC_LEASE_MS = 31 * 60_000;
const BOOKING_DELETION_LEASE_MS = 31 * 60_000;
const emailDecisionClaimValidator = v.object({
  claimToken: v.string(),
  token: v.string(),
});

type EmailDecisionClaim = {
  claimToken: string;
  token: string;
};

function calendarReconciliationToken(
  bookingId: Id<"bookings">,
  revision: number,
  attempt: number,
  now: number,
): string {
  return `reconcile:${String(bookingId)}:${revision}:${attempt}:${now}`;
}

function bookingError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function defaultRecurrenceCount(): number {
  const raw =
    process.env.BOOKING_RECURRENCE_DEFAULT_COUNT?.trim() || "12";
  const count = Number(raw);
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    count > MAX_RECURRENCE_OCCURRENCES
  ) {
    bookingError(
      "BOOKING_RECURRENCE_DEFAULT_COUNT_INVALID",
      `BOOKING_RECURRENCE_DEFAULT_COUNT must be an integer from 2 to ${MAX_RECURRENCE_OCCURRENCES}.`,
    );
  }
  return count;
}

function recurrenceLabel(frequency: RecurrenceFrequency): string {
  const labels: Record<RecurrenceFrequency, string> = {
    none: "No repeat",
    daily: "Daily",
    weekly_same_day: "Every week",
    biweekly_same_day: "Every 2 weeks",
    monthly_same_day: "Every month on the same day",
    monthly_same_date: "Every month on the same date",
  };
  return labels[frequency];
}

function requireAvailabilityCheckComplete(booking: Doc<"bookings">) {
  if (booking.availabilityCheckPending === true) {
    bookingError(
      "BOOKING_AVAILABILITY_CHECK_PENDING",
      "This request is saved, but its availability check has not completed. Wait for the automatic retry or retry the Jotform submission before editing or deciding it.",
    );
  }
}

function requireBookableVenue(room: string) {
  try {
    resolveBookableVenueSelection(room);
  } catch (error) {
    const retiredVenue =
      error instanceof Error &&
      error.message.includes(
        "GOOGLE_CALENDAR_VENUE_NOT_BOOKABLE",
      );
    bookingError(
      retiredVenue ? "VENUE_NOT_BOOKABLE" : "VENUE_UNSUPPORTED",
      retiredVenue
        ? "This room no longer accepts bookings. Choose another venue."
        : "That venue is not configured for room booking.",
    );
  }
}

function requireBookingDeletionIdle(
  booking: Doc<"bookings">,
  now = Date.now(),
) {
  if (bookingDeletionInProgress(booking, now)) {
    bookingError(
      "BOOKING_DELETION_IN_PROGRESS",
      "This booking is being removed. Wait for deletion to finish before changing or deciding it.",
    );
  }
}

async function requireTerminalDecisionActor(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  actorId: string,
  claim: EmailDecisionClaim | undefined,
) {
  const isEmailActor = actorId.startsWith("email:");
  if (!isEmailActor) {
    if (claim) {
      bookingError(
        "EMAIL_DECISION_ACTOR_INVALID",
        "An email decision claim cannot be used by this administrator.",
      );
    }
    return;
  }
  const rawToken = claim?.token.trim() ?? "";
  const claimToken = claim?.claimToken.trim() ?? "";
  if (!EMAIL_DECISION_TOKEN_PATTERN.test(rawToken) || !claimToken) {
    bookingError(
      "EMAIL_DECISION_CLAIM_LOST",
      "This approval attempt no longer owns the decision link.",
    );
  }
  const decisionToken = await ctx.db
    .query("emailDecisionTokens")
    .withIndex("by_token", (range) => range.eq("token", rawToken))
    .unique();
  const approver = decisionToken
    ? await ctx.db
        .query("approverEmails")
        .withIndex("by_email", (range) =>
          range.eq("email", decisionToken.approverEmail),
        )
        .unique()
    : null;
  const failure = terminalEmailDecisionClaimError(
    decisionToken
      ? {
          approverActive: approver?.active === true,
          bookingId: String(decisionToken.bookingId),
          claimExpiresAt: decisionToken.claimExpiresAt,
          claimToken: decisionToken.claimToken,
          expiresAt: decisionToken.expiresAt,
          revokedAt: decisionToken.revokedAt,
          usedAt: decisionToken.usedAt,
        }
      : null,
    {
      claimToken,
      expectedBookingId: String(bookingId),
      now: Date.now(),
    },
  );
  if (failure) bookingError(failure.code, failure.message);
  if (actorId !== `email:${decisionToken!.approverEmail}`) {
    bookingError(
      "EMAIL_DECISION_ACTOR_INVALID",
      "This approval attempt does not match the authorized approver.",
    );
  }
}

function publicBooking(booking: Doc<"bookings">) {
  return {
    _id: booking._id,
    jotformSubmissionId: booking.jotformSubmissionId,
    requesterName: booking.requesterName,
    requesterEmail: booking.requesterEmail,
    room: booking.room,
    startAt: booking.startAt,
    endAt: booking.endAt,
    timezone: booking.timezone,
    eventName: booking.eventName,
    purpose: booking.purpose,
    ministry: booking.ministry,
    recurrenceFrequency: booking.recurrenceFrequency ?? "none",
    recurrenceHasEndDate:
      (booking.recurrenceFrequency ?? "none") !== "none" &&
      (booking.recurrenceHasEndDate ??
        (booking.recurrenceUntilAt !== undefined)),
    recurrenceCount:
      booking.recurrenceCount ?? booking.occurrences?.length ?? 1,
    recurrenceUntilAt: booking.recurrenceUntilAt,
    occurrences:
      booking.occurrences ?? [
        {
          sequence: 0,
          startAt: booking.startAt,
          endAt: booking.endAt,
        },
      ],
    resolvedVenues: booking.resolvedVenues ?? [booking.room],
    formResponses: booking.formResponses,
    formResponsesTruncated: booking.formResponsesTruncated,
    formResponseCapturedCount: booking.formResponseCapturedCount,
    formResponseFieldCount: booking.formResponseFieldCount,
    status: booking.status,
    conflictBookingId: booking.conflictBookingId,
    conflictWarningBookingIds:
      booking.conflictWarningBookingIds ?? [],
    conflictWarningAcknowledgedAt:
      booking.conflictWarningAcknowledgedAt,
    reviewNote: booking.reviewNote,
    reviewedAt: booking.reviewedAt,
    availabilityCheckPending:
      booking.availabilityCheckPending === true,
    calendarAvailabilityStatus:
      booking.calendarAvailabilityStatus ?? "unchecked",
    calendarConflictSummary: booking.calendarConflictSummary,
    calendarSyncStatus: booking.calendarSyncStatus ?? "disabled",
    calendarSyncError: booking.calendarSyncError,
    calendarSyncedAt: booking.calendarSyncedAt,
    deletionInProgress: bookingDeletionInProgress(
      booking,
      Date.now(),
    ),
    deletionError: booking.deletionError,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
    revision: booking.revision ?? 0,
  };
}

function normalizeAdminName(value: string): string {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  if (!name) {
    bookingError(
      "REQUESTER_NAME_REQUIRED",
      "Requester name cannot be empty.",
    );
  }
  return name;
}

function normalizeAdminEmail(value: string): string {
  const email = value.trim().toLowerCase().slice(0, 254);
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    bookingError(
      "REQUESTER_EMAIL_INVALID",
      "Enter a valid requester email address.",
    );
  }
  return email;
}

function normalizeResponseValue(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_RESPONSE_VALUE_LENGTH);
}

function normalizePurpose(value: string | undefined): string | undefined {
  const purpose = value
    ?.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 2_000);
  return purpose || undefined;
}

function normalizeEventName(
  value: string | undefined,
): string | undefined {
  const eventName = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return eventName || undefined;
}

function normalizeMinistry(
  value: string | undefined,
): string | undefined {
  const ministry = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return ministry || undefined;
}

function updateCanonicalResponseValues(
  responses: Doc<"bookings">["formResponses"],
  values: {
    requesterName: string;
    requesterEmail: string;
    eventName?: string;
    purpose?: string;
    ministry?: string;
    recurrence?: {
      frequency: RecurrenceFrequency;
      hasEndDate: boolean;
      count: number;
      untilAt?: number;
      timezone: string;
    };
  },
) {
  return responses?.map((response) => {
    if (response.canonicalField === "requesterName") {
      return { ...response, value: values.requesterName };
    }
    if (response.canonicalField === "requesterEmail") {
      return { ...response, value: values.requesterEmail };
    }
    if (response.canonicalField === "eventName") {
      return { ...response, value: values.eventName ?? "" };
    }
    if (response.canonicalField === "purpose") {
      return { ...response, value: values.purpose ?? "" };
    }
    if (response.canonicalField === "ministry") {
      return { ...response, value: values.ministry ?? "" };
    }
    if (
      response.canonicalField === "recurrence" &&
      values.recurrence
    ) {
      return {
        ...response,
        value: recurrenceLabel(values.recurrence.frequency),
      };
    }
    if (
      response.canonicalField === "recurrenceHasEndDate" &&
      values.recurrence
    ) {
      return {
        ...response,
        value:
          values.recurrence.frequency === "none"
            ? "No"
            : values.recurrence.hasEndDate
              ? "Yes"
              : "No",
      };
    }
    if (
      response.canonicalField === "recurrenceCount" &&
      values.recurrence
    ) {
      return {
        ...response,
        value: String(values.recurrence.count),
      };
    }
    if (
      response.canonicalField === "recurrenceUntil" &&
      values.recurrence
    ) {
      const date =
        values.recurrence.untilAt === undefined
          ? ""
          : DateTime.fromMillis(values.recurrence.untilAt, {
              zone: values.recurrence.timezone,
            }).toISODate() ?? "";
      return { ...response, value: date };
    }
    return response;
  });
}

function validateBookingInput(input: BookingInput) {
  const room = input.room
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  const roomKey = normalizeRoomKey(room);
  if (!roomKey) {
    bookingError("ROOM_REQUIRED", "A room name is required.");
  }
  let resolvedVenues: string[];
  try {
    resolvedVenues = [...resolveVenueSelection(room).venues];
  } catch {
    bookingError(
      "VENUE_UNSUPPORTED",
      "That venue is not configured for room booking.",
    );
  }
  let occurrences: RecurrenceOccurrence[];
  try {
    occurrences = expandRecurrence({
      startAt: input.startAt,
      endAt: input.endAt,
      timezone: input.timezone,
      frequency: input.recurrenceFrequency ?? "none",
      count: input.recurrenceCount,
      untilAt: input.recurrenceUntilAt,
    });
  } catch (error) {
    bookingError(
      "INVALID_BOOKING_INTERVAL",
      error instanceof Error
        ? `The booking interval or repeat rule is invalid (${error.message}).`
        : "The booking interval or repeat rule is invalid.",
    );
  }
  try {
    assertSortedNonOverlappingOccurrences(occurrences);
    assertTotalClaimSlotsWithinLimit(
      occurrences,
      resolvedVenues.length,
      MAX_CLAIM_SLOTS_PER_BOOKING,
    );
    assertConflictLookupRangesWithinLimit(
      occurrences,
      conflictClaimRoomTargets(resolvedVenues).length,
    );
  } catch (error) {
    if (error instanceof BookingRuleError) {
      bookingError(error.code, error.message);
    }
    bookingError(
      "INVALID_BOOKING_INTERVAL",
      "The booking interval or repeat rule is invalid.",
    );
  }
  return { occurrences, resolvedVenues, room, roomKey };
}

function claimRoomKeysForVenue(targetVenue: string): string[] {
  const roomKeys = new Set([normalizeRoomKey(targetVenue)]);

  // v0.3 stored one claim under the submitted combined-room label. New
  // bookings fan out to physical A/B/C claims, but these aliases keep existing
  // pending or approved combined bookings protective during the in-place
  // upgrade.
  const legacyCombinations: Record<string, string[]> = {
    "Ministry Centre A": [
      "Ministry Centre A&B",
      "Ministry Centre A & B",
      "Ministry Center A&B",
      "Ministry Center A & B",
      "Ministry Centre ABC",
      "Ministry Center ABC",
      "Ministry Centre A, B & C",
      "Ministry Center A, B & C",
    ],
    "Ministry Centre B": [
      "Ministry Centre A&B",
      "Ministry Centre A & B",
      "Ministry Center A&B",
      "Ministry Center A & B",
      "Ministry Centre ABC",
      "Ministry Center ABC",
      "Ministry Centre A, B & C",
      "Ministry Center A, B & C",
    ],
    "Ministry Centre C": [
      "Ministry Centre ABC",
      "Ministry Center ABC",
      "Ministry Centre A, B & C",
      "Ministry Center A, B & C",
    ],
  };
  for (const legacyRoom of legacyCombinations[targetVenue] ?? []) {
    roomKeys.add(normalizeRoomKey(legacyRoom));
  }
  return [...roomKeys];
}

function conflictClaimRoomTargets(
  resolvedVenues: readonly string[],
) {
  return uniqueConflictClaimRoomTargets(
    resolvedVenues.flatMap((targetVenue) =>
      claimRoomKeysForVenue(targetVenue).map((roomKey) => ({
        roomKey,
        targetVenue,
      })),
    ),
  );
}

type BookingConflict = {
  booking: Doc<"bookings">;
  bookingId: Id<"bookings">;
  occurrenceSequence: number;
  targetVenue: string;
};

async function findConflicts(
  ctx: MutationCtx | QueryCtx,
  args: {
    occurrences: BookingOccurrence[];
    resolvedVenues: string[];
    excludeBookingId?: Id<"bookings">;
  },
): Promise<BookingConflict[]> {
  const claimRoomTargets = conflictClaimRoomTargets([
    ...args.resolvedVenues,
    ...args.occurrences.flatMap(
      (occurrence) => occurrence.resolvedVenues ?? [],
    ),
  ]);
  try {
    assertConflictLookupRangesWithinLimit(
      args.occurrences,
      claimRoomTargets.length,
    );
  } catch (error) {
    if (error instanceof BookingRuleError) {
      bookingError(error.code, error.message);
    }
    throw error;
  }

  const candidatesByBooking = new Map<
    string,
    Omit<BookingConflict, "booking">
  >();
  for (const occurrence of args.occurrences) {
    const occurrenceTargets = conflictClaimRoomTargets(
      occurrence.resolvedVenues ?? args.resolvedVenues,
    );
    for (const { roomKey, targetVenue } of occurrenceTargets) {
      for (const utcDay of utcDaysForInterval(
        occurrence.startAt,
        occurrence.endAt,
      )) {
        const candidates = await ctx.db
          .query("bookingClaims")
          .withIndex("by_room_day_start", (range) =>
            range
              .eq("roomKey", roomKey)
              .eq("utcDay", utcDay)
              .lt("startAt", occurrence.endAt),
          )
          .collect();
        for (const claim of candidates) {
          if (
            claim.bookingId === args.excludeBookingId ||
            claim.endAt <= occurrence.startAt
          ) {
            continue;
          }
          const key = String(claim.bookingId);
          if (!candidatesByBooking.has(key)) {
            candidatesByBooking.set(key, {
              bookingId: claim.bookingId,
              occurrenceSequence: occurrence.sequence,
              targetVenue,
            });
          }
        }
      }
    }
  }

  const conflicts: BookingConflict[] = [];
  for (const candidate of candidatesByBooking.values()) {
    const booking = await ctx.db.get(candidate.bookingId);
    // Claims are defensive indexes, not the authority. Ignore a stale claim
    // left behind by an older deployment or a terminal booking.
    if (
      booking &&
      (booking.status === "pending" || booking.status === "approved")
    ) {
      conflicts.push({ ...candidate, booking });
    }
  }
  return conflicts;
}

function uniqueBookingIds(
  ids: readonly Id<"bookings">[],
  excludeId?: Id<"bookings">,
): Id<"bookings">[] {
  const unique = new Map<string, Id<"bookings">>();
  for (const id of ids) {
    if (id !== excludeId) unique.set(String(id), id);
  }
  return [...unique.values()];
}

async function addReciprocalConflictWarnings(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  peerIds: readonly Id<"bookings">[],
  now: number,
) {
  for (const peerId of uniqueBookingIds(peerIds, bookingId)) {
    const peer = await ctx.db.get(peerId);
    if (!peer || peer.status !== "pending") continue;
    const nextIds = uniqueBookingIds(
      [...(peer.conflictWarningBookingIds ?? []), bookingId],
      peer._id,
    );
    await ctx.db.patch(peer._id, {
      conflictWarningBookingIds: nextIds,
      conflictWarningAcknowledgedAt: undefined,
      updatedAt: now,
      revision: (peer.revision ?? 0) + 1,
    });
  }
}

async function clearReciprocalConflictWarnings(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  now: number,
) {
  for (const peerId of uniqueBookingIds(
    booking.conflictWarningBookingIds ?? [],
    booking._id,
  )) {
    const peer = await ctx.db.get(peerId);
    if (!peer) continue;
    const existing = peer.conflictWarningBookingIds ?? [];
    const nextIds = uniqueBookingIds(
      existing.filter((id) => id !== booking._id),
      peer._id,
    );
    if (nextIds.length === existing.length) continue;
    await ctx.db.patch(peer._id, {
      conflictWarningBookingIds:
        nextIds.length > 0 ? nextIds : undefined,
      conflictWarningAcknowledgedAt: undefined,
      updatedAt: now,
      revision: (peer.revision ?? 0) + 1,
    });
  }
}

async function clearBlockingConflictReferences(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  now: number,
): Promise<number> {
  const peers = await ctx.db
    .query("bookings")
    .withIndex("by_conflict_booking", (query) =>
      query.eq("conflictBookingId", bookingId),
    )
    .collect();
  for (const peer of peers) {
    await ctx.db.patch(peer._id, {
      conflictBookingId: undefined,
      updatedAt: now,
      revision: (peer.revision ?? 0) + 1,
    });
  }
  return peers.length;
}

async function addClaims(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  args: {
    occurrences: BookingOccurrence[];
    resolvedVenues: string[];
  },
) {
  for (const occurrence of args.occurrences) {
    for (const targetVenue of
      occurrence.resolvedVenues ?? args.resolvedVenues) {
      const roomKey = normalizeRoomKey(targetVenue);
      for (const utcDay of utcDaysForInterval(
        occurrence.startAt,
        occurrence.endAt,
      )) {
        await ctx.db.insert("bookingClaims", {
          bookingId,
          roomKey,
          utcDay,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
          occurrenceSequence: occurrence.sequence,
          targetVenue,
        });
      }
    }
  }
}

async function removeClaims(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
) {
  const claims = await ctx.db
    .query("bookingClaims")
    .withIndex("by_booking", (range) => range.eq("bookingId", bookingId))
    .collect();
  for (const claim of claims) {
    await ctx.db.delete(claim._id);
  }
}

async function upsertJotformFieldCatalog(
  ctx: MutationCtx,
  formId: string,
  responses: Doc<"bookings">["formResponses"],
  now: number,
) {
  for (const response of responses ?? []) {
    const existing = await ctx.db
      .query("jotformFields")
      .withIndex("by_form_qid", (range) =>
        range.eq("formId", formId).eq("qid", response.qid),
      )
      .unique();
    const metadata = {
      name: response.name,
      label: response.label,
      type: response.type,
      order: response.order,
      canonicalField: response.canonicalField,
      lastSeenAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, metadata);
    } else {
      await ctx.db.insert("jotformFields", {
        formId,
        qid: response.qid,
        ...metadata,
        firstSeenAt: now,
      });
    }
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, "bookings.view");
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("desc")
      .take(300);
    return bookings.map(publicBooking);
  },
});

export const listConflictNotificationFeed = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, "bookings.view");
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_updated_at")
      .order("desc")
      .take(300);
    return bookings.map((booking) => ({
      _id: booking._id,
      requesterName: booking.requesterName,
      room: booking.room,
      revision: booking.revision ?? 0,
      updatedAt: booking.updatedAt,
      calendarAvailabilityStatus:
        booking.calendarAvailabilityStatus ?? "unchecked",
      calendarConflictSummary: booking.calendarConflictSummary,
      calendarSyncStatus: booking.calendarSyncStatus ?? "disabled",
      conflictWarningBookingIds:
        booking.conflictWarningBookingIds ?? [],
    }));
  },
});

export const overviewCounts = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, "bookings.view");
    const [pending, approved, unavailable] = await Promise.all([
      ctx.db
        .query("bookings")
        .withIndex("by_status", (range) => range.eq("status", "pending"))
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_status", (range) => range.eq("status", "approved"))
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_status", (range) =>
          range.eq("status", "unavailable"),
        )
        .collect(),
    ]);
    const conflictOverview = calculateConflictOverview(
      [...pending, ...approved, ...unavailable].map((booking) => ({
        _id: String(booking._id),
        status: booking.status,
        conflictBookingId: booking.conflictBookingId
          ? String(booking.conflictBookingId)
          : undefined,
        conflictWarningBookingIds:
          booking.conflictWarningBookingIds?.map(String),
        calendarAvailabilityStatus:
          booking.calendarAvailabilityStatus,
      })),
    );
    const availabilityChecking = pending.filter(
      (booking) => booking.availabilityCheckPending === true,
    ).length;
    return {
      pending: pending.length - availabilityChecking,
      availabilityChecking,
      approved: approved.length,
      unavailable: unavailable.length,
      ...conflictOverview,
    };
  },
});

export const listTable = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireCapability(ctx, "table.view");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    ) {
      bookingError(
        "TABLE_PAGE_SIZE_INVALID",
        "Request between 1 and 100 table rows at a time.",
      );
    }
    const result = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicBooking),
    };
  },
});

export const exportPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireCapability(ctx, "bookings.export");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    ) {
      bookingError(
        "EXPORT_PAGE_SIZE_INVALID",
        "Request between 1 and 100 export rows at a time.",
      );
    }
    const result = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicBooking),
    };
  },
});

export const listCalendarEmbeds = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, "bookings.view");
    const mapJson = process.env.GOOGLE_CALENDAR_VENUE_MAP_JSON;
    const timeZone =
      process.env.BOOKING_TIME_ZONE?.trim() || "Asia/Singapore";
    if (!mapJson?.trim()) {
      return { configured: false, timeZone, venues: [] };
    }
    let venueMap: ReturnType<typeof parseGoogleCalendarVenueMap>;
    try {
      venueMap = parseGoogleCalendarVenueMap(mapJson);
    } catch (error) {
      bookingError(
        "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
        error instanceof Error
          ? error.message
          : "The Google Calendar venue map is invalid.",
      );
    }
    return {
      configured: true,
      timeZone,
      venues: BOOKABLE_GOOGLE_CALENDAR_VENUES.map((venue) => ({
        venue,
        calendarIds: venueMap[venue],
      })),
    };
  },
});

// One-time, idempotent upgrade helper for deployments that already contain
// v0.3 claims under submitted room labels. It rewrites active reservations
// using the canonical physical venues (including A&B / ABC fan-out).
export const rebuildActiveClaimsPage = mutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    if (
      !isClaimMigrationPageSizeValid(
        args.paginationOpts.numItems,
      )
    ) {
      bookingError(
        "CLAIM_MIGRATION_PAGE_SIZE_INVALID",
        "Migrate between 1 and 2 bookings at a time.",
      );
    }
    const result = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("asc")
      .paginate(args.paginationOpts);
    let rebuilt = 0;
    let removed = 0;
    const skipped: Array<{
      bookingId: string;
      reason: string;
    }> = [];

    for (const booking of result.page) {
      if (booking.calendarSyncToken) {
        skipped.push({
          bookingId: String(booking._id),
          reason: "Google Calendar synchronization is in progress.",
        });
        continue;
      }
      if (
        booking.status !== "pending" &&
        booking.status !== "approved"
      ) {
        await removeClaims(ctx, booking._id);
        removed += 1;
        continue;
      }

      const recurrenceFrequency =
        booking.recurrenceFrequency ?? "none";
      let normalized: ReturnType<typeof validateBookingInput>;
      try {
        normalized = validateBookingInput({
          room: booking.room,
          startAt: booking.startAt,
          endAt: booking.endAt,
          timezone: booking.timezone,
          recurrenceFrequency,
          recurrenceCount:
            recurrenceFrequency === "none"
              ? 1
              : booking.recurrenceCount ??
                booking.occurrences?.length,
          recurrenceUntilAt: booking.recurrenceUntilAt,
        });
      } catch (error) {
        skipped.push({
          bookingId: String(booking._id),
          reason:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "The legacy booking could not be normalized.",
        });
        continue;
      }

      await removeClaims(ctx, booking._id);
      await addClaims(ctx, booking._id, normalized);
      const now = Date.now();
      await ctx.db.patch(booking._id, {
        room: normalized.room,
        roomKey: normalized.roomKey,
        recurrenceFrequency,
        recurrenceHasEndDate:
          recurrenceFrequency !== "none" &&
          (booking.recurrenceHasEndDate ??
            (booking.recurrenceUntilAt !== undefined)),
        recurrenceCount: normalized.occurrences.length,
        occurrences: normalized.occurrences,
        resolvedVenues: normalized.resolvedVenues,
        updatedAt: now,
        revision: (booking.revision ?? 0) + 1,
      });
      rebuilt += 1;
    }

    const now = Date.now();
    await ctx.db.insert("auditLogs", {
      level: skipped.length ? "warning" : "info",
      category: "booking",
      action: "booking_claims_rebuilt",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "booking_claim_migration",
      message: skipped.length
        ? "A page of legacy reservation claims was rebuilt with skipped bookings."
        : "A page of legacy reservation claims was rebuilt.",
      detailsJson: JSON.stringify({
        processed: result.page.length,
        rebuilt,
        removed,
        skipped,
        isDone: result.isDone,
      }),
      createdAt: now,
    });

    return {
      processed: result.page.length,
      rebuilt,
      removed,
      skipped,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const getInternal = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => await ctx.db.get(args.bookingId),
});

export const stageJotformSubmission = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    processingToken: v.string(),
    formId: v.string(),
    submissionId: v.string(),
    requesterName: v.string(),
    requesterEmail: v.string(),
    room: v.string(),
    startAt: v.number(),
    endAt: v.number(),
    timezone: v.string(),
    eventName: v.optional(v.string()),
    purpose: v.optional(v.string()),
    ministry: v.optional(v.string()),
    recurrenceFrequency: recurrenceFrequencyValidator,
    recurrenceHasEndDate: v.optional(v.boolean()),
    recurrenceCount: v.number(),
    recurrenceUntilAt: v.optional(v.number()),
    // Optional so a Jotform worker that started on v0.2 can finish during
    // the rolling deployment.
    formResponses: v.optional(v.array(jotformResponseValidator)),
    formResponsesTruncated: v.optional(v.boolean()),
    formResponseCapturedCount: v.optional(v.number()),
    formResponseFieldCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const expectedFormId = process.env.JOTFORM_FORM_ID?.trim();
    if (!expectedFormId || args.formId !== expectedFormId) {
      bookingError(
        "JOTFORM_FORM_MISMATCH",
        "The Jotform submission belongs to an unexpected form.",
      );
    }

    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) {
      bookingError(
        "JOTFORM_RECEIPT_NOT_FOUND",
        "The queued Jotform receipt no longer exists.",
      );
    }
    if (
      receipt.formId !== args.formId ||
      receipt.submissionId !== args.submissionId
    ) {
      bookingError(
        "JOTFORM_RECEIPT_MISMATCH",
        "The queued receipt does not match this submission.",
      );
    }
    if (
      receipt.state !== "processing" ||
      receipt.processingToken !== args.processingToken
    ) {
      bookingError(
        "JOTFORM_PROCESSING_LEASE_LOST",
        "This worker no longer owns the Jotform processing lease.",
      );
    }
    const now = Date.now();
    if (receipt.bookingId) {
      const existing = await ctx.db.get(receipt.bookingId);
      if (existing) {
        if (
          existing.jotformFormId !== args.formId ||
          existing.jotformSubmissionId !== args.submissionId
        ) {
          bookingError(
            "JOTFORM_BOOKING_MISMATCH",
            "The queued receipt points to a different booking.",
          );
        }
        if (existing.availabilityCheckPending !== true) {
          await ctx.db.patch(receipt._id, {
            state: "processed",
            lastError: undefined,
            processingStartedAt: undefined,
            processingToken: undefined,
          });
        }
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyBookingReceipt,
          { bookingId: existing._id },
        );
        return existing;
      }
    }

    const existingBySubmission = await ctx.db
      .query("bookings")
      .withIndex("by_submission_id", (range) =>
        range.eq("jotformSubmissionId", args.submissionId),
      )
      .unique();
    if (existingBySubmission) {
      const availabilityCompleted =
        existingBySubmission.availabilityCheckPending !== true;
      await ctx.db.patch(
        receipt._id,
        availabilityCompleted
          ? {
              state: "processed",
              bookingId: existingBySubmission._id,
              lastError: undefined,
              processingStartedAt: undefined,
              processingToken: undefined,
            }
          : {
              bookingId: existingBySubmission._id,
            },
      );
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyBookingReceipt,
        { bookingId: existingBySubmission._id },
      );
      return existingBySubmission;
    }

    await upsertJotformFieldCatalog(
      ctx,
      args.formId,
      args.formResponses,
      now,
    );

    requireBookableVenue(args.room);
    const {
      occurrences,
      resolvedVenues,
      room,
      roomKey,
    } = validateBookingInput(args);
    const bookingId = await ctx.db.insert("bookings", {
      source: "jotform",
      jotformFormId: args.formId,
      jotformSubmissionId: args.submissionId,
      requesterName: normalizeAdminName(args.requesterName),
      requesterEmail: normalizeAdminEmail(args.requesterEmail),
      room,
      roomKey,
      startAt: args.startAt,
      endAt: args.endAt,
      timezone: args.timezone,
      eventName: normalizeEventName(args.eventName),
      purpose: normalizePurpose(args.purpose),
      ministry: normalizeMinistry(args.ministry),
      recurrenceFrequency: args.recurrenceFrequency,
      recurrenceHasEndDate:
        args.recurrenceFrequency === "none"
          ? false
          : args.recurrenceHasEndDate ??
            (args.recurrenceUntilAt !== undefined),
      recurrenceCount: occurrences.length,
      recurrenceUntilAt: args.recurrenceUntilAt,
      occurrences,
      resolvedVenues,
      formResponses: args.formResponses,
      formResponsesTruncated: args.formResponsesTruncated,
      formResponseCapturedCount: args.formResponseCapturedCount,
      formResponseFieldCount: args.formResponseFieldCount,
      status: "pending",
      availabilityCheckPending: true,
      calendarAvailabilityStatus: "unchecked",
      calendarSyncStatus: "not_created",
      calendarSyncAttempts: 0,
      // Retained for an in-place upgrade from the old Google API mirror.
      sheetSyncStatus: "disabled",
      sheetSyncAttempts: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(receipt._id, {
      bookingId,
    });
    await ctx.db.insert("auditLogs", {
      level:
        args.formResponsesTruncated === true ? "warning" : "info",
      category: "jotform",
      action: "submission_persisted",
      actorType: "system",
      entityType: "booking",
      entityId: String(bookingId),
      message:
        args.formResponsesTruncated === true
          ? "The Jotform booking and requester receipt were staged before availability checking; its response snapshot was capped."
          : "The Jotform booking and requester receipt were staged before availability checking.",
      detailsJson: JSON.stringify({
        submissionId: args.submissionId,
        recurrenceFrequency: args.recurrenceFrequency,
        occurrenceCount: occurrences.length,
        resolvedVenues,
      }),
      createdAt: now,
    });
    // This durable fallback covers a worker that is terminated immediately
    // after staging. The action also creates the deduplicated delivery before
    // it starts Google FreeBusy, so the normal path does not wait for this
    // scheduled action.
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.notifyBookingReceipt,
      { bookingId },
    );
    return await ctx.db.get(bookingId);
  },
});

export const finalizeJotformSubmission = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    processingToken: v.string(),
    bookingId: v.id("bookings"),
    calendarIntegrationEnabled: v.boolean(),
    calendarAvailabilityStatus: v.union(
      v.literal("unchecked"),
      v.literal("available"),
      v.literal("conflict"),
    ),
    calendarConflictSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) {
      bookingError(
        "JOTFORM_RECEIPT_NOT_FOUND",
        "The queued Jotform receipt no longer exists.",
      );
    }
    if (
      receipt.state !== "processing" ||
      receipt.processingToken !== args.processingToken
    ) {
      bookingError(
        "JOTFORM_PROCESSING_LEASE_LOST",
        "This worker no longer owns the Jotform processing lease.",
      );
    }
    if (receipt.bookingId !== args.bookingId) {
      bookingError(
        "JOTFORM_BOOKING_MISMATCH",
        "The availability result does not match the staged booking.",
      );
    }
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.jotformFormId !== receipt.formId ||
      booking.jotformSubmissionId !== receipt.submissionId
    ) {
      bookingError(
        "JOTFORM_BOOKING_MISMATCH",
        "The staged booking no longer matches the queued submission.",
      );
    }
    const now = Date.now();
    if (bookingDeletionInProgress(booking, now)) {
      await ctx.db.patch(receipt._id, {
        state: "processed",
        lastError: undefined,
        processingStartedAt: undefined,
        processingToken: undefined,
      });
      return booking;
    }
    if (booking.availabilityCheckPending !== true) {
      await ctx.db.patch(receipt._id, {
        state: "processed",
        lastError: undefined,
        processingStartedAt: undefined,
        processingToken: undefined,
      });
      return booking;
    }

    const {
      occurrences,
      resolvedVenues,
    } = validateBookingInput({
      room: booking.room,
      startAt: booking.startAt,
      endAt: booking.endAt,
      timezone: booking.timezone,
      recurrenceFrequency:
        booking.recurrenceFrequency ?? "none",
      recurrenceCount:
        booking.recurrenceCount ??
        booking.occurrences?.length,
      recurrenceUntilAt: booking.recurrenceUntilAt,
    });
    const localConflicts = await findConflicts(ctx, {
      occurrences,
      resolvedVenues,
      excludeBookingId: booking._id,
    });
    const blockingConflict = localConflicts.find(
      (conflict) => conflict.booking.status === "approved",
    );
    const pendingConflicts = localConflicts.filter(
      (conflict) => conflict.booking.status === "pending",
    );
    const pendingConflictIds = uniqueBookingIds(
      pendingConflicts.map((conflict) => conflict.bookingId),
    );
    const hasCalendarConflict =
      args.calendarAvailabilityStatus === "conflict";
    const status =
      blockingConflict || hasCalendarConflict
        ? "unavailable"
        : "pending";
    const localConflictSummary = blockingConflict
      ? `${blockingConflict.targetVenue} overlaps an approved RoomOps booking.`
      : undefined;
    const storedConflictSummary =
      args.calendarConflictSummary?.slice(0, 1_000) ??
      localConflictSummary;

    await ctx.db.patch(booking._id, {
      status,
      availabilityCheckPending: false,
      conflictBookingId: blockingConflict?.bookingId,
      conflictWarningBookingIds:
        status === "pending" && pendingConflictIds.length > 0
          ? pendingConflictIds
          : undefined,
      conflictWarningAcknowledgedAt: undefined,
      calendarAvailabilityStatus:
        status === "unavailable"
          ? "conflict"
          : args.calendarAvailabilityStatus,
      calendarConflictSummary: storedConflictSummary,
      calendarSyncStatus: args.calendarIntegrationEnabled
        ? status === "unavailable"
          ? "conflict"
          : "not_created"
        : "disabled",
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });

    if (status === "pending") {
      await addClaims(ctx, booking._id, {
        occurrences,
        resolvedVenues,
      });
      if (pendingConflictIds.length > 0) {
        await addReciprocalConflictWarnings(
          ctx,
          booking._id,
          pendingConflictIds,
          now,
        );
      }
    }

    await ctx.db.patch(receipt._id, {
      state: "processed",
      lastError: undefined,
      processingStartedAt: undefined,
      processingToken: undefined,
    });
    const snapshotCapped =
      booking.formResponsesTruncated === true;
    const hasPendingWarning =
      status === "pending" && pendingConflictIds.length > 0;
    const hasBlockingConflict =
      Boolean(blockingConflict) || hasCalendarConflict;
    const message = hasBlockingConflict
      ? snapshotCapped
        ? "Jotform submission was marked unavailable because a requested occurrence is already booked; its response snapshot was also capped."
        : hasCalendarConflict
          ? "Jotform submission was automatically marked unavailable because Google Calendar reports a busy venue."
          : "Jotform submission was automatically marked unavailable because it overlaps an approved RoomOps booking."
      : hasPendingWarning
        ? snapshotCapped
          ? "Jotform submission remains pending with an overlap warning against another pending request; its response snapshot was also capped."
          : "Jotform submission remains pending and both requests were marked with an overlap warning."
        : snapshotCapped
          ? "Jotform submission was accepted as a pending booking, but its response snapshot was capped."
          : "Jotform submission was accepted as a pending booking.";
    await ctx.db.insert("auditLogs", {
      level:
        hasBlockingConflict || hasPendingWarning || snapshotCapped
          ? "warning"
          : "info",
      category: "jotform",
      action: "submission_processed",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message,
      detailsJson: JSON.stringify({
        submissionId: booking.jotformSubmissionId,
        status,
        recurrenceFrequency:
          booking.recurrenceFrequency ?? "none",
        occurrenceCount: occurrences.length,
        resolvedVenues,
        conflictBookingId: blockingConflict
          ? String(blockingConflict.bookingId)
          : undefined,
        pendingConflictBookingIds: pendingConflictIds.map(String),
        conflictOccurrenceSequence:
          blockingConflict?.occurrenceSequence,
        conflictTargetVenue: blockingConflict?.targetVenue,
        calendarAvailabilityStatus:
          args.calendarAvailabilityStatus,
        responseSnapshot: {
          storedFields:
            booking.formResponseCapturedCount ??
            booking.formResponses?.length ??
            0,
          totalFields:
            booking.formResponseFieldCount ??
            booking.formResponses?.length ??
            0,
          truncated: snapshotCapped,
        },
      }),
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.notifyBookingAvailabilityCompleted,
      { bookingId: booking._id },
    );
    const relatedConflictIds = uniqueBookingIds([
      ...(blockingConflict ? [blockingConflict.bookingId] : []),
      ...pendingConflictIds,
    ]);
    if (hasBlockingConflict || hasPendingWarning) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyConflictAlert,
        {
          bookingId: booking._id,
          relatedBookingIds: relatedConflictIds,
        },
      );
    }

    return await ctx.db.get(booking._id);
  },
});

export const saveTableEdits = mutation({
  args: {
    clientRequestId: v.string(),
    edits: v.array(
      v.object({
        bookingId: v.id("bookings"),
        expectedRevision: v.number(),
        requesterName: v.string(),
        requesterEmail: v.string(),
        eventName: v.optional(v.string()),
        purpose: v.optional(v.string()),
        ministry: v.optional(v.string()),
        responseEdits: v.array(
          v.object({
            qid: v.string(),
            value: v.string(),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "table.edit");
    const clientRequestId = args.clientRequestId.trim().slice(0, 120);
    if (!clientRequestId) {
      bookingError(
        "TABLE_EDIT_REQUEST_ID_REQUIRED",
        "A table edit request ID is required.",
      );
    }
    if (
      args.edits.length === 0 ||
      args.edits.length > MAX_TABLE_EDITS
    ) {
      bookingError(
        "TABLE_EDIT_BATCH_INVALID",
        `Save between 1 and ${MAX_TABLE_EDITS} changed bookings at a time.`,
      );
    }

    const duplicateCheck = new Set<string>();
    const planned: Array<{
      bookingId: Id<"bookings">;
      requesterName: string;
      requesterEmail: string;
      eventName?: string;
      purpose?: string;
      ministry?: string;
      formResponses: Doc<"bookings">["formResponses"];
      previousRevision: number;
      calendarSyncAttempts: number;
      shouldReconcileCalendar: boolean;
      changedFields: string[];
    }> = [];
    const catalogCache = new Map<
      string,
      Doc<"jotformFields"> | null
    >();
    const getCatalogField = async (
      formId: string,
      qid: string,
    ) => {
      const key = `${formId}:${qid}`;
      const cached = catalogCache.get(key);
      if (cached !== undefined) return cached;
      const field = await ctx.db
        .query("jotformFields")
        .withIndex("by_form_qid", (range) =>
          range.eq("formId", formId).eq("qid", qid),
        )
        .unique();
      catalogCache.set(key, field);
      return field;
    };

    for (const edit of args.edits) {
      const bookingKey = String(edit.bookingId);
      if (duplicateCheck.has(bookingKey)) {
        bookingError(
          "TABLE_EDIT_DUPLICATE_BOOKING",
          "Each booking may appear only once in a save request.",
        );
      }
      duplicateCheck.add(bookingKey);
      if (
        edit.responseEdits.length >
        MAX_RESPONSE_EDITS_PER_BOOKING
      ) {
        bookingError(
          "TABLE_EDIT_TOO_MANY_FIELDS",
          `Change at most ${MAX_RESPONSE_EDITS_PER_BOOKING} dynamic fields per booking.`,
        );
      }

      const booking = await ctx.db.get(edit.bookingId);
      if (!booking) {
        bookingError(
          "BOOKING_NOT_FOUND",
          "A booking in this table no longer exists.",
        );
      }
      requireAvailabilityCheckComplete(booking);
      requireBookingDeletionIdle(booking);
      if (booking.calendarSyncToken) {
        bookingError(
          "CALENDAR_SYNC_IN_PROGRESS",
          "Wait for the current Google Calendar approval operation to finish before editing this booking.",
        );
      }
      const previousRevision = booking.revision ?? 0;
      if (previousRevision !== edit.expectedRevision) {
        bookingError(
          "TABLE_EDIT_CONFLICT",
          "A booking changed after edit mode was opened. Reload the table and review that row before saving.",
        );
      }

      const requesterName = normalizeAdminName(edit.requesterName);
      const requesterEmail = normalizeAdminEmail(edit.requesterEmail);
      const eventName = normalizeEventName(edit.eventName);
      const purpose = normalizePurpose(edit.purpose);
      const ministry = normalizeMinistry(edit.ministry);
      const responseChanges = new Map<string, string>();
      const responseAdditions = new Map<
        string,
        Doc<"jotformFields">
      >();
      for (const responseEdit of edit.responseEdits) {
        const qid = responseEdit.qid.trim();
        if (
          !/^\d{1,20}$/.test(qid) ||
          responseChanges.has(qid)
        ) {
          bookingError(
            "DYNAMIC_FIELD_INVALID",
            "Every dynamic field change must use one existing numeric Jotform question ID.",
          );
        }
        const existing = booking.formResponses?.find(
          (response) => response.qid === qid,
        );
        const catalogField = await getCatalogField(
          booking.jotformFormId,
          qid,
        );
        if (
          existing?.canonicalField ||
          (!existing && catalogField?.canonicalField)
        ) {
          bookingError(
            "DYNAMIC_FIELD_PROTECTED",
            "Core booking fields cannot be changed through a dynamic table column.",
          );
        }
        if (!existing) {
          if (!catalogField) {
            bookingError(
              "DYNAMIC_FIELD_NOT_FOUND",
              "That question is not in the Jotform field catalog for this booking.",
            );
          }
          responseAdditions.set(qid, catalogField);
        }
        responseChanges.set(
          qid,
          normalizeResponseValue(responseEdit.value),
        );
      }

      let formResponses = updateCanonicalResponseValues(
        booking.formResponses,
        {
          requesterName,
          requesterEmail,
          eventName,
          purpose,
          ministry,
        },
      );
      formResponses = formResponses?.map((response) =>
        responseChanges.has(response.qid)
          ? {
              ...response,
              value: responseChanges.get(response.qid) ?? "",
            }
          : response,
      );
      if (responseAdditions.size > 0) {
        const nextResponses = [...(formResponses ?? [])];
        if (
          nextResponses.length + responseAdditions.size >
          MAX_STORED_RESPONSES_PER_BOOKING
        ) {
          bookingError(
            "DYNAMIC_FIELD_LIMIT_REACHED",
            `A booking may store at most ${MAX_STORED_RESPONSES_PER_BOOKING} Jotform response fields.`,
          );
        }
        for (const [qid, catalogField] of responseAdditions) {
          nextResponses.push({
            qid,
            name: catalogField.name,
            label: catalogField.label,
            type: catalogField.type,
            order: catalogField.order,
            value: responseChanges.get(qid) ?? "",
          });
        }
        formResponses = nextResponses;
      }

      const changedFields: string[] = [];
      if (requesterName !== booking.requesterName) {
        changedFields.push("requesterName");
      }
      if (requesterEmail !== booking.requesterEmail) {
        changedFields.push("requesterEmail");
      }
      if (eventName !== booking.eventName) {
        changedFields.push("eventName");
      }
      if (purpose !== booking.purpose) {
        changedFields.push("purpose");
      }
      if (ministry !== booking.ministry) {
        changedFields.push("ministry");
      }
      for (const [qid, value] of responseChanges) {
        const previousResponse = booking.formResponses?.find(
          (response) => response.qid === qid,
        );
        if (!previousResponse || value !== previousResponse.value) {
          changedFields.push(`jotform:${qid}`);
        }
      }
      if (changedFields.length === 0) continue;

      planned.push({
        bookingId: booking._id,
        requesterName,
        requesterEmail,
        eventName,
        purpose,
        ministry,
        formResponses,
        previousRevision,
        calendarSyncAttempts: booking.calendarSyncAttempts ?? 0,
        shouldReconcileCalendar:
          booking.status === "approved" &&
          (booking.calendarEvents?.length ?? 0) > 0 &&
          (requesterName !== booking.requesterName ||
            eventName !== booking.eventName ||
            purpose !== booking.purpose ||
            ministry !== booking.ministry),
        changedFields,
      });
    }

    const now = Date.now();
    for (const change of planned) {
      const newRevision = change.previousRevision + 1;
      const nextCalendarAttempt = change.calendarSyncAttempts + 1;
      const syncToken = change.shouldReconcileCalendar
        ? calendarReconciliationToken(
            change.bookingId,
            newRevision,
            nextCalendarAttempt,
            now,
          )
        : undefined;
      await ctx.db.patch(change.bookingId, {
        requesterName: change.requesterName,
        requesterEmail: change.requesterEmail,
        eventName: change.eventName,
        purpose: change.purpose,
        ministry: change.ministry,
        formResponses: change.formResponses,
        sheetRequesterName: undefined,
        sheetRequesterEmail: undefined,
        sheetPurpose: undefined,
        updatedAt: now,
        revision: newRevision,
        ...(change.shouldReconcileCalendar
          ? {
              calendarSyncStatus: "creating" as const,
              calendarSyncError: undefined,
              calendarSyncAttempts: nextCalendarAttempt,
              calendarSyncToken: syncToken,
              calendarSyncLeaseExpiresAt:
                now + CALENDAR_SYNC_LEASE_MS,
            }
          : {}),
        sheetSyncStatus: "disabled",
        sheetSyncAttempts: 0,
        sheetSyncError: undefined,
        sheetSyncLeaseToken: undefined,
        sheetSyncLeaseExpiresAt: undefined,
      });
      await ctx.db.insert("auditLogs", {
        level: "info",
        category: "booking",
        action: "booking_table_edited",
        actorType: "user",
        actorId: user.clerkUserId,
        entityType: "booking",
        entityId: String(change.bookingId),
        message: "Booking table fields were edited and saved to Convex.",
        detailsJson: JSON.stringify({
          clientRequestId,
          previousRevision: change.previousRevision,
          newRevision,
          changedFields: change.changedFields,
        }),
        createdAt: now,
      });
      if (change.shouldReconcileCalendar) {
        await ctx.scheduler.runAfter(
          0,
          internal.googleCalendar.reconcileApprovedBooking,
          {
            bookingId: change.bookingId,
            expectedRevision: newRevision,
            syncToken: syncToken!,
          },
        );
        await ctx.scheduler.runAfter(
          CALENDAR_SYNC_LEASE_MS,
          internal.bookings.recoverCalendarSyncLease,
          {
            bookingId: change.bookingId,
            syncToken: syncToken!,
          },
        );
      }
    }

    return { updated: planned.length };
  },
});

async function deleteBookingRecord(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  actorId: string,
) {
  const decisionTokens = await ctx.db
    .query("emailDecisionTokens")
    .withIndex("by_booking", (query) =>
      query.eq("bookingId", booking._id),
    )
    .collect();
  const deliveries = await ctx.db
    .query("emailDeliveries")
    .withIndex("by_booking", (query) =>
      query.eq("bookingId", booking._id),
    )
    .collect();
  const receipt = await ctx.db
    .query("externalSubmissions")
    .withIndex("by_provider_submission", (query) =>
      query
        .eq("provider", "jotform")
        .eq("formId", booking.jotformFormId)
        .eq("submissionId", booking.jotformSubmissionId),
    )
    .unique();
  const now = Date.now();
  let cancelledDeliveryCount = 0;

  for (const delivery of deliveries) {
    const outstanding =
      delivery.status !== "sent" &&
      delivery.status !== "cancelled";
    if (outstanding) cancelledDeliveryCount += 1;
    await ctx.db.patch(delivery._id, {
      decisionTokenId: undefined,
      ...(outstanding
        ? {
            status: "cancelled" as const,
            lastError: "BOOKING_DELETED_BY_ADMIN",
            leaseToken: undefined,
            leaseExpiresAt: undefined,
            nextAttemptAt: undefined,
          }
        : {}),
      updatedAt: now,
    });
  }
  for (const token of decisionTokens) {
    await ctx.db.delete(token._id);
  }
  if (receipt?.bookingId === booking._id) {
    await ctx.db.patch(receipt._id, {
      bookingId: undefined,
      state: "processed",
      processingStartedAt: undefined,
      processingToken: undefined,
      lastError: undefined,
      lastReceivedAt: now,
    });
  }

  await clearReciprocalConflictWarnings(ctx, booking, now);
  const clearedBlockingConflictReferenceCount =
    await clearBlockingConflictReferences(ctx, booking._id, now);
  await removeClaims(ctx, booking._id);
  await ctx.db.insert("auditLogs", {
    level: "warning",
    category: "booking",
    action: "booking_deleted",
    actorType: "user",
    actorId,
    entityType: "booking",
    entityId: String(booking._id),
    message:
      "A booking and all of its RoomOps-managed Google Calendar events were deleted.",
    detailsJson: JSON.stringify({
      submissionId: booking.jotformSubmissionId,
      status: booking.status,
      previousRevision: booking.revision ?? 0,
      calendarEventCount: managedCalendarEventsForDeletion(
        booking.calendarEvents,
        booking.calendarAttemptedEvents,
      ).length,
      invalidatedEmailDecisionTokenCount: decisionTokens.length,
      cancelledEmailDeliveryCount: cancelledDeliveryCount,
      clearedBlockingConflictReferenceCount,
      externalSubmissionDetached:
        receipt?.bookingId === booking._id,
    }),
    createdAt: now,
  });
  await ctx.db.delete(booking._id);
}

export const beginBookingDeletion = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    actorId: v.string(),
    deletionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    const now = Date.now();
    if (bookingDeletionInProgress(booking, now)) {
      bookingError(
        "BOOKING_DELETION_IN_PROGRESS",
        "This booking is already being removed.",
      );
    }
    const previousRevision = booking.revision ?? 0;
    if (
      !Number.isInteger(args.expectedRevision) ||
      args.expectedRevision !== previousRevision
    ) {
      bookingError(
        "BOOKING_DELETE_CONFLICT",
        "This booking changed after the page loaded. Review the latest row before deleting it.",
      );
    }
    if (
      booking.calendarSyncToken &&
      (booking.calendarSyncLeaseExpiresAt ?? 0) > now
    ) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "Wait for the current Google Calendar operation to finish before deleting this booking.",
      );
    }
    const deliveries = await ctx.db
      .query("emailDeliveries")
      .withIndex("by_booking", (query) =>
        query.eq("bookingId", booking._id),
      )
      .collect();
    if (hasActiveEmailDeliveryLease(deliveries, now)) {
      bookingError(
        "EMAIL_DELIVERY_IN_PROGRESS",
        "Wait for the current booking email delivery to finish before deleting this booking.",
      );
    }
    const deletionToken = args.deletionToken.trim();
    if (!deletionToken) {
      bookingError(
        "BOOKING_DELETE_TOKEN_INVALID",
        "A deletion ownership token is required.",
      );
    }
    await ctx.db.patch(booking._id, {
      deletionToken,
      deletionLeaseExpiresAt: now + BOOKING_DELETION_LEASE_MS,
      deletionAttempts: (booking.deletionAttempts ?? 0) + 1,
      deletionError: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      BOOKING_DELETION_LEASE_MS,
      internal.bookings.recoverBookingDeletionLease,
      {
        bookingId: booking._id,
        deletionToken,
      },
    );
    await ctx.db.insert("auditLogs", {
      level: "info",
      category: "booking",
      action: "booking_deletion_started",
      actorType: "user",
      actorId: args.actorId,
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "An administrator started safe booking and Calendar deletion.",
      detailsJson: JSON.stringify({
        attempt: (booking.deletionAttempts ?? 0) + 1,
        calendarEventCount: managedCalendarEventsForDeletion(
          booking.calendarEvents,
          booking.calendarAttemptedEvents,
        ).length,
        expectedRevision: args.expectedRevision,
      }),
      createdAt: now,
    });
    return {
      booking,
      events: managedCalendarEventsForDeletion(
        booking.calendarEvents,
        booking.calendarAttemptedEvents,
      ),
    };
  },
});

export const completeBookingDeletion = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    deletionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return { deleted: false };
    if (booking.deletionToken !== args.deletionToken) {
      bookingError(
        "BOOKING_DELETE_LEASE_LOST",
        "This deletion attempt no longer owns the booking.",
      );
    }
    if ((booking.deletionLeaseExpiresAt ?? 0) <= Date.now()) {
      bookingError(
        "BOOKING_DELETE_LEASE_EXPIRED",
        "This deletion worker lease expired before it could finish. Retry deletion.",
      );
    }
    await deleteBookingRecord(ctx, booking, args.actorId);
    return { deleted: true };
  },
});

export const failBookingDeletion = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    deletionToken: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.deletionToken !== args.deletionToken) {
      return;
    }
    const now = Date.now();
    const message =
      args.errorMessage
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 1_000) || "BOOKING_DELETE_FAILED";
    await ctx.db.patch(booking._id, {
      deletionToken: undefined,
      deletionLeaseExpiresAt: undefined,
      deletionError: message,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "booking",
      action: "booking_deletion_failed",
      actorType: "user",
      actorId: args.actorId,
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "The booking was retained because its managed Calendar events could not all be deleted safely.",
      detailsJson: JSON.stringify({
        attempt: booking.deletionAttempts ?? 1,
        error: message,
      }),
      createdAt: now,
    });
  },
});

export const recoverBookingDeletionLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    deletionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    const now = Date.now();
    if (
      !booking ||
      booking.deletionToken !== args.deletionToken
    ) {
      return;
    }
    const leaseExpiresAt = booking.deletionLeaseExpiresAt ?? 0;
    if (leaseExpiresAt > now) {
      await ctx.scheduler.runAfter(
        leaseExpiresAt - now + 1_000,
        internal.bookings.recoverBookingDeletionLease,
        args,
      );
      return;
    }
    const message =
      "Safe booking deletion did not finish before its worker lease expired. Retry deletion; already-removed Calendar events will be handled safely.";
    await ctx.db.patch(booking._id, {
      deletionToken: undefined,
      deletionLeaseExpiresAt: undefined,
      deletionError: message,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "booking",
      action: "booking_deletion_lease_expired",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message,
      detailsJson: JSON.stringify({
        attempt: booking.deletionAttempts ?? 1,
      }),
      createdAt: now,
    });
  },
});

// Compatibility for an older browser. Rows with any managed or attempted
// Calendar reference must use googleCalendar.deleteBooking, which verifies
// event ownership and ETags before deleting the Convex record.
export const deleteTableRow = mutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "table.edit");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      return { deleted: false };
    }
    requireAvailabilityCheckComplete(booking);
    requireBookingDeletionIdle(booking);
    if (booking.calendarSyncToken) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "Wait for the current Google Calendar operation to finish before deleting this row.",
      );
    }
    if (
      managedCalendarEventsForDeletion(
        booking.calendarEvents,
        booking.calendarAttemptedEvents,
      ).length > 0
    ) {
      bookingError(
        "BOOKING_DELETE_ACTION_REQUIRED",
        "Refresh RoomOps and delete this booking again so every managed Google Calendar event is removed safely.",
      );
    }
    const previousRevision = booking.revision ?? 0;
    if (previousRevision !== args.expectedRevision) {
      bookingError(
        "TABLE_DELETE_CONFLICT",
        "This booking changed after the table loaded. Reload the table before deleting it.",
      );
    }

    await deleteBookingRecord(ctx, booking, user.clerkUserId);
    return { deleted: true };
  },
});

export const recordXlsxExport = mutation({
  args: {
    clientRequestId: v.string(),
    rowCount: v.number(),
    columnCount: v.number(),
    truncated: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "bookings.export");
    const clientRequestId = args.clientRequestId.trim().slice(0, 120);
    if (
      !clientRequestId ||
      !Number.isInteger(args.rowCount) ||
      args.rowCount < 0 ||
      args.rowCount > 10_000 ||
      !Number.isInteger(args.columnCount) ||
      args.columnCount < 1 ||
      args.columnCount > 200
    ) {
      bookingError(
        "EXPORT_AUDIT_INVALID",
        "The workbook export summary is invalid.",
      );
    }
    await ctx.db.insert("auditLogs", {
      level: args.truncated ? "warning" : "info",
      category: "booking",
      action: "bookings_xlsx_exported",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "booking_export",
      entityId: clientRequestId,
      message: args.truncated
        ? "A capped RoomOps booking workbook was downloaded."
        : "A RoomOps booking workbook was downloaded.",
      detailsJson: JSON.stringify({
        rowCount: args.rowCount,
        columnCount: args.columnCount,
        truncated: args.truncated,
      }),
      createdAt: Date.now(),
    });
  },
});

async function rejectPendingBooking(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  actorId: string,
  note: string | undefined,
  calendarCleanupToken?: string,
) {
  requireAvailabilityCheckComplete(booking);
  requireBookingDeletionIdle(booking);
  if (booking.status !== "pending") {
    bookingError(
      "INVALID_BOOKING_STATE",
      "Only a pending booking can be rejected.",
    );
  }
  const ownsCalendarCleanup =
    Boolean(calendarCleanupToken) &&
    booking.calendarSyncToken === calendarCleanupToken;
  if (
    booking.calendarSyncStatus === "creating" &&
    (booking.calendarSyncLeaseExpiresAt ?? 0) > Date.now() &&
    !ownsCalendarCleanup
  ) {
    bookingError(
      "CALENDAR_SYNC_IN_PROGRESS",
      "Wait for the current Google Calendar operation to finish before rejecting this booking.",
    );
  }
  if (
    (booking.calendarAttemptedEvents?.length ?? 0) > 0 &&
    !ownsCalendarCleanup
  ) {
    bookingError(
      "CALENDAR_CLEANUP_ACTION_REQUIRED",
      "Refresh RoomOps and reject this request again so its incomplete Google Calendar attempt can be cleaned safely.",
    );
  }
  const now = Date.now();
  await clearReciprocalConflictWarnings(ctx, booking, now);
  await removeClaims(ctx, booking._id);
  await ctx.db.patch(booking._id, {
    status: "rejected",
    conflictWarningBookingIds: undefined,
    conflictWarningAcknowledgedAt: undefined,
    reviewNote: note?.trim().slice(0, 1_000) || undefined,
    reviewedAt: now,
    reviewedBy: actorId,
    updatedAt: now,
    revision: (booking.revision ?? 0) + 1,
    calendarSyncStatus:
      booking.calendarSyncStatus === "disabled"
        ? "disabled"
        : "not_created",
    calendarSyncError: undefined,
    calendarSyncToken: undefined,
    calendarSyncLeaseExpiresAt: undefined,
    calendarAttemptedEvents: undefined,
    sheetSyncStatus: "disabled",
    sheetSyncAttempts: 0,
    sheetSyncError: undefined,
    sheetSyncLeaseToken: undefined,
    sheetSyncLeaseExpiresAt: undefined,
  });
  await ctx.db.insert("auditLogs", {
    level: "info",
    category: "booking",
    action: "booking_rejected",
    actorType: "user",
    actorId,
    entityType: "booking",
    entityId: String(booking._id),
    message: `${booking.room} booking was rejected.`,
    detailsJson: JSON.stringify({
      submissionId: booking.jotformSubmissionId,
      occurrenceCount: booking.occurrences?.length ?? 1,
    }),
    createdAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.emailNotifications.notifyBookingDecision,
    { bookingId: booking._id },
  );
}

// Kept for one release so an older browser can still reject a request.
// Approval must use googleCalendar.decide so it cannot bypass event creation.
export const decide = mutation({
  args: {
    bookingId: v.id("bookings"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "bookings.approve");
    if (args.decision === "approve") {
      bookingError(
        "CALENDAR_APPROVAL_ACTION_REQUIRED",
        "Refresh RoomOps before approving. Approval now creates the Google Calendar event first.",
      );
    }
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    await rejectPendingBooking(
      ctx,
      booking,
      user.clerkUserId,
      args.note,
    );
  },
});

export const rejectPending = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    note: v.optional(v.string()),
    emailDecisionClaim: v.optional(emailDecisionClaimValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    await requireTerminalDecisionActor(
      ctx,
      booking._id,
      args.actorId,
      args.emailDecisionClaim,
    );
    await rejectPendingBooking(
      ctx,
      booking,
      args.actorId,
      args.note,
    );
  },
});

export const rejectPendingAfterCalendarCleanup = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    note: v.optional(v.string()),
    syncToken: v.string(),
    emailDecisionClaim: v.optional(emailDecisionClaimValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    if (
      booking.status !== "pending" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      bookingError(
        "CALENDAR_SYNC_LEASE_LOST",
        "This Calendar cleanup no longer owns the pending booking.",
      );
    }
    await requireTerminalDecisionActor(
      ctx,
      booking._id,
      args.actorId,
      args.emailDecisionClaim,
    );
    await rejectPendingBooking(
      ctx,
      booking,
      args.actorId,
      args.note,
      args.syncToken,
    );
  },
});

type BeginCalendarApprovalArgs = {
  bookingId: Id<"bookings">;
  actorId: string;
  syncToken: string;
  purpose: "approve" | "cleanup";
  confirmConflicts?: boolean;
  dispatchInBackground?: boolean;
  note?: string;
  emailDecisionClaim?: EmailDecisionClaim;
};

async function prepareCalendarApproval(
  ctx: MutationCtx,
  args: BeginCalendarApprovalArgs,
) {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    requireAvailabilityCheckComplete(booking);
    requireBookingDeletionIdle(booking);
    if (booking.status !== "pending") {
      bookingError(
        "INVALID_BOOKING_STATE",
        "Only a pending booking can be approved.",
      );
    }
    await requireTerminalDecisionActor(
      ctx,
      booking._id,
      args.actorId,
      args.emailDecisionClaim,
    );
    const now = Date.now();
    const dispatchInBackground =
      args.purpose === "approve" &&
      args.dispatchInBackground === true &&
      args.emailDecisionClaim === undefined;
    const backgroundNote =
      args.note?.trim().slice(0, 1_000) || undefined;
    if (
      booking.calendarSyncStatus === "creating" &&
      (booking.calendarSyncLeaseExpiresAt ?? 0) > now
    ) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "This booking is already being checked and added to Google Calendar.",
      );
    }
    if (args.purpose === "approve") {
      requireBookableVenue(booking.room);
      const occurrences =
        booking.occurrences ?? [
          {
            sequence: 0,
            startAt: booking.startAt,
            endAt: booking.endAt,
          },
        ];
      const conflicts = await findConflicts(ctx, {
        occurrences,
        resolvedVenues: booking.resolvedVenues ?? [booking.room],
        excludeBookingId: booking._id,
      });
      const approvedConflict = conflicts.find(
        (conflict) => conflict.booking.status === "approved",
      );
      if (approvedConflict) {
        if (needsCalendarAttemptCleanup(booking)) {
          await ctx.db.patch(booking._id, {
            calendarSyncStatus: "creating",
            calendarSyncError: undefined,
            calendarSyncAttempts:
              (booking.calendarSyncAttempts ?? 0) + 1,
            calendarSyncToken: args.syncToken,
            calendarSyncLeaseExpiresAt:
              now + CALENDAR_SYNC_LEASE_MS,
            updatedAt: now,
          });
          await ctx.scheduler.runAfter(
            CALENDAR_SYNC_LEASE_MS,
            internal.bookings.recoverCalendarSyncLease,
            {
              bookingId: booking._id,
              syncToken: args.syncToken,
            },
          );
          if (dispatchInBackground) {
            await ctx.scheduler.runAfter(
              0,
              internal.googleCalendar.processCalendarApproval,
              {
                bookingId: booking._id,
                actorId: args.actorId,
                syncToken: args.syncToken,
                note: backgroundNote,
                approvedConflictBookingId:
                  approvedConflict.bookingId,
              },
            );
          }
          return {
            started: false as const,
            reason:
              "approved_conflict_cleanup_required" as const,
            conflictBookingId: approvedConflict.bookingId,
            booking,
          };
        }
        const conflictSummary = `${approvedConflict.targetVenue} overlaps an approved RoomOps booking.`;
        await clearReciprocalConflictWarnings(ctx, booking, now);
        await removeClaims(ctx, booking._id);
        await ctx.db.patch(booking._id, {
          status: "unavailable",
          conflictBookingId: approvedConflict.bookingId,
          conflictWarningBookingIds: undefined,
          conflictWarningAcknowledgedAt: undefined,
          reviewedAt: now,
          reviewedBy: args.actorId,
          calendarAvailabilityStatus: "conflict",
          calendarConflictSummary: conflictSummary,
          calendarSyncStatus: "conflict",
          calendarSyncError: conflictSummary,
          calendarSyncToken: undefined,
          calendarSyncLeaseExpiresAt: undefined,
          calendarAttemptedEvents: undefined,
          updatedAt: now,
          revision: (booking.revision ?? 0) + 1,
        });
        await ctx.db.insert("auditLogs", {
          level: "warning",
          category: "booking",
          action: "approval_blocked_by_approved_booking",
          actorType: "user",
          actorId: args.actorId,
          entityType: "booking",
          entityId: String(booking._id),
          message:
            "The booking was automatically marked unavailable because an approved RoomOps booking already reserves the venue.",
          detailsJson: JSON.stringify({
            conflictBookingId: String(approvedConflict.bookingId),
            conflictTargetVenue: approvedConflict.targetVenue,
          }),
          createdAt: now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyBookingDecision,
          { bookingId: booking._id },
        );
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyConflictAlert,
          {
            bookingId: booking._id,
            relatedBookingIds: [approvedConflict.bookingId],
          },
        );
        return {
          started: false as const,
          reason: "approved_conflict" as const,
          conflictBookingId: approvedConflict.bookingId,
        };
      }

      const pendingConflicts = conflicts.filter(
        (conflict) => conflict.booking.status === "pending",
      );
      const pendingConflictIds = uniqueBookingIds(
        pendingConflicts.map((conflict) => conflict.bookingId),
      );
      if (
        pendingConflictIds.length > 0 &&
        args.confirmConflicts !== true
      ) {
        await addReciprocalConflictWarnings(
          ctx,
          booking._id,
          pendingConflictIds,
          now,
        );
        await ctx.db.patch(booking._id, {
          conflictWarningBookingIds: uniqueBookingIds(
            [
              ...(booking.conflictWarningBookingIds ?? []),
              ...pendingConflictIds,
            ],
            booking._id,
          ),
          conflictWarningAcknowledgedAt: undefined,
          updatedAt: now,
          revision: (booking.revision ?? 0) + 1,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyConflictAlert,
          {
            bookingId: booking._id,
            relatedBookingIds: pendingConflictIds,
          },
        );
        return {
          started: false as const,
          reason: "conflict_ack_required" as const,
          conflictBookingId: pendingConflictIds[0],
        };
      }
      const inProgressConflict = pendingConflicts.find(
        (conflict) =>
          conflict.booking.calendarSyncStatus === "creating" &&
          (conflict.booking.calendarSyncLeaseExpiresAt ?? 0) > now,
      );
      if (inProgressConflict) {
        await addReciprocalConflictWarnings(
          ctx,
          booking._id,
          pendingConflictIds,
          now,
        );
        await ctx.db.patch(booking._id, {
          conflictWarningBookingIds: uniqueBookingIds(
            [
              ...(booking.conflictWarningBookingIds ?? []),
              ...pendingConflictIds,
            ],
            booking._id,
          ),
          conflictWarningAcknowledgedAt: undefined,
          updatedAt: now,
          revision: (booking.revision ?? 0) + 1,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyConflictAlert,
          {
            bookingId: booking._id,
            relatedBookingIds: pendingConflictIds,
          },
        );
        return {
          started: false as const,
          reason: "approval_in_progress" as const,
          conflictBookingId: inProgressConflict.bookingId,
        };
      }

      if (pendingConflictIds.length > 0) {
        await addReciprocalConflictWarnings(
          ctx,
          booking._id,
          pendingConflictIds,
          now,
        );
        await ctx.scheduler.runAfter(
          0,
          internal.emailNotifications.notifyConflictAlert,
          {
            bookingId: booking._id,
            relatedBookingIds: pendingConflictIds,
          },
        );
      }
      await ctx.db.patch(booking._id, {
        conflictWarningBookingIds:
          pendingConflictIds.length > 0
            ? uniqueBookingIds(
                [
                  ...(booking.conflictWarningBookingIds ?? []),
                  ...pendingConflictIds,
                ],
                booking._id,
              )
            : booking.conflictWarningBookingIds,
        conflictWarningAcknowledgedAt:
          pendingConflictIds.length > 0
            ? undefined
            : booking.conflictWarningAcknowledgedAt,
        calendarSyncStatus: "creating",
        calendarSyncError: undefined,
        calendarSyncAttempts: (booking.calendarSyncAttempts ?? 0) + 1,
        calendarSyncToken: args.syncToken,
        calendarSyncLeaseExpiresAt: now + CALENDAR_SYNC_LEASE_MS,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(booking._id, {
        calendarSyncStatus: "creating",
        calendarSyncError: undefined,
        calendarSyncAttempts: (booking.calendarSyncAttempts ?? 0) + 1,
        calendarSyncToken: args.syncToken,
        calendarSyncLeaseExpiresAt: now + CALENDAR_SYNC_LEASE_MS,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(
      CALENDAR_SYNC_LEASE_MS,
      internal.bookings.recoverCalendarSyncLease,
      {
        bookingId: booking._id,
        syncToken: args.syncToken,
      },
    );
    if (dispatchInBackground) {
      await ctx.scheduler.runAfter(
        0,
        internal.googleCalendar.processCalendarApproval,
        {
          bookingId: booking._id,
          actorId: args.actorId,
          syncToken: args.syncToken,
          note: backgroundNote,
        },
      );
    }
    return { started: true as const, booking };
}

export const queueCalendarApproval = mutation({
  args: {
    bookingId: v.id("bookings"),
    note: v.optional(v.string()),
    confirmConflicts: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "bookings.approve");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    const now = Date.now();
    const syncToken = [
      "approval",
      String(booking._id),
      booking.revision ?? 0,
      (booking.calendarSyncAttempts ?? 0) + 1,
      now,
    ].join(":");
    const result = await prepareCalendarApproval(ctx, {
      bookingId: booking._id,
      actorId: user.clerkUserId,
      syncToken,
      purpose: "approve",
      confirmConflicts: args.confirmConflicts,
      dispatchInBackground: true,
      note: args.note,
    });
    if (result.started) {
      return { state: "queued" as const };
    }
    if (result.reason === "approved_conflict_cleanup_required") {
      return { state: "queued" as const };
    }
    if (result.reason === "approved_conflict") {
      return { state: "unavailable" as const };
    }
    return {
      state: result.reason,
    };
  },
});

export const beginCalendarApproval = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    syncToken: v.string(),
    purpose: v.union(v.literal("approve"), v.literal("cleanup")),
    confirmConflicts: v.optional(v.boolean()),
    dispatchInBackground: v.optional(v.boolean()),
    note: v.optional(v.string()),
    emailDecisionClaim: v.optional(emailDecisionClaimValidator),
  },
  handler: async (ctx, args) => {
    return await prepareCalendarApproval(ctx, args);
  },
});

export const markApprovedConflictAfterCalendarCleanup =
  internalMutation({
    args: {
      bookingId: v.id("bookings"),
      conflictBookingId: v.id("bookings"),
      actorId: v.string(),
      syncToken: v.string(),
      note: v.optional(v.string()),
      emailDecisionClaim: v.optional(emailDecisionClaimValidator),
    },
    handler: async (ctx, args) => {
      const booking = await ctx.db.get(args.bookingId);
      if (
        !booking ||
        booking.status !== "pending" ||
        booking.calendarSyncStatus !== "creating" ||
        booking.calendarSyncToken !== args.syncToken
      ) {
        bookingError(
          "CALENDAR_SYNC_LEASE_LOST",
          "This Calendar cleanup no longer owns the pending booking.",
        );
      }
      await requireTerminalDecisionActor(
        ctx,
        booking._id,
        args.actorId,
        args.emailDecisionClaim,
      );
      const conflicts = await findConflicts(ctx, {
        occurrences:
          booking.occurrences ?? [
            {
              sequence: 0,
              startAt: booking.startAt,
              endAt: booking.endAt,
            },
          ],
        resolvedVenues:
          booking.resolvedVenues ?? [booking.room],
        excludeBookingId: booking._id,
      });
      const approvedConflict = conflicts.find(
        (conflict) =>
          conflict.bookingId === args.conflictBookingId &&
          conflict.booking.status === "approved",
      );
      if (!approvedConflict) {
        bookingError(
          "APPROVED_BOOKING_CONFLICT_CHANGED",
          "The approved RoomOps conflict changed during Calendar cleanup. Retry the decision.",
        );
      }

      const now = Date.now();
      const conflictSummary =
        `${approvedConflict.targetVenue} overlaps an approved RoomOps booking.`;
      await clearReciprocalConflictWarnings(ctx, booking, now);
      await removeClaims(ctx, booking._id);
      await ctx.db.patch(booking._id, {
        status: "unavailable",
        conflictBookingId: approvedConflict.bookingId,
        conflictWarningBookingIds: undefined,
        conflictWarningAcknowledgedAt: undefined,
        reviewNote:
          args.note?.trim().slice(0, 1_000) || undefined,
        reviewedAt: now,
        reviewedBy: args.actorId,
        calendarAvailabilityStatus: "conflict",
        calendarConflictSummary: conflictSummary,
        calendarSyncStatus: "conflict",
        calendarSyncError: conflictSummary,
        calendarSyncToken: undefined,
        calendarSyncLeaseExpiresAt: undefined,
        // The owning action has successfully deleted every stored candidate
        // immediately before this mutation.
        calendarAttemptedEvents: undefined,
        updatedAt: now,
        revision: (booking.revision ?? 0) + 1,
      });
      await ctx.db.insert("auditLogs", {
        level: "warning",
        category: "booking",
        action:
          "approval_blocked_after_calendar_cleanup",
        actorType:
          args.actorId.startsWith("system:") ? "system" : "user",
        actorId: args.actorId,
        entityType: "booking",
        entityId: String(booking._id),
        message:
          "The booking's incomplete Calendar attempt was cleaned before it was marked unavailable for an approved RoomOps conflict.",
        detailsJson: JSON.stringify({
          conflictBookingId: String(approvedConflict.bookingId),
          conflictTargetVenue: approvedConflict.targetVenue,
        }),
        createdAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyBookingDecision,
        { bookingId: booking._id },
      );
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyConflictAlert,
        {
          bookingId: booking._id,
          relatedBookingIds: [approvedConflict.bookingId],
        },
      );
    },
  });

export const recordCalendarAttemptTargets = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    syncToken: v.string(),
    events: v.array(calendarEventRefValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.calendarSyncStatus !== "creating" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      bookingError(
        "CALENDAR_SYNC_LEASE_LOST",
        "This calendar approval no longer owns the booking.",
      );
    }
    await ctx.db.patch(booking._id, {
      calendarAttemptedEvents: args.events,
      updatedAt: Date.now(),
    });
  },
});

export const recordCalendarReconciliationTargets = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    syncToken: v.string(),
    events: v.array(calendarEventRefValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "approved" ||
      booking.calendarSyncStatus !== "creating" ||
      booking.calendarSyncToken !== args.syncToken ||
      (booking.revision ?? 0) !== args.expectedRevision
    ) {
      bookingError(
        "CALENDAR_SYNC_LEASE_LOST",
        "This Calendar reconciliation no longer owns the approved booking.",
      );
    }
    const attemptedEvents = mergeManagedCalendarEvents(
      booking.calendarAttemptedEvents,
      args.events,
    );
    await ctx.db.patch(booking._id, {
      calendarAttemptedEvents:
        attemptedEvents.length > 0 ? attemptedEvents : undefined,
      updatedAt: Date.now(),
    });
    return attemptedEvents;
  },
});

export const completeCalendarApproval = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    syncToken: v.string(),
    note: v.optional(v.string()),
    events: v.array(calendarEventRefValidator),
    emailDecisionClaim: v.optional(emailDecisionClaimValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    if (
      booking.status !== "pending" ||
      booking.calendarSyncStatus !== "creating" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      bookingError(
        "CALENDAR_SYNC_LEASE_LOST",
        "This calendar approval no longer owns the booking.",
      );
    }
    await requireTerminalDecisionActor(
      ctx,
      booking._id,
      args.actorId,
      args.emailDecisionClaim,
    );
    const now = Date.now();
    const overlappingPendingIds = uniqueBookingIds(
      (
        await findConflicts(ctx, {
          occurrences:
            booking.occurrences ?? [
              {
                sequence: 0,
                startAt: booking.startAt,
                endAt: booking.endAt,
              },
            ],
          resolvedVenues:
            booking.resolvedVenues ?? [booking.room],
          excludeBookingId: booking._id,
        })
      )
        .filter((conflict) => conflict.booking.status === "pending")
        .map((conflict) => conflict.bookingId),
    );
    const overlappingPeers: Doc<"bookings">[] = [];
    for (const peerId of overlappingPendingIds) {
      const peer = await ctx.db.get(peerId);
      if (peer?.status === "pending") overlappingPeers.push(peer);
    }
    const {
      cleanupRequired: peersRequiringCleanup,
      safeToFinalize: peersSafeToFinalize,
    } = partitionCalendarCleanupCandidates(overlappingPeers);
    await clearReciprocalConflictWarnings(ctx, booking, now);
    await ctx.db.patch(booking._id, {
      status: "approved",
      conflictBookingId: undefined,
      conflictWarningBookingIds: undefined,
      conflictWarningAcknowledgedAt: undefined,
      reviewNote: args.note?.trim().slice(0, 1_000) || undefined,
      reviewedAt: now,
      reviewedBy: args.actorId,
      calendarAvailabilityStatus: "available",
      calendarConflictSummary: undefined,
      calendarSyncStatus: "synced",
      calendarSyncError: undefined,
      calendarSyncToken: undefined,
      calendarSyncLeaseExpiresAt: undefined,
      calendarAttemptedEvents: undefined,
      calendarEvents: args.events,
      calendarSyncedAt: now,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "info",
      category: "booking",
      action: "booking_approved",
      actorType: "user",
      actorId: args.actorId,
      entityType: "booking",
      entityId: String(booking._id),
      message: `${booking.room} booking was approved.`,
      detailsJson: JSON.stringify({
        submissionId: booking.jotformSubmissionId,
        calendarEventCount: args.events.length,
        occurrenceCount: booking.occurrences?.length ?? 1,
      }),
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      level: "info",
      category: "google_calendar",
      action: "calendar_events_created",
      actorType: "user",
      actorId: args.actorId,
      entityType: "booking",
      entityId: String(booking._id),
      message: `${args.events.length} Google Calendar event${args.events.length === 1 ? " was" : "s were"} created for the approved booking.`,
      detailsJson: JSON.stringify({
        targetVenues: args.events.map((event) => event.targetVenue),
        occurrenceCount: booking.occurrences?.length ?? 1,
      }),
      createdAt: now,
    });
    for (const peer of peersRequiringCleanup) {
      await ctx.db.insert("auditLogs", {
        level: "warning",
        category: "google_calendar",
        action: "conflicting_booking_cleanup_queued",
        actorType: "system",
        entityType: "booking",
        entityId: String(peer._id),
        message:
          "A conflicting pending request has possible Calendar events that must be cleaned before automatic rejection.",
        detailsJson: JSON.stringify({
          approvedBookingId: String(booking._id),
          attemptedEventCount:
            peer.calendarAttemptedEvents?.length ?? 0,
        }),
        createdAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.googleCalendar.cleanupSupersededBooking,
        {
          bookingId: peer._id,
          approvedBookingId: booking._id,
        },
      );
    }
    for (const peer of peersSafeToFinalize) {
      await clearReciprocalConflictWarnings(ctx, peer, now);
      await removeClaims(ctx, peer._id);
      const latestPeer = await ctx.db.get(peer._id);
      if (!latestPeer || latestPeer.status !== "pending") continue;
      const conflictSummary =
        `${peer.room} overlaps booking ${String(booking._id)}, which has now been approved.`;
      await ctx.db.patch(peer._id, {
        status: "unavailable",
        conflictBookingId: booking._id,
        conflictWarningBookingIds: undefined,
        conflictWarningAcknowledgedAt: undefined,
        reviewNote:
          "Automatically rejected because an overlapping room request was approved first.",
        reviewedAt: now,
        reviewedBy: "system:approved-conflict",
        calendarAvailabilityStatus: "conflict",
        calendarConflictSummary: conflictSummary,
        calendarSyncStatus: "conflict",
        calendarSyncError: conflictSummary,
        calendarSyncToken: undefined,
        calendarSyncLeaseExpiresAt: undefined,
        calendarAttemptedEvents: undefined,
        updatedAt: now,
        revision: (latestPeer.revision ?? 0) + 1,
      });
      await ctx.db.insert("auditLogs", {
        level: "warning",
        category: "booking",
        action: "pending_booking_auto_rejected_after_approval",
        actorType: "system",
        entityType: "booking",
        entityId: String(peer._id),
        message:
          "A conflicting pending request was automatically marked unavailable after the overlapping request was approved.",
        detailsJson: JSON.stringify({
          approvedBookingId: String(booking._id),
          submissionId: peer.jotformSubmissionId,
        }),
        createdAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyBookingDecision,
        { bookingId: peer._id },
      );
    }
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.notifyBookingDecision,
      { bookingId: booking._id },
    );
    if (overlappingPendingIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyConflictAlert,
        {
          bookingId: booking._id,
          relatedBookingIds: overlappingPendingIds,
        },
      );
    }
  },
});

export const failCalendarApproval = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    syncToken: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      return;
    }
    const now = Date.now();
    const errorMessage = args.errorMessage.slice(0, 1_000);
    await ctx.db.patch(booking._id, {
      calendarSyncStatus: "failed",
      calendarSyncError: errorMessage,
      calendarSyncToken: undefined,
      calendarSyncLeaseExpiresAt: undefined,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "google_calendar",
      action: "calendar_approval_failed",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "Google Calendar synchronization failed; the booking remains pending.",
      detailsJson: JSON.stringify({ error: errorMessage }),
      createdAt: now,
    });
  },
});

export const recoverCalendarSyncLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    syncToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.calendarSyncToken !== args.syncToken) {
      return;
    }
    const now = Date.now();
    const leaseExpiresAt = booking.calendarSyncLeaseExpiresAt ?? 0;
    if (leaseExpiresAt > now) {
      await ctx.scheduler.runAfter(
        leaseExpiresAt - now + 1_000,
        internal.bookings.recoverCalendarSyncLease,
        args,
      );
      return;
    }
    const message =
      booking.status === "pending"
        ? "Google Calendar approval did not finish before its safety lease expired. The request remains pending and can be retried."
        : "Google Calendar reconciliation did not finish before its safety lease expired. Retry synchronization from the booking list.";
    await ctx.db.patch(booking._id, {
      calendarSyncStatus: "failed",
      calendarSyncError: message,
      calendarSyncToken: undefined,
      calendarSyncLeaseExpiresAt: undefined,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "google_calendar",
      action: "calendar_sync_lease_expired",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message,
      detailsJson: JSON.stringify({
        status: booking.status,
        syncToken: args.syncToken,
      }),
      createdAt: now,
    });
  },
});

export const renewCalendarApprovalLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    syncToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.calendarSyncStatus !== "creating" ||
      booking.calendarSyncToken !== args.syncToken ||
      bookingDeletionInProgress(booking, Date.now())
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(booking._id, {
      calendarSyncLeaseExpiresAt: now + CALENDAR_SYNC_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      CALENDAR_SYNC_LEASE_MS,
      internal.bookings.recoverCalendarSyncLease,
      {
        bookingId: booking._id,
        syncToken: args.syncToken,
      },
    );
    return booking;
  },
});

export const renewCalendarReconciliationLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    syncToken: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "approved" ||
      booking.calendarSyncStatus !== "creating" ||
      booking.calendarSyncToken !== args.syncToken ||
      (booking.revision ?? 0) !== args.expectedRevision ||
      bookingDeletionInProgress(booking, Date.now())
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(booking._id, {
      calendarSyncLeaseExpiresAt: now + CALENDAR_SYNC_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      CALENDAR_SYNC_LEASE_MS,
      internal.bookings.recoverCalendarSyncLease,
      {
        bookingId: booking._id,
        syncToken: args.syncToken,
      },
    );
    return booking;
  },
});

export const markCalendarConflict = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    actorId: v.string(),
    syncToken: v.string(),
    note: v.optional(v.string()),
    conflictSummary: v.string(),
    emailDecisionClaim: v.optional(emailDecisionClaimValidator),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      return;
    }
    await requireTerminalDecisionActor(
      ctx,
      booking._id,
      args.actorId,
      args.emailDecisionClaim,
    );
    const now = Date.now();
    await clearReciprocalConflictWarnings(ctx, booking, now);
    await removeClaims(ctx, booking._id);
    const conflictSummary = args.conflictSummary.slice(0, 1_000);
    await ctx.db.patch(booking._id, {
      status: "unavailable",
      conflictWarningBookingIds: undefined,
      conflictWarningAcknowledgedAt: undefined,
      reviewNote: args.note?.trim().slice(0, 1_000) || undefined,
      reviewedAt: now,
      reviewedBy: args.actorId,
      calendarAvailabilityStatus: "conflict",
      calendarConflictSummary: conflictSummary,
      calendarSyncStatus: "conflict",
      calendarSyncError: conflictSummary,
      calendarSyncToken: undefined,
      calendarSyncLeaseExpiresAt: undefined,
      calendarAttemptedEvents: undefined,
      updatedAt: now,
      revision: (booking.revision ?? 0) + 1,
    });
    await ctx.db.insert("auditLogs", {
      level: "warning",
      category: "google_calendar",
      action: "calendar_conflict_on_approval",
      actorType: "user",
      actorId: args.actorId,
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "Approval was stopped because Google Calendar reports a busy venue.",
      detailsJson: JSON.stringify({ conflict: conflictSummary }),
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.notifyBookingDecision,
      { bookingId: booking._id },
    );
    await ctx.scheduler.runAfter(
      0,
      internal.emailNotifications.notifyConflictAlert,
      {
        bookingId: booking._id,
        relatedBookingIds: [],
      },
    );
  },
});

export const recordCalendarReconcileResult = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    syncToken: v.string(),
    success: v.boolean(),
    errorMessage: v.optional(v.string()),
    events: v.optional(v.array(calendarEventRefValidator)),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "approved" ||
      booking.calendarSyncToken !== args.syncToken
    ) {
      return;
    }
    const currentRevision = booking.revision ?? 0;
    const revisionMatches = currentRevision === args.expectedRevision;
    const success =
      args.success &&
      revisionMatches &&
      (args.events?.length ?? 0) > 0;
    const errorMessage = revisionMatches
      ? args.success && (args.events?.length ?? 0) === 0
        ? "Google Calendar reconciliation returned no managed event references."
        : args.errorMessage
      : "The booking revision changed during Calendar synchronization. Retry synchronization from the booking list.";
    const calendarConflict =
      !success &&
      errorMessage?.startsWith(
        "GOOGLE_CALENDAR_CONFLICT_AFTER_EDIT:",
      ) === true;
    const now = Date.now();
    await ctx.db.patch(booking._id, {
      calendarSyncStatus: success ? "synced" : "failed",
      calendarSyncError: success
        ? undefined
        : errorMessage?.slice(0, 1_000) ||
          "Google Calendar update failed.",
      calendarSyncedAt: success
        ? now
        : booking.calendarSyncedAt,
      calendarSyncToken: undefined,
      calendarSyncLeaseExpiresAt: undefined,
      calendarAvailabilityStatus: success
        ? "available"
        : calendarConflict
          ? "conflict"
          : booking.calendarAvailabilityStatus,
      calendarConflictSummary: success
        ? undefined
        : calendarConflict
          ? errorMessage
              ?.replace(
                /^GOOGLE_CALENDAR_CONFLICT_AFTER_EDIT:/,
                "",
              )
              .slice(0, 1_000)
          : booking.calendarConflictSummary,
      ...(success && args.events
        ? {
            calendarAttemptedEvents: undefined,
            calendarEvents: args.events,
          }
        : {}),
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      level: success ? "info" : "error",
      category: "google_calendar",
      action: success
        ? "calendar_events_reconciled"
        : "calendar_reconciliation_failed",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message: success
        ? "Approved booking changes were synchronized to Google Calendar."
        : "Approved booking changes could not be synchronized to Google Calendar.",
      detailsJson: success
        ? undefined
        : JSON.stringify({ error: errorMessage }),
      createdAt: now,
    });
    if (calendarConflict) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyConflictAlert,
        {
          bookingId: booking._id,
          relatedBookingIds: [],
        },
      );
    }
  },
});

export const retryCalendarSync = mutation({
  args: {
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "bookings.edit");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    requireBookingDeletionIdle(booking);
    if (
      booking.status !== "approved" ||
      (booking.calendarEvents?.length ?? 0) === 0
    ) {
      bookingError(
        "CALENDAR_RETRY_NOT_AVAILABLE",
        "Only an approved booking with managed Google Calendar events can be resynchronized.",
      );
    }
    const now = Date.now();
    if (
      booking.calendarSyncToken &&
      (booking.calendarSyncLeaseExpiresAt ?? 0) > now
    ) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "Google Calendar synchronization is already in progress.",
      );
    }
    if (
      booking.calendarSyncStatus !== "failed" &&
      booking.calendarSyncStatus !== "creating"
    ) {
      bookingError(
        "CALENDAR_RETRY_NOT_NEEDED",
        "This booking does not currently need Calendar synchronization.",
      );
    }

    const revision = booking.revision ?? 0;
    const attempt = (booking.calendarSyncAttempts ?? 0) + 1;
    const syncToken = calendarReconciliationToken(
      booking._id,
      revision,
      attempt,
      now,
    );
    await ctx.db.patch(booking._id, {
      calendarSyncStatus: "creating",
      calendarSyncError: undefined,
      calendarSyncAttempts: attempt,
      calendarSyncToken: syncToken,
      calendarSyncLeaseExpiresAt: now + CALENDAR_SYNC_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.googleCalendar.reconcileApprovedBooking,
      {
        bookingId: booking._id,
        expectedRevision: revision,
        syncToken,
      },
    );
    await ctx.scheduler.runAfter(
      CALENDAR_SYNC_LEASE_MS,
      internal.bookings.recoverCalendarSyncLease,
      {
        bookingId: booking._id,
        syncToken,
      },
    );
    await ctx.db.insert("auditLogs", {
      level: "info",
      category: "google_calendar",
      action: "calendar_reconciliation_retried",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "An administrator retried Google Calendar synchronization.",
      detailsJson: JSON.stringify({ attempt, revision }),
      createdAt: now,
    });
  },
});

type AdminEditInput = {
  requesterName: string;
  requesterEmail: string;
  room: string;
  startAt: number;
  endAt: number;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  recurrenceFrequency: RecurrenceFrequency;
  recurrenceHasEndDate: boolean;
  recurrenceUntilAt?: number;
  editScope: "series" | "occurrence";
  occurrenceSequence?: number;
};

function adminReservationProposal(
  booking: Doc<"bookings">,
  args: AdminEditInput,
): {
  room: string;
  roomKey: string;
  startAt: number;
  endAt: number;
  recurrenceFrequency: RecurrenceFrequency;
  recurrenceHasEndDate: boolean;
  recurrenceUntilAt?: number;
  occurrences: BookingOccurrence[];
  resolvedVenues: string[];
  changesReservation: boolean;
} {
  const existingFrequency = booking.recurrenceFrequency ?? "none";
  const existingHasEndDate =
    existingFrequency !== "none" &&
    (booking.recurrenceHasEndDate ??
      booking.recurrenceUntilAt !== undefined);

  if (args.editScope === "occurrence") {
    if (
      existingFrequency === "none" ||
      (booking.occurrences?.length ?? 1) < 2
    ) {
      bookingError(
        "BOOKING_OCCURRENCE_EDIT_NOT_AVAILABLE",
        "Only a recurring booking can edit one occurrence.",
      );
    }
    requireBookableVenue(args.room);
    const selection = resolveVenueSelection(args.room);
    let occurrences: BookingOccurrence[];
    try {
      occurrences = applyOccurrenceEdit(
        (booking.occurrences ?? []) as BookingOccurrence[],
        args.occurrenceSequence ?? -1,
        {
          startAt: args.startAt,
          endAt: args.endAt,
          room: selection.displayName,
          defaultRoom: booking.room,
          resolvedVenues: [...selection.venues],
        },
      );
      assertSortedNonOverlappingOccurrences(occurrences);
      let remainingClaims = MAX_CLAIM_SLOTS_PER_BOOKING;
      for (const occurrence of occurrences) {
        const used = assertTotalClaimSlotsWithinLimit(
          [occurrence],
          (occurrence.resolvedVenues ?? booking.resolvedVenues ?? [
            booking.room,
          ]).length,
          remainingClaims,
        );
        remainingClaims -= used;
      }
    } catch (error) {
      if (error instanceof BookingRuleError) {
        bookingError(error.code, error.message);
      }
      bookingError(
        "BOOKING_OCCURRENCE_EDIT_INVALID",
        error instanceof Error
          ? `The selected occurrence could not be edited (${error.message}).`
          : "The selected occurrence could not be edited.",
      );
    }
    return {
      room: booking.room,
      roomKey: booking.roomKey,
      startAt: booking.startAt,
      endAt: booking.endAt,
      recurrenceFrequency: existingFrequency,
      recurrenceHasEndDate: existingHasEndDate,
      recurrenceUntilAt: booking.recurrenceUntilAt,
      occurrences,
      resolvedVenues: booking.resolvedVenues ?? [booking.room],
      changesReservation: true,
    };
  }

  const recurrenceFrequency = args.recurrenceFrequency;
  const recurrenceHasEndDate =
    recurrenceFrequency !== "none" && args.recurrenceHasEndDate;
  const recurrenceUntilAt = recurrenceHasEndDate
    ? args.recurrenceUntilAt
    : undefined;
  const changesRecurrenceDefinition = recurrenceDefinitionChanged({
    currentFrequency: existingFrequency,
    currentHasEndDate: existingHasEndDate,
    currentStartAt: booking.startAt,
    currentUntilAt: booking.recurrenceUntilAt,
    nextFrequency: recurrenceFrequency,
    nextHasEndDate: recurrenceHasEndDate,
    nextStartAt: args.startAt,
    nextUntilAt: recurrenceUntilAt,
  });
  if (
    recurrenceFrequency !== "none" &&
    recurrenceHasEndDate &&
    recurrenceUntilAt === undefined
  ) {
    bookingError(
      "RECURRENCE_UNTIL_REQUIRED",
      "Choose the last date required for this recurring booking.",
    );
  }
  const normalized = validateBookingInput({
    ...args,
    timezone: booking.timezone,
    recurrenceFrequency,
    recurrenceCount: recurrenceCountForAdminEdit({
      frequency: recurrenceFrequency,
      hasEndDate: recurrenceHasEndDate,
      definitionChanged: changesRecurrenceDefinition,
      existingOccurrenceCount:
        booking.occurrences?.length ?? booking.recurrenceCount,
      defaultOccurrenceCount: defaultRecurrenceCount,
    }),
    recurrenceUntilAt,
  });
  const changesReservation =
    normalized.roomKey !== booking.roomKey ||
    args.startAt !== booking.startAt ||
    args.endAt !== booking.endAt ||
    changesRecurrenceDefinition ||
    (booking.occurrences ?? []).some(
      (occurrence) =>
        occurrence.room !== undefined ||
        occurrence.resolvedVenues !== undefined,
    );
  if (changesReservation) {
    requireBookableVenue(args.room);
  }
  return {
    ...normalized,
    startAt: args.startAt,
    endAt: args.endAt,
    recurrenceFrequency,
    recurrenceHasEndDate,
    recurrenceUntilAt,
    changesReservation,
  };
}

const adminEditArgs = {
  bookingId: v.id("bookings"),
  expectedRevision: v.number(),
  requesterName: v.string(),
  requesterEmail: v.string(),
  room: v.string(),
  startAt: v.number(),
  endAt: v.number(),
  eventName: v.optional(v.string()),
  purpose: v.optional(v.string()),
  ministry: v.optional(v.string()),
  recurrenceFrequency: recurrenceFrequencyValidator,
  recurrenceHasEndDate: v.boolean(),
  recurrenceUntilAt: v.optional(v.number()),
  editScope: v.union(v.literal("series"), v.literal("occurrence")),
  occurrenceSequence: v.optional(v.number()),
};

export const previewEdit = query({
  args: adminEditArgs,
  handler: async (ctx, args) => {
    await requireCapability(ctx, "bookings.edit");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    requireAvailabilityCheckComplete(booking);
    requireBookingDeletionIdle(booking);
    if (booking.calendarSyncToken) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "Wait for the current Google Calendar operation to finish before editing this booking.",
      );
    }
    if ((booking.revision ?? 0) !== args.expectedRevision) {
      bookingError(
        "BOOKING_EDIT_CONFLICT",
        "This booking changed after the editor opened. Close it, reload the latest booking, and try again.",
      );
    }
    const proposal = adminReservationProposal(booking, args);
    if (!proposal.changesReservation) return { conflicts: [] };
    const conflicts = await findConflicts(ctx, {
      occurrences: proposal.occurrences,
      resolvedVenues: proposal.resolvedVenues,
      excludeBookingId: booking._id,
    });
    return {
      conflicts: conflicts.map((conflict) => ({
        bookingId: conflict.bookingId,
        status: conflict.booking.status,
        room: conflict.booking.room,
        startAt: conflict.booking.startAt,
        endAt: conflict.booking.endAt,
        targetVenue: conflict.targetVenue,
        occurrenceSequence: conflict.occurrenceSequence,
      })),
    };
  },
});

export const edit = mutation({
  args: {
    ...adminEditArgs,
    acknowledgedConflictBookingIds: v.optional(
      v.array(v.id("bookings")),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "bookings.edit");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      bookingError("BOOKING_NOT_FOUND", "The booking no longer exists.");
    }
    requireAvailabilityCheckComplete(booking);
    requireBookingDeletionIdle(booking);
    if (booking.calendarSyncToken) {
      bookingError(
        "CALENDAR_SYNC_IN_PROGRESS",
        "Wait for the current Google Calendar operation to finish before editing this booking.",
      );
    }
    const previousRevision = booking.revision ?? 0;
    if (
      !Number.isInteger(args.expectedRevision) ||
      args.expectedRevision !== previousRevision
    ) {
      bookingError(
        "BOOKING_EDIT_CONFLICT",
        "This booking changed after the editor opened. Close it, reload the latest booking, and try again.",
      );
    }

    const proposal = adminReservationProposal(booking, args);
    if (
      proposal.changesReservation &&
      booking.status !== "pending" &&
      booking.status !== "approved"
    ) {
      bookingError(
        "DECIDED_RESERVATION_EDIT_DISABLED",
        "Reservation fields can be changed for pending or approved bookings only.",
      );
    }

    const conflicts = proposal.changesReservation
      ? await findConflicts(ctx, {
          occurrences: proposal.occurrences,
          resolvedVenues: proposal.resolvedVenues,
          excludeBookingId: booking._id,
        })
      : [];
    const blockingConflict = conflicts.find(
      (conflict) =>
        conflict.booking.status === "approved" ||
        booking.status === "approved",
    );
    if (blockingConflict) {
      bookingError(
        "BOOKING_CONFLICT",
        `The proposed change conflicts with an active booking for ${blockingConflict.targetVenue}. The change was not committed.`,
      );
    }
    const pendingConflictIds = uniqueBookingIds(
      conflicts
        .filter((conflict) => conflict.booking.status === "pending")
        .map((conflict) => conflict.bookingId),
    );
    if (
      pendingConflictIds.length > 0 &&
      !conflictIdsAcknowledged(
        pendingConflictIds.map(String),
        (args.acknowledgedConflictBookingIds ?? []).map(String),
      )
    ) {
      bookingError(
        "BOOKING_CONFLICT_ACK_REQUIRED",
        "The conflict set changed. Review and acknowledge the current conflicts before saving.",
      );
    }

    const now = Date.now();
    if (proposal.changesReservation) {
      await clearReciprocalConflictWarnings(ctx, booking, now);
      await removeClaims(ctx, booking._id);
      await addClaims(ctx, booking._id, proposal);
      if (booking.status === "pending" && pendingConflictIds.length > 0) {
        await addReciprocalConflictWarnings(
          ctx,
          booking._id,
          pendingConflictIds,
          now,
        );
      }
    }

    const requesterName = normalizeAdminName(args.requesterName);
    const requesterEmail = normalizeAdminEmail(args.requesterEmail);
    const eventName = normalizeEventName(args.eventName);
    const purpose = normalizePurpose(args.purpose);
    const ministry = normalizeMinistry(args.ministry);
    const metadataChanged =
      requesterName !== booking.requesterName ||
      requesterEmail !== booking.requesterEmail ||
      eventName !== booking.eventName ||
      purpose !== booking.purpose ||
      ministry !== booking.ministry;
    const shouldReconcileCalendar =
      booking.status === "approved" &&
      (booking.calendarEvents?.length ?? 0) > 0 &&
      (proposal.changesReservation || metadataChanged);
    const newRevision = previousRevision + 1;
    const nextCalendarAttempt =
      (booking.calendarSyncAttempts ?? 0) + 1;
    const syncToken = shouldReconcileCalendar
      ? calendarReconciliationToken(
          booking._id,
          newRevision,
          nextCalendarAttempt,
          now,
        )
      : undefined;
    await ctx.db.patch(booking._id, {
      requesterName,
      requesterEmail,
      room: proposal.room,
      roomKey: proposal.roomKey,
      startAt: proposal.startAt,
      endAt: proposal.endAt,
      eventName,
      purpose,
      ministry,
      recurrenceFrequency: proposal.recurrenceFrequency,
      recurrenceHasEndDate: proposal.recurrenceHasEndDate,
      recurrenceCount: proposal.occurrences.length,
      recurrenceUntilAt: proposal.recurrenceUntilAt,
      occurrences: proposal.occurrences,
      resolvedVenues: proposal.resolvedVenues,
      formResponses: updateCanonicalResponseValues(
        booking.formResponses,
        {
          requesterName,
          requesterEmail,
          eventName,
          purpose,
          ministry,
          recurrence: {
            frequency: proposal.recurrenceFrequency,
            hasEndDate: proposal.recurrenceHasEndDate,
            count: proposal.occurrences.length,
            untilAt: proposal.recurrenceUntilAt,
            timezone: booking.timezone,
          },
        },
      ),
      sheetRequesterName: undefined,
      sheetRequesterEmail: undefined,
      sheetPurpose: undefined,
      updatedAt: now,
      revision: newRevision,
      ...(proposal.changesReservation
        ? {
            conflictBookingId: undefined,
            conflictWarningBookingIds:
              booking.status === "pending" &&
              pendingConflictIds.length > 0
                ? pendingConflictIds
                : undefined,
            conflictWarningAcknowledgedAt:
              pendingConflictIds.length > 0 ? now : undefined,
            calendarAvailabilityStatus: "unchecked" as const,
            calendarConflictSummary: undefined,
          }
        : {}),
      ...(shouldReconcileCalendar
        ? {
            calendarSyncStatus: "creating" as const,
            calendarSyncError: undefined,
            calendarSyncAttempts: nextCalendarAttempt,
            calendarSyncToken: syncToken,
            calendarSyncLeaseExpiresAt:
              now + CALENDAR_SYNC_LEASE_MS,
          }
        : {}),
      sheetSyncStatus: "disabled",
      sheetSyncAttempts: 0,
      sheetSyncError: undefined,
      sheetSyncLeaseToken: undefined,
      sheetSyncLeaseExpiresAt: undefined,
    });
    await ctx.db.insert("auditLogs", {
      level: pendingConflictIds.length > 0 ? "warning" : "info",
      category: "booking",
      action:
        args.editScope === "occurrence"
          ? "booking_occurrence_edited"
          : "booking_edited",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "booking",
      entityId: String(booking._id),
      message:
        args.editScope === "occurrence"
          ? `${booking.room} recurring booking occurrence was edited.`
          : `${booking.room} booking details were edited.`,
      detailsJson: JSON.stringify({
        editScope: args.editScope,
        occurrenceSequence: args.occurrenceSequence,
        reservationChanged: proposal.changesReservation,
        previousRevision,
        newRevision,
        recurrenceFrequency: proposal.recurrenceFrequency,
        occurrenceCount: proposal.occurrences.length,
        pendingConflictIds: pendingConflictIds.map(String),
        calendarReconciliationQueued: shouldReconcileCalendar,
        submissionId: booking.jotformSubmissionId,
      }),
      createdAt: now,
    });
    if (pendingConflictIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.emailNotifications.notifyConflictAlert,
        {
          bookingId: booking._id,
          relatedBookingIds: pendingConflictIds,
        },
      );
    }
    if (shouldReconcileCalendar) {
      await ctx.scheduler.runAfter(
        0,
        internal.googleCalendar.reconcileApprovedBooking,
        {
          bookingId: booking._id,
          expectedRevision: newRevision,
          syncToken: syncToken!,
        },
      );
      await ctx.scheduler.runAfter(
        CALENDAR_SYNC_LEASE_MS,
        internal.bookings.recoverCalendarSyncLease,
        {
          bookingId: booking._id,
          syncToken: syncToken!,
        },
      );
    }
  },
});

// Compatibility target for an action that began before the durable
// Sheets dispatcher was deployed. The current booking is reconciled
// instead of trusting the older worker's snapshot.
export const setSheetSyncResult = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    status: v.union(
      v.literal("synced"),
      v.literal("failed"),
      v.literal("disabled"),
    ),
    row: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return;
    await ctx.db.patch(booking._id, {
      sheetSyncStatus: "disabled",
      sheetSyncAttempts: 0,
      sheetSyncError: undefined,
      sheetSyncLeaseToken: undefined,
      sheetSyncLeaseExpiresAt: undefined,
    });
  },
});
