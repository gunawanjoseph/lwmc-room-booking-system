import { internalMutation } from "./_generated/server";
import { calculateConflictOverview } from "./lib/bookingOverview";

// overviewCounts (convex/bookings.ts) used to be a plain reactive `query`
// that did `.collect()` over every pending/approved/unavailable booking on
// every single render, and Convex re-runs + re-sends a reactive query's full
// result set whenever ANY document in its read range changes. Since
// `approved` bookings are never archived, that set only grows, and the
// dashboard home page keeps this query subscribed permanently — so every
// booking write in the whole system re-triggered a full-table read for every
// open dashboard tab. That's a much bigger contributor to read bandwidth
// than the hourly reminders sweep this file's sibling fix addressed.
//
// A live, exactly-up-to-the-second count isn't actually needed for a
// dashboard overview tile, so instead this recomputes the same numbers on a
// fixed schedule (see convex/crons.ts) and stores them in a single cached
// row. The `overviewCounts` query then just reads that one small document —
// cheap, and it only changes (and only re-pushes to clients) once per
// refresh instead of once per booking write.
export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
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
      computedAt: Date.now(),
    };
    const existing = await ctx.db.query("overviewCountsCache").first();
    if (existing) await ctx.db.patch(existing._id, counts);
    else await ctx.db.insert("overviewCountsCache", counts);
  },
});
