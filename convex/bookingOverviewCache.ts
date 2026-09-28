import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireCapability } from "./lib/auth";
import { calculateConflictOverview } from "./lib/bookingOverview";

// overviewCounts (convex/bookings.ts) used to be a plain reactive `query`
// that did `.collect()` over every pending/approved/unavailable booking on
// every render, so every booking write re-read the whole table for every
// open dashboard tab. It now reads this single cached row instead.
//
// Recounting is still a full read of every active booking, so it must only
// happen when something changed. A 2-minute cron that always recounted cost
// more than all page views combined (720 full-table reads a day while nobody
// was using the app). Now:
// - `refresh` first reads the single most recently updated booking and skips
//   the recount when nothing changed since the last one. Deletions do not
//   bump `updatedAt`, so they call `markOverviewStale`; a full recount every
//   FULL_RECOUNT_MS is only a safety net.
// - The overview page calls `requestRefresh` while it is visible, so counts
//   stay about a minute fresh for people looking at them.
// - A slow cron (convex/crons.ts) keeps the row current for older clients.
const FULL_RECOUNT_MS = 6 * 60 * 60_000;
const REQUEST_INTERVAL_MS = 60_000;

export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const existing = await ctx.db.query("overviewCountsCache").first();
    if (
      existing &&
      !existing.stale &&
      now - existing.computedAt < FULL_RECOUNT_MS
    ) {
      const latest = await ctx.db
        .query("bookings")
        .withIndex("by_updated_at")
        .order("desc")
        .first();
      if (!latest || latest.updatedAt < existing.computedAt) {
        await ctx.db.patch(existing._id, {
          checkedAt: now,
          refreshQueuedAt: undefined,
        });
        return;
      }
    }
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
        calendarAvailabilityStatus: booking.calendarAvailabilityStatus,
      })),
    );
    const availabilityChecking = pending.filter(
      (booking) => booking.availabilityCheckPending === true,
    ).length;
    const counts = {
      pending: pending.length - availabilityChecking,
      availabilityChecking,
      approved: approved.length,
      unavailable: unavailable.length,
      ...conflictOverview,
      computedAt: now,
      checkedAt: now,
      refreshQueuedAt: undefined,
      stale: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, counts);
    else await ctx.db.insert("overviewCountsCache", counts);
  },
});

// Called by the overview page while it is visible. Reads only the small
// cache row, and queues at most one check per REQUEST_INTERVAL_MS no matter
// how many tabs are open.
export const requestRefresh = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, "bookings.view");
    const now = Date.now();
    const existing = await ctx.db.query("overviewCountsCache").first();
    if (existing) {
      const checkedAt = existing.checkedAt ?? existing.computedAt;
      if (
        now - checkedAt < REQUEST_INTERVAL_MS ||
        now - (existing.refreshQueuedAt ?? 0) < REQUEST_INTERVAL_MS
      ) {
        return;
      }
      await ctx.db.patch(existing._id, { refreshQueuedAt: now });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.bookingOverviewCache.refresh,
      {},
    );
  },
});

export async function markOverviewStale(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db.query("overviewCountsCache").first();
  if (existing && !existing.stale) await ctx.db.patch(existing._id, { stale: true });
}
