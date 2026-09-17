import { writeAuditLog } from "./lib/auditLog";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const RETIRED_ERROR = "GOOGLE_SHEETS_API_RETIRED";

const editableColumnValidator = v.union(
  v.literal("requesterName"),
  v.literal("requesterEmail"),
  v.literal("purpose"),
);

async function disableLegacySync(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
) {
  const booking = await ctx.db.get(bookingId);
  if (!booking) return;

  const alreadyRetired =
    booking.sheetSyncStatus === "disabled" &&
    booking.sheetSyncLeaseToken === undefined &&
    booking.sheetSyncLeaseExpiresAt === undefined &&
    booking.sheetSyncError === undefined;

  await ctx.db.patch(booking._id, {
    sheetSyncStatus: "disabled",
    sheetSyncAttempts: 0,
    sheetSyncLeaseToken: undefined,
    sheetSyncLeaseExpiresAt: undefined,
    sheetSyncError: undefined,
  });

  if (!alreadyRetired) {
    await writeAuditLog(ctx, {
      level: "info",
      category: "google_sheets",
      action: "legacy_sheet_sync_retired",
      actorType: "system",
      entityType: "booking",
      entityId: String(booking._id),
      message:
        "A legacy Google Sheets synchronization job was retired after RoomOps moved booking data into Convex.",
      createdAt: Date.now(),
    });
  }
}

async function failLegacyEdit(
  ctx: MutationCtx,
  jobId: Id<"sheetEditJobs">,
  leaseToken?: string,
) {
  const job = await ctx.db.get(jobId);
  if (
    !job ||
    job.status !== "pending" ||
    (leaseToken !== undefined && job.leaseToken !== leaseToken)
  ) {
    return;
  }
  const now = Date.now();
  await ctx.db.patch(job._id, {
    status: "failed",
    errorMessage: RETIRED_ERROR,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
  });
  await writeAuditLog(ctx, {
    level: "warning",
    category: "google_sheets",
    action: "legacy_sheet_edit_retired",
    actorType: "user",
    actorId: job.requestedByClerkUserId,
    entityType: "jotform_submission",
    entityId: job.submissionId,
    message:
      "A legacy in-app Sheet edit was stopped after RoomOps moved table editing into Convex.",
    detailsJson: JSON.stringify({ error: RETIRED_ERROR }),
    createdAt: now,
  });
}

// The exports below intentionally keep the exact argument shapes used by
// v0.2 workers and scheduled jobs. They terminate old work without making
// a Google API call or scheduling another retry. Remove them only in a
// later release, after every old job has drained.

export const beginSheetEdit = internalMutation({
  args: {
    requestedByClerkUserId: v.string(),
    clientRequestId: v.string(),
    submissionId: v.string(),
    columnKey: editableColumnValidator,
    value: v.string(),
    leaseToken: v.string(),
  },
  handler: async (): Promise<{
    execute: false;
    status: "failed";
  }> => ({
    execute: false,
    status: "failed",
  }),
});

export const finishSheetEdit = internalMutation({
  args: {
    jobId: v.id("sheetEditJobs"),
    leaseToken: v.string(),
    success: v.boolean(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    await failLegacyEdit(ctx, args.jobId, args.leaseToken);
    return false;
  },
});

export const recoverSheetEditLease = internalMutation({
  args: {
    jobId: v.id("sheetEditJobs"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    await failLegacyEdit(ctx, args.jobId, args.leaseToken);
  },
});

export const retireBookingSync = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<void> => {
    await disableLegacySync(ctx, args.bookingId);
  },
});

export const dispatchSheetSync = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<void> => {
    await disableLegacySync(ctx, args.bookingId);
  },
});

export const renewSheetSyncLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    leaseToken: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args): Promise<"lost"> => {
    await disableLegacySync(ctx, args.bookingId);
    return "lost";
  },
});

export const recoverSheetSyncLease = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    leaseToken: v.string(),
    expectedRevision: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    await disableLegacySync(ctx, args.bookingId);
  },
});

export const retryFailedSheetSync = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    failedAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    await disableLegacySync(ctx, args.bookingId);
  },
});

export const finishSheetSync = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    leaseToken: v.string(),
    expectedRevision: v.number(),
    outcome: v.union(
      v.literal("synced"),
      v.literal("failed"),
      v.literal("stale"),
    ),
    row: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<"lost"> => {
    await disableLegacySync(ctx, args.bookingId);
    return "lost";
  },
});

export const forceSheetReconcile = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<void> => {
    await disableLegacySync(ctx, args.bookingId);
  },
});

export const queueAllSheetReconciliation = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (): Promise<{
    queued: number;
    continuing: boolean;
  }> => ({
    queued: 0,
    continuing: false,
  }),
});
