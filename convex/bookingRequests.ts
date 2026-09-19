import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { requireCapability } from "./lib/auth";
import { writeAuditLog } from "./lib/auditLog";
import { requestMeetings, requestScope, checkRequestWindow, REQUEST_NOTICE_MS } from "./lib/requesterRules";

const scopeValidator = v.union(v.literal("occurrence"), v.literal("following"));
const kindValidator = v.union(v.literal("change"), v.literal("cancel"));
const emailKey = (email: string) => email.trim().toLowerCase();

// Only the approval email worker can issue bearer links. Never return links to the admin list.
export const issueLink = internalMutation({
  args: { deliveryId: v.id("emailDeliveries"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.kind !== "requester_approved" || delivery.status !== "sending" || delivery.leaseToken !== args.leaseToken) return null;
    const booking = await ctx.db.get(delivery.bookingId);
    if (!booking || booking.status !== "approved" || emailKey(booking.requesterEmail) !== emailKey(delivery.recipientEmail)) return null;
    const links = await ctx.db.query("requesterLinks").withIndex("by_booking", q => q.eq("bookingId", booking._id)).collect();
    const existing = links.find(link => link.email === emailKey(booking.requesterEmail));
    if (existing) return existing.token;
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
    await ctx.db.insert("requesterLinks", { bookingId: booking._id, token, email: emailKey(booking.requesterEmail), createdAt: Date.now() });
    return token;
  },
});

async function authorizedBooking(ctx: QueryCtx | MutationCtx, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const link = await ctx.db.query("requesterLinks").withIndex("by_token", q => q.eq("token", token)).unique();
  if (!link) return null;
  const booking = await ctx.db.get(link.bookingId);
  if (!booking || booking.status !== "approved" || emailKey(booking.requesterEmail) !== link.email) return null;
  return booking;
}

export const view = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const booking = await authorizedBooking(ctx, token);
    if (!booking) return null;
    const requests = await ctx.db.query("bookingRequests").withIndex("by_booking", q => q.eq("bookingId", booking._id)).order("desc").take(100);
    return { timezone: booking.timezone, version: JSON.stringify(requestMeetings(booking)),
      meetings: requestMeetings(booking).map(item => ({ ...item, deadline: item.startAt - REQUEST_NOTICE_MS })),
      requests: requests.map(item => ({ kind: item.kind, scope: item.scope, sequence: item.sequence,
        message: item.message, status: item.status, response: item.response, createdAt: item.createdAt })),
    };
  },
});

export const submit = mutation({
  args: { token: v.string(), sequence: v.number(), scope: scopeValidator, kind: kindValidator, message: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const booking = await authorizedBooking(ctx, args.token);
    if (!booking) throw new Error("This link is unavailable. Contact the booking administrator.");
    if (booking.deletionToken || booking.calendarSyncStatus === "creating") throw new Error("This booking is being updated. Please try again shortly.");
    if (args.version !== JSON.stringify(requestMeetings(booking))) throw new Error("The booking has changed. Refresh and review the latest details before submitting.");
    const selected = requestScope(booking, args.sequence, args.scope);
    checkRequestWindow(selected, Date.now());
    const message = args.message.trim();
    if (message.length > 4000 || (args.kind === "change" && message.length < 5)) throw new Error("Describe the requested changes in 5–4000 characters.");
    const history = await ctx.db.query("bookingRequests").withIndex("by_booking", q => q.eq("bookingId", booking._id)).take(100);
    const pending = history.find(item => item.status === "pending");
    if (pending) {
      if (pending.kind === args.kind && pending.scope === args.scope && pending.sequence === args.sequence && pending.message === message) return { submitted: true };
      throw new Error("There is already a request awaiting review for this booking.");
    }
    if (history.length >= 100) throw new Error("Please contact the booking administrator for further changes.");
    const id = await ctx.db.insert("bookingRequests", { bookingId: booking._id, requesterEmail: booking.requesterEmail,
      requesterName: booking.requesterName, kind: args.kind, scope: args.scope, sequence: args.sequence,
      snapshot: JSON.stringify(selected), message, timezone: booking.timezone, status: "pending", createdAt: Date.now() });
    await writeAuditLog(ctx, { level: "info", category: "booking", action: "requester_booking_request",
      actorType: "system", entityType: "bookingRequest", entityId: id,
      message: "A requestor submitted a booking change or cancellation request.", createdAt: Date.now() });
    return { submitted: true };
  },
});

export const list = query({
  args: { status: v.union(v.literal("pending"), v.literal("completed"), v.literal("declined")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireCapability(ctx, "bookings.edit");
    return await ctx.db.query("bookingRequests").withIndex("by_status", q => q.eq("status", args.status)).order("desc").paginate(args.paginationOpts);
  },
});

// Admins apply the request through the existing edit/delete flows first. Never bypass Google verification.
export const resolve = mutation({
  args: { requestId: v.id("bookingRequests"), outcome: v.union(v.literal("completed"), v.literal("declined")), response: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCapability(ctx, "bookings.edit");
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "pending") throw new Error("This request has already been reviewed.");
    const response = args.response.trim();
    if (!response || response.length > 4000) throw new Error("Add a response of up to 4000 characters.");
    if (args.outcome === "completed") {
      const booking = await ctx.db.get(request.bookingId);
      if (booking && (booking.deletionToken || booking.calendarSyncStatus !== "synced")) throw new Error("Finish the booking update and Google Calendar sync first.");
      const before = JSON.parse(request.snapshot) as ReturnType<typeof requestMeetings>;
      const current = booking ? requestMeetings(booking) : [];
      if (request.kind === "cancel" && before.some(old => current.some(item => item.sequence === old.sequence))) throw new Error("Remove all requested meetings before completing the cancellation.");
      if (request.kind === "change" && (!booking || before.some(old => {
        const item = current.find(row => row.sequence === old.sequence);
        return !item || JSON.stringify(item) === JSON.stringify(old);
      }))) throw new Error("Apply the changes to every requested meeting before completing this request.");
    }
    await ctx.db.patch(request._id, { status: args.outcome, response, resolvedAt: Date.now(), resolvedBy: actor.clerkUserId });
    await writeAuditLog(ctx, { level: "info", category: "booking", action: "requester_request_reviewed", actorType: "user",
      actorId: actor.clerkUserId, entityType: "bookingRequest", entityId: request._id, message: "Booking request reviewed: " + args.outcome, createdAt: Date.now() });
  },
});
