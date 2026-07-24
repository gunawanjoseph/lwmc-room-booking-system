import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  requireActionCapability,
  requireActionHeadAdmin,
} from "./lib/actionAuth";

const editableColumnValidator = v.union(
  v.literal("requesterName"),
  v.literal("requesterEmail"),
  v.literal("purpose"),
);

// Compatibility responses for browser tabs loaded from v0.2. The current
// application reads and edits the Convex-backed table through bookings.ts.
export const listSheet = action({
  args: {},
  handler: async (ctx) => {
    await requireActionCapability(ctx, "table.view");
    return {
      columns: [],
      rows: [],
      canEdit: false,
      autoSync: false,
      truncated: false,
    };
  },
});

export const connectionStatus = action({
  args: {},
  handler: async (ctx) => {
    await requireActionHeadAdmin(ctx);
    return {
      credentialsConfigured: false,
      spreadsheetConfigured: false,
      range: "Retired Google Sheets integration",
      autoSync: false,
    };
  },
});

export const resyncAllBookings = action({
  args: {},
  handler: async (ctx) => {
    await requireActionHeadAdmin(ctx);
    return { queued: 0, continuing: false };
  },
});

export const editCell = action({
  args: {
    clientRequestId: v.string(),
    submissionId: v.string(),
    columnKey: editableColumnValidator,
    value: v.string(),
  },
  handler: async (ctx): Promise<never> => {
    await requireActionCapability(ctx, "table.edit");
    throw new ConvexError({
      code: "GOOGLE_SHEETS_API_RETIRED",
      message:
        "The Google Sheets integration was retired. Edit the Convex booking data table instead.",
    });
  },
});

// Exact legacy worker entry points are retained for one transition
// release. They only retire the old lease; no Google request is made.
export const performSheetSync = internalAction({
  args: {
    bookingId: v.id("bookings"),
    leaseToken: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(
      internal.googleSheetsDb.retireBookingSync,
      { bookingId: args.bookingId },
    );
  },
});

export const syncBooking = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(
      internal.googleSheetsDb.retireBookingSync,
      args,
    );
  },
});
