import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const roleValidator = v.union(
  v.literal("head_admin"),
  v.literal("booking_viewer"),
  v.literal("booking_approver"),
  v.literal("sheet_editor"),
  v.literal("booking_manager"),
);

export const nonHeadRoleValidator = v.union(
  v.literal("booking_viewer"),
  v.literal("booking_approver"),
  v.literal("sheet_editor"),
  v.literal("booking_manager"),
);

export const userStatusValidator = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("rejected"),
  v.literal("removed"),
);

export const bookingStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("unavailable"),
);

export const recurrenceFrequencyValidator = v.union(
  v.literal("none"),
  v.literal("daily"),
  v.literal("weekly_same_day"),
  v.literal("monthly_same_day"),
  v.literal("monthly_same_date"),
);

export const bookingOccurrenceValidator = v.object({
  sequence: v.number(),
  startAt: v.number(),
  endAt: v.number(),
});

export const calendarSyncStatusValidator = v.union(
  v.literal("disabled"),
  v.literal("not_created"),
  v.literal("creating"),
  v.literal("synced"),
  v.literal("failed"),
  v.literal("conflict"),
);

export const calendarEventRefValidator = v.object({
  calendarId: v.string(),
  eventId: v.string(),
  htmlLink: v.optional(v.string()),
  targetVenue: v.string(),
});

export const jotformCanonicalFieldValidator = v.union(
  v.literal("requesterName"),
  v.literal("requesterEmail"),
  v.literal("room"),
  v.literal("eventName"),
  v.literal("purpose"),
  v.literal("ministry"),
  v.literal("recurrence"),
  v.literal("recurrenceCount"),
  v.literal("recurrenceUntil"),
  v.literal("start"),
  v.literal("end"),
  v.literal("date"),
  v.literal("startTime"),
  v.literal("endDate"),
  v.literal("endTime"),
);

export const jotformResponseValidator = v.object({
  qid: v.string(),
  name: v.optional(v.string()),
  label: v.string(),
  type: v.optional(v.string()),
  order: v.optional(v.number()),
  value: v.string(),
  canonicalField: v.optional(jotformCanonicalFieldValidator),
});

export default defineSchema({
  users: defineTable({
    // Compatibility fields for the v1 -> v2 user migration. New writes use
    // clerkUserId/displayName only. After every deployment is migrated, make
    // those two fields required and remove the three legacy fields/index.
    clerkUserId: v.optional(v.string()),
    identitySubject: v.optional(v.string()),
    email: v.string(),
    displayName: v.optional(v.string()),
    name: v.optional(v.string()),
    requestedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    requestedRole: v.optional(nonHeadRoleValidator),
    role: roleValidator,
    status: userStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    reviewedAt: v.optional(v.number()),
    reviewedBy: v.optional(v.string()),
    removedAt: v.optional(v.number()),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_identity_subject", ["identitySubject"])
    .index("by_status", ["status"])
    .index("by_email", ["email"]),

  bookings: defineTable({
    source: v.literal("jotform"),
    jotformFormId: v.string(),
    jotformSubmissionId: v.string(),
    requesterName: v.string(),
    requesterEmail: v.string(),
    room: v.string(),
    roomKey: v.string(),
    startAt: v.number(),
    endAt: v.number(),
    timezone: v.string(),
    eventName: v.optional(v.string()),
    purpose: v.optional(v.string()),
    ministry: v.optional(v.string()),
    recurrenceFrequency: v.optional(recurrenceFrequencyValidator),
    recurrenceCount: v.optional(v.number()),
    recurrenceUntilAt: v.optional(v.number()),
    occurrences: v.optional(v.array(bookingOccurrenceValidator)),
    resolvedVenues: v.optional(v.array(v.string())),
    // Bounded, display-safe text snapshot of submitted answers. New
    // unmapped Jotform questions appear as dynamic table columns.
    formResponses: v.optional(v.array(jotformResponseValidator)),
    // Optional for rolling compatibility with bookings created before
    // bounded response snapshots reported their completeness.
    formResponsesTruncated: v.optional(v.boolean()),
    formResponseCapturedCount: v.optional(v.number()),
    formResponseFieldCount: v.optional(v.number()),
    status: bookingStatusValidator,
    conflictBookingId: v.optional(v.id("bookings")),
    conflictWarningBookingIds: v.optional(v.array(v.id("bookings"))),
    conflictWarningAcknowledgedAt: v.optional(v.number()),
    reviewNote: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    reviewedBy: v.optional(v.string()),
    // True only while the durable Jotform row exists but intake has not yet
    // completed its Google Calendar availability check. Existing bookings
    // predate this staged-intake state and are therefore treated as complete.
    availabilityCheckPending: v.optional(v.boolean()),
    calendarAvailabilityStatus: v.optional(
      v.union(
        v.literal("unchecked"),
        v.literal("available"),
        v.literal("conflict"),
      ),
    ),
    calendarConflictSummary: v.optional(v.string()),
    calendarSyncStatus: v.optional(calendarSyncStatusValidator),
    calendarSyncError: v.optional(v.string()),
    calendarSyncAttempts: v.optional(v.number()),
    calendarSyncToken: v.optional(v.string()),
    calendarSyncLeaseExpiresAt: v.optional(v.number()),
    calendarAttemptedEvents: v.optional(
      v.array(calendarEventRefValidator),
    ),
    calendarEvents: v.optional(v.array(calendarEventRefValidator)),
    calendarSyncedAt: v.optional(v.number()),
    // v0.2 Sheets API mirror state. Kept for an in-place v0.3 rollout;
    // all current writes set this to "disabled".
    sheetSyncStatus: v.union(
      v.literal("pending"),
      v.literal("syncing"),
      v.literal("synced"),
      v.literal("failed"),
      v.literal("disabled"),
    ),
    sheetRow: v.optional(v.number()),
    sheetSyncError: v.optional(v.string()),
    sheetSyncLeaseToken: v.optional(v.string()),
    sheetSyncLeaseExpiresAt: v.optional(v.number()),
    sheetSyncAttempts: v.optional(v.number()),
    // Retained only so an in-place upgrade accepts records from the
    // retired API-based Sheet edit implementation.
    sheetRequesterName: v.optional(v.string()),
    sheetRequesterEmail: v.optional(v.string()),
    sheetPurpose: v.optional(v.string()),
    revision: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_submission_id", ["jotformSubmissionId"])
    .index("by_room_start", ["roomKey", "startAt"])
    .index("by_status", ["status"])
    .index("by_created_at", ["createdAt"]),

  // Form-level metadata lets an editor add a value for a known optional
  // question even when that particular submission had no stored response.
  // No submitted answer values are stored in this catalog.
  jotformFields: defineTable({
    formId: v.string(),
    qid: v.string(),
    name: v.optional(v.string()),
    label: v.string(),
    type: v.optional(v.string()),
    order: v.optional(v.number()),
    canonicalField: v.optional(jotformCanonicalFieldValidator),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_form_qid", ["formId", "qid"]),

  bookingClaims: defineTable({
    bookingId: v.id("bookings"),
    roomKey: v.string(),
    utcDay: v.number(),
    startAt: v.number(),
    endAt: v.number(),
    occurrenceSequence: v.optional(v.number()),
    targetVenue: v.optional(v.string()),
  })
    .index("by_room_day_start", ["roomKey", "utcDay", "startAt"])
    .index("by_booking", ["bookingId"]),

  externalSubmissions: defineTable({
    provider: v.literal("jotform"),
    formId: v.string(),
    submissionId: v.string(),
    state: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("processed"),
      v.literal("failed"),
    ),
    bookingId: v.optional(v.id("bookings")),
    deliveryCount: v.number(),
    attempts: v.number(),
    processingStartedAt: v.optional(v.number()),
    processingToken: v.optional(v.string()),
    firstReceivedAt: v.number(),
    lastReceivedAt: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_provider_submission", [
    "provider",
    "formId",
    "submissionId",
  ]),

  approverEmails: defineTable({
    email: v.string(),
    displayName: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.number(),
    createdBy: v.string(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_active", ["active"]),

  emailDecisionTokens: defineTable({
    bookingId: v.id("bookings"),
    approverEmail: v.string(),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    claimToken: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
    usedAt: v.optional(v.number()),
    decision: v.optional(
      v.union(v.literal("approve"), v.literal("reject")),
    ),
    note: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_booking", ["bookingId"])
    .index("by_approver_email", ["approverEmail"]),

  emailDeliveries: defineTable({
    bookingId: v.id("bookings"),
    relatedBookingIds: v.optional(v.array(v.id("bookings"))),
    decisionTokenId: v.optional(v.id("emailDecisionTokens")),
    dependsOnDeliveryId: v.optional(v.id("emailDeliveries")),
    kind: v.union(
      v.literal("requester_submission_received"),
      v.literal("requester_unavailable"),
      v.literal("approver_request"),
      v.literal("requester_approved"),
      v.literal("requester_rejected"),
      v.literal("approver_conflict_urgent"),
    ),
    recipientEmail: v.string(),
    dedupeKey: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("blocked"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    gmailMessageId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_dedupe_key", ["dedupeKey"])
    .index("by_booking", ["bookingId"])
    .index("by_dependency", ["dependsOnDeliveryId"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"]),

  sheetEditJobs: defineTable({
    clientRequestId: v.string(),
    requestedByClerkUserId: v.string(),
    bookingId: v.optional(v.id("bookings")),
    submissionId: v.string(),
    columnKey: v.string(),
    value: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_requester_request", [
    "requestedByClerkUserId",
    "clientRequestId",
  ]),

  auditLogs: defineTable({
    level: v.union(
      v.literal("info"),
      v.literal("warning"),
      v.literal("error"),
    ),
    category: v.union(
      v.literal("authentication"),
      v.literal("user_management"),
      v.literal("jotform"),
      v.literal("booking"),
      v.literal("google_calendar"),
      v.literal("google_sheets"),
      v.literal("email"),
      v.literal("system"),
    ),
    action: v.string(),
    actorType: v.union(v.literal("user"), v.literal("system")),
    actorId: v.optional(v.string()),
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    message: v.string(),
    detailsJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_created_at", ["createdAt"])
    .index("by_category_created_at", ["category", "createdAt"]),
});
