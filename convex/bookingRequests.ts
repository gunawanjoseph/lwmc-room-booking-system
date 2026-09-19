import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { requireCapability } from "./lib/auth";
import { writeAuditLog } from "./lib/auditLog";
import { requestMeetings, requestScope, checkRequestWindow, REQUEST_NOTICE_MS } from "./lib/requesterRules";

import { requestMinistries } from "./lib/requestMinistries";
const stale = () => new ConvexError("This booking has been updated. Please review the latest booking details before trying again.");
const scopeValidator = v.union(v.literal("occurrence"), v.literal("following"));
const kindValidator = v.union(v.literal("change"), v.literal("cancel"));
const requestKey = (row: {operationKey?:string;createdAt:number}) => row.operationKey ?? `legacy:${row.createdAt}`;
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
    const existing = links.find(link => !link.revokedAt && link.email === emailKey(booking.requesterEmail));
    if (existing) return existing.token;
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
    await ctx.db.insert("requesterLinks", { bookingId: booking._id, token, email: emailKey(booking.requesterEmail), createdAt: Date.now() });
    return token;
  },
});

async function authorizedBooking(ctx: QueryCtx | MutationCtx, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const link = await ctx.db.query("requesterLinks").withIndex("by_token", q => q.eq("token", token)).unique();
  if (!link || link.revokedAt) return null;
  const booking = await ctx.db.get(link.bookingId);
  if (!booking || booking.status !== "approved" || emailKey(booking.requesterEmail) !== link.email) return null;
  return booking;
}

export const view = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const booking = await authorizedBooking(ctx, token);
    // A cancelled booking retains a receipt behind the same bearer link.
    const link = /^[a-f0-9]{64}$/.test(token) ? await ctx.db.query("requesterLinks").withIndex("by_token", q => q.eq("token", token)).unique() : null;
    if (!booking && (!link || link.revokedAt || await ctx.db.get(link.bookingId))) return null;
    const history = await ctx.db.query("bookingRequests").withIndex("by_booking", q => q.eq("bookingId", booking?._id ?? link!.bookingId)).order("desc").take(100);
    if (!booking && !history.some(item => item.kind === "cancel" && item.status === "completed" && emailKey(item.requesterEmail) === link!.email)) return null;
    return { timezone: booking?.timezone ?? history[0].timezone, version: booking ? requestVersion(booking) : "",
      ministries: requestMinistries(), recurrenceFrequency: booking?.recurrenceFrequency,
      editCount: booking?.requesterEditCount ?? history.filter(row => row.kind === "change").reduce((total,row) => total + (row.requestRevision ?? 1), 0),
      rooms: ROOM_OPTIONS, busy: !!booking?.requesterOperationId,
      meetings: booking ? requestMeetings(booking).map(item => ({ ...item, deadline: item.startAt - REQUEST_NOTICE_MS })) : [],
      requests: history.map(item => ({ kind: item.kind, scope: item.scope, sequence: item.sequence,
        message: item.message, status: item.status, response: item.response, createdAt: item.createdAt,
        requestKey: requestKey(item), requestRevision: item.requestRevision ?? 1, proposed: item.proposal, before: item.snapshot })),
    };
  },
});

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { BOOKABLE_GOOGLE_CALENDAR_VENUES, resolveBookableVenueSelection } from "./lib/googleCalendar";
import { findConflicts, addClaims, removeClaims, deleteBookingRecord, clearReciprocalConflictWarnings, clearBlockingConflictReferences } from "./bookings";
import { requestCandidate, requestVersion, requestNotices } from "./lib/requesterWorkflow";
import { calendarEventRefValidator } from "./schema";
import { JOTFORM_LEGACY_COMBINED_VENUE_ALIASES } from "../shared/jotformConstants";
const ROOM_OPTIONS = [...new Set([...BOOKABLE_GOOGLE_CALENDAR_VENUES, ...Object.values(JOTFORM_LEGACY_COMBINED_VENUE_ALIASES).flat().map(room => resolveBookableVenueSelection(room).displayName)])];
const LEASE = 31 * 60_000;
const editValidator = v.object({ room: v.string(), startAt: v.number(), endAt: v.number(), eventName: v.string(), purpose: v.string(), ministry: v.string(), otherMinistry: v.optional(v.string()), responses: v.optional(v.array(v.object({ qid: v.string(), value: v.string() }))) });
const statusValidator = v.union(v.literal("pending"), v.literal("completed"), v.literal("declined"), v.literal("checking"), v.literal("applying"), v.literal("failed"));
const active = (request: Doc<"bookingRequests">) => ["checking", "pending", "applying", "failed"].includes(request.status);
async function audit(ctx: MutationCtx, request: Doc<"bookingRequests">, message: string, error = false) {
  await writeAuditLog(ctx, { level: error ? "error" : "info", category: "booking", action: "requester_booking_operation",
    actorType: request.resolvedBy ? "user" : "system", actorId: request.resolvedBy, entityType: "bookingRequest", entityId: request._id,
    message, detailsJson: JSON.stringify({ scope: request.scope, sequence: request.sequence, kind: request.kind, status: request.status }), createdAt: Date.now() });
}
async function schedule(ctx: MutationCtx, id: Id<"bookingRequests">) {
  await ctx.scheduler.runAfter(0, internal.googleCalendar.processRequesterOperation, { requestId: id });
}
async function reject(ctx: MutationCtx, request: Doc<"bookingRequests">, response: string, unavailable = true) {
  await ctx.db.patch(request._id, { status: "declined", response, resolvedAt: Date.now(), workerToken: undefined, leaseUntil: undefined });
  const updated = (await ctx.db.get(request._id))!;
  await requestNotices(ctx, updated, unavailable ? "unavailable" : "declined");
  await audit(ctx, updated, response);
}
async function reserve(ctx: MutationCtx, request: Doc<"bookingRequests">, booking: Doc<"bookings">, candidate: Doc<"bookings">) {
  const deliveries = await ctx.db.query("emailDeliveries").withIndex("by_booking", q => q.eq("bookingId", booking._id)).collect();
  if (deliveries.some(row => row.status === "sending" && (row.leaseExpiresAt ?? 0) > Date.now())) throw new ConvexError("A booking email is being sent. Please try again shortly.");
  await ctx.db.patch(booking._id, { requesterOperationId: request._id, calendarSyncStatus: "creating", calendarSyncToken: `request:${request._id}`, calendarSyncLeaseExpiresAt: Date.now() + LEASE });
  // Keep original claims too until Google and the database both commit.
  if (request.kind === "change") await addClaims(ctx, booking._id, { occurrences: candidate.occurrences!, resolvedVenues: candidate.resolvedVenues ?? [candidate.room] });
}
async function unreserve(ctx: MutationCtx, request: Doc<"bookingRequests">, booking: Doc<"bookings">) {
  if (booking.requesterOperationId !== request._id) return;
  await removeClaims(ctx, booking._id);
  await addClaims(ctx, booking._id, { occurrences: booking.occurrences ?? [{ sequence: 0, startAt: booking.startAt, endAt: booking.endAt }], resolvedVenues: booking.resolvedVenues ?? [booking.room] });
  await ctx.db.patch(booking._id, { requesterOperationId: undefined, calendarSyncToken: undefined, calendarSyncLeaseExpiresAt: undefined, calendarSyncStatus: "synced" });
}

// Old clients cannot silently create a free-text-only request after deployment.
export const submit = mutation({
  args: { token: v.string(), sequence: v.number(), scope: scopeValidator, kind: kindValidator, message: v.string(), version: v.string(),
    expectedRequestKey: v.optional(v.string()), expectedRequestRevision: v.optional(v.number()),
    edit: v.optional(editValidator), operationKey: v.optional(v.string()), confirmed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const booking = await authorizedBooking(ctx, args.token);
    if (!booking) {
      const link = /^[a-f0-9]{64}$/.test(args.token) ? await ctx.db.query("requesterLinks").withIndex("by_token", q => q.eq("token", args.token)).unique() : null;
      if (link && !link.revokedAt && !await ctx.db.get(link.bookingId) && args.kind === "cancel" && args.operationKey) {
        const receipts = await ctx.db.query("bookingRequests").withIndex("by_booking", q => q.eq("bookingId", link.bookingId)).take(100);
        if (receipts.some(row => row.operationKey === args.operationKey && row.kind === "cancel" && row.status === "completed" && emailKey(row.requesterEmail) === link.email)) return { submitted: true };
      }
      throw new ConvexError("This link is unavailable. Contact the booking administrator.");
    }
    if (!args.operationKey || !/^[a-zA-Z0-9-]{16,80}$/.test(args.operationKey)) throw new ConvexError("Refresh this page before submitting.");
    const history = await ctx.db.query("bookingRequests").withIndex("by_booking", q => q.eq("bookingId", booking._id)).take(100);
    const duplicate = history.find(item => item.operationKey === args.operationKey);
    if (duplicate) {
      if (duplicate.kind !== args.kind || duplicate.sequence !== args.sequence || duplicate.scope !== args.scope || duplicate.message !== args.message.trim() || (args.kind === "change" && duplicate.proposal !== JSON.stringify(args.edit))) throw new ConvexError("This submission key belongs to a different request. Reopen the editor.");
      return { submitted: true };
    }
    for (const previous of history.flatMap(row => row.revisions ?? [])) {
      if (previous.operationKey !== args.operationKey) continue;
      if (args.kind !== "change" || previous.sequence !== args.sequence || previous.scope !== args.scope || previous.message !== args.message.trim() || previous.proposal !== JSON.stringify(args.edit)) throw stale();
      return { submitted: true };
    }
    if (booking.deletionToken || booking.calendarSyncToken || booking.calendarSyncStatus === "creating") throw new ConvexError("This booking is being updated. Please try again shortly.");
    if (args.version !== requestVersion(booking)) throw new ConvexError("The booking has changed. Review the latest details before submitting.");
    if (args.kind === "change" && !args.edit) throw new ConvexError("Refresh this page to use the booking editor.");
    if (args.kind === "cancel" && args.confirmed !== true) throw new ConvexError("Confirm the cancellation first.");
    if (args.message.length > 4000) throw new ConvexError("Keep your message within 4000 characters.");
    if (history.length >= 100) throw new ConvexError("Contact the administrator for further changes.");
    const pending = history.find(active);
    const updating = args.kind === "change" && !!args.expectedRequestKey;
    if (updating && (!pending || pending.status !== "pending" || requestKey(pending) !== args.expectedRequestKey || (pending.requestRevision ?? 1) !== args.expectedRequestRevision)) throw stale();
    if (pending && !(pending.status === "pending" && (args.kind === "cancel" || updating))) throw stale();
    const editCount = booking.requesterEditCount ?? history.filter(row => row.kind === "change").reduce((sum,row) => sum + (row.requestRevision ?? 1), 0);
    if (args.kind === "change" && editCount >= 3) throw new ConvexError("You have reached the maximum of 3 edit requests for this booking. You can still cancel eligible meetings or contact the administrator.");
    let candidate: Doc<"bookings">;
    try { candidate = requestCandidate(booking, args.sequence, args.scope, args.kind === "change" ? args.edit : undefined); }
    catch (error) { throw new ConvexError(error instanceof Error ? error.message : "Invalid booking changes."); }
    const conflicts = args.kind === "change" ? await findConflicts(ctx, { occurrences: candidate.occurrences!, resolvedVenues: candidate.resolvedVenues ?? [candidate.room], excludeBookingId: booking._id }) : [];
    // The booking revision is the common compare-and-swap fence used by admin
    // edits/deletions too. Convex retries racing transactions against fresh state.
    const revisedBooking = { ...booking, revision: (booking.revision ?? 0) + 1 };
    await ctx.db.patch(booking._id, { revision: revisedBooking.revision, requesterEditCount: editCount + (args.kind === "change" ? 1 : 0), updatedAt: Date.now() });
    const values = {
      bookingId: booking._id, requesterEmail: booking.requesterEmail, requesterName: booking.requesterName,
      kind: args.kind, scope: args.scope, sequence: args.sequence, snapshot: JSON.stringify(requestScope(booking, args.sequence, args.scope)),
      original: JSON.stringify(booking), candidate: JSON.stringify(candidate), proposal: args.kind === "change" && args.edit ? JSON.stringify(args.edit) : undefined,
      version: requestVersion(revisedBooking), requestRevision: updating ? (pending!.requestRevision ?? 1) + 1 : 1, operationKey: args.operationKey, message: args.message.trim(), timezone: booking.timezone,
      status: args.kind === "cancel" ? "applying" as const : "checking" as const, phase: "validate" as const, createdAt: Date.now(), attempts: 0,
    };
    let requestId: Id<"bookingRequests">;
    if (updating) {
      requestId = pending!._id;
      await ctx.db.patch(requestId, { ...values, createdAt: pending!.createdAt, response: undefined, resolvedAt: undefined, resolvedBy: undefined, workerToken: undefined, leaseUntil: undefined,
        revisions: [...(pending!.revisions ?? []), { revision: pending!.requestRevision ?? 1, snapshot: pending!.snapshot, version: pending!.version, operationKey: requestKey(pending!), proposal: pending!.proposal, message: pending!.message, sequence: pending!.sequence, scope: pending!.scope, createdAt: Date.now() }] });
    } else requestId = await ctx.db.insert("bookingRequests", values);
    const request = (await ctx.db.get(requestId))!;
    if (pending && !updating) {
      if (pending.original && pending.candidate) await reject(ctx, pending, "Superseded by the requester's cancellation.", false);
      else await ctx.db.patch(pending._id, { status: "declined", response: "Superseded by cancellation.", resolvedAt: Date.now() });
    }
    if (conflicts.length) await reject(ctx, request, "The requested room or time is unavailable. Your original booking remains unchanged.");
    else {
      if (args.kind === "cancel") await reserve(ctx, request, booking, candidate);
      await schedule(ctx, requestId);
    }
    await audit(ctx, request, args.kind === "cancel" ? "Requester confirmed cancellation; Calendar cleanup started." : "Requester submitted structured booking changes for availability checking.");
    return { submitted: true };
  },
});

export const list = query({ args: { status: v.union(statusValidator, v.literal("all")), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  await requireCapability(ctx, "bookings.approve");
  const result = args.status === "all"
    ? await ctx.db.query("bookingRequests").order("desc").paginate(args.paginationOpts)
    : await ctx.db.query("bookingRequests").withIndex("by_status", q => q.eq("status", args.status as Exclude<typeof args.status,"all">)).order("desc").paginate(args.paginationOpts);
  // Never return full worker snapshots (which can contain calendar references) to the UI.
  return { ...result, page: result.page.map(row => ({ _id: row._id, kind: row.kind, requesterName: row.requesterName,
    requesterEmail: row.requesterEmail, snapshot: row.snapshot, proposal: row.proposal, scope: row.scope, timezone: row.timezone,
    requestRevision: row.requestRevision ?? 1, recurrenceFrequency: row.original ? (JSON.parse(row.original) as Doc<"bookings">).recurrenceFrequency : undefined,
    message: row.message, status: row.status, response: row.response, createdAt: row.createdAt, resolvedAt: row.resolvedAt })) };
}});
export const resolve = mutation({ args: { expectedRequestRevision: v.number(), requestId: v.id("bookingRequests"), outcome: v.union(v.literal("completed"), v.literal("declined")), response: v.string() }, handler: async (ctx, args) => {
  const actor = await requireCapability(ctx, "bookings.approve");
  const request = await ctx.db.get(args.requestId);
  if (!request) throw new ConvexError("This request no longer exists.");
  if (request.status !== "pending" || (request.requestRevision ?? 1) !== args.expectedRequestRevision) throw stale();
  if (args.response.length > 4000) throw new ConvexError("Keep your response within 4000 characters.");
  await ctx.db.patch(request._id, { resolvedBy: actor.clerkUserId, response: args.response.trim() });
  const updated = (await ctx.db.get(request._id))!;
  // Legacy free-text requests remain readable and can be declined; never guess their intent.
  if (args.outcome === "declined") {
    const current = await ctx.db.get(request.bookingId);
    if (!current || current.calendarSyncToken || current.deletionToken || (request.version && request.version !== requestVersion(current))) throw stale();
    await ctx.db.patch(current._id, { revision: (current.revision ?? 0) + 1, updatedAt: Date.now() });
    if (request.original && request.candidate) await reject(ctx, updated, args.response.trim() || "The requested changes were not approved.", false);
    else await ctx.db.patch(request._id, { status: "declined", resolvedAt: Date.now() });
    return;
  }
  if (!request.proposal || !request.original || !request.candidate || request.kind !== "change") throw new ConvexError("This older request has no structured changes. Ask the requester to resubmit using their link.");
  const booking = await ctx.db.get(request.bookingId);
  if (!booking || request.version !== requestVersion(booking) || booking.status !== "approved" || emailKey(booking.requesterEmail) !== emailKey(request.requesterEmail)) {
    await reject(ctx, updated, "The booking changed after this request. Please submit a new request.", false); return {message:"This booking has been updated. The outdated request was not applied. Review the latest booking details."};
  }
  if (booking.requesterOperationId || booking.calendarSyncToken || booking.deletionToken) throw new ConvexError("Wait for the current booking operation to finish.");
  let candidate: Doc<"bookings">;
  try { candidate = requestCandidate(booking, request.sequence, request.scope, JSON.parse(request.proposal)); }
  catch { await reject(ctx, updated, "The request is no longer valid. Review the current booking, ministry options and two-hour cutoff before submitting again.", false); return {message:"This request can no longer be applied. The original booking remains unchanged and the requester has been notified."}; }
  const conflicts = await findConflicts(ctx, { occurrences: candidate.occurrences!, resolvedVenues: candidate.resolvedVenues ?? [candidate.room], excludeBookingId: booking._id });
  if (conflicts.length) { await reject(ctx, updated, "The requested room or time is no longer available. Your original booking remains unchanged."); return {message:"The room or time is no longer available. The original booking remains unchanged and the requester has been notified."}; }
  const accepted = { ...booking, revision: (booking.revision ?? 0) + 1 };
  await ctx.db.patch(booking._id, { revision: accepted.revision, updatedAt: Date.now() });
  await ctx.db.patch(request._id, { version: requestVersion(accepted), status: "applying", candidate: JSON.stringify(candidate), phase: "validate", attempts: 0 });
  await reserve(ctx, updated, booking, candidate);
  await schedule(ctx, request._id);
  await audit(ctx, updated, "Approver accepted changes; reservations held while Calendar is synchronized.");
}});

export const retry = mutation({ args: { expectedRequestRevision: v.number(), requestId: v.id("bookingRequests") }, handler: async (ctx, args) => {
  await requireCapability(ctx, "bookings.approve");
  const request = await ctx.db.get(args.requestId);
  if (!request || request.status !== "failed" || (request.requestRevision ?? 1) !== args.expectedRequestRevision) throw stale();
  await ctx.db.patch(request._id, { status: request.resolvedBy || request.kind === "cancel" ? "applying" : "checking", attempts: 0, response: undefined });
  await schedule(ctx, request._id);
}});
export const claim = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string() }, handler: async (ctx, args): Promise<Doc<"bookingRequests"> | null> => {
  const request = await ctx.db.get(args.requestId);
  if (!request || !["checking", "applying"].includes(request.status) || (request.leaseUntil ?? 0) > Date.now()) return null;
  await ctx.db.patch(request._id, { workerToken: args.token, leaseUntil: Date.now() + LEASE, attempts: (request.attempts ?? 0) + 1 });
  await ctx.scheduler.runAfter(LEASE, internal.bookingRequests.recover, { requestId: request._id, token: args.token });
  return (await ctx.db.get(request._id))!;
}});
export const getBooking = internalQuery({ args: { bookingId: v.id("bookings") }, handler: (ctx, args) => ctx.db.get(args.bookingId) });
export const checked = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string(), available: v.boolean() }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || request.workerToken !== args.token || request.phase !== "validate") return false;
  const booking = await ctx.db.get(request.bookingId);
  const candidate = JSON.parse(request.candidate!) as Doc<"bookings">;
  let valid = !!booking && booking.status === "approved" && request.version === requestVersion(booking) && emailKey(booking.requesterEmail) === emailKey(request.requesterEmail);
  try {
    checkRequestWindow(JSON.parse(request.snapshot), Date.now());
    if (request.kind === "change") { const ids = new Set((JSON.parse(request.snapshot) as Array<{sequence:number}>).map(row => row.sequence)); checkRequestWindow(requestMeetings(candidate).filter(row => ids.has(row.sequence)), Date.now()); }
  } catch { valid = false; }
  const conflicts = valid && request.kind === "change" ? await findConflicts(ctx, { occurrences: candidate.occurrences!, resolvedVenues: candidate.resolvedVenues ?? [candidate.room], excludeBookingId: request.bookingId }) : [];
  if (!valid || !args.available || conflicts.length) {
    if (booking) await unreserve(ctx, request, booking);
    await reject(ctx, request, !valid ? "The booking changed or the two-hour deadline passed. The request was not applied." : "The requested room or time is unavailable. Your original booking remains unchanged.", valid);
    return false;
  }
  if (request.status === "checking") {
    await ctx.db.patch(request._id, { status: "pending", workerToken: undefined, leaseUntil: undefined });
    await requestNotices(ctx, (await ctx.db.get(request._id))!, "pending");
    return false;
  }
  return true;
}});
export const savePhase = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string(), phase: v.union(v.literal("create"), v.literal("delete"), v.literal("rollback")), retained: v.array(calendarEventRefValidator), targets: v.array(calendarEventRefValidator), replacements: v.array(calendarEventRefValidator) }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || request.workerToken !== args.token || request.status !== "applying") throw new ConvexError("Operation ownership changed.");
  await ctx.db.patch(request._id, { phase: args.phase, retained: args.retained, targets: args.targets, replacements: args.replacements });
}});
export const complete = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string(), events: v.array(calendarEventRefValidator) }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (request?.status === "completed") return;
  if (!request || request.workerToken !== args.token || request.phase !== "delete") throw new ConvexError("Operation ownership changed.");
  const booking = await ctx.db.get(request.bookingId);
  if (!booking || booking.requesterOperationId !== request._id) throw new ConvexError("Booking ownership changed.");
  const candidate = JSON.parse(request.candidate!) as Doc<"bookings">;
  const now = Date.now();
  if (!candidate.occurrences!.length) await deleteBookingRecord(ctx, booking, request.resolvedBy ?? "requester");
  else {
    await clearReciprocalConflictWarnings(ctx, booking, now);
    await clearBlockingConflictReferences(ctx, booking._id, now);
    await removeClaims(ctx, booking._id);
    await addClaims(ctx, booking._id, { occurrences: candidate.occurrences!, resolvedVenues: candidate.resolvedVenues ?? [candidate.room] });
    await ctx.db.patch(booking._id, { occurrences: candidate.occurrences, recurrenceCount: candidate.occurrences!.length,
      startAt: candidate.startAt, endAt: candidate.endAt,
      room: candidate.room, roomKey: candidate.roomKey, resolvedVenues: candidate.resolvedVenues,
      eventName: candidate.eventName, purpose: candidate.purpose, ministry: candidate.ministry,
      formResponses: candidate.formResponses, recurrenceHasEndDate: candidate.recurrenceHasEndDate, recurrenceUntilAt: candidate.recurrenceUntilAt,
      sheetRequesterName: undefined, sheetRequesterEmail: undefined, sheetPurpose: undefined,
      revision: (booking.revision ?? 0) + 1, updatedAt: now,
      calendarSyncStatus: "synced", calendarSyncedAt: now, calendarEvents: args.events, calendarAttemptedEvents: undefined,
      calendarSyncToken: undefined, calendarSyncLeaseExpiresAt: undefined, calendarSyncError: undefined, requesterOperationId: undefined,
      conflictWarningBookingIds: undefined, conflictBookingId: undefined, calendarAvailabilityStatus: "available", calendarConflictSummary: undefined });
    // Invalidate queued old decision emails; they must not describe a replaced schedule.
    const deliveries = await ctx.db.query("emailDeliveries").withIndex("by_booking", q => q.eq("bookingId", booking._id)).collect();
    for (const delivery of deliveries) if (!["sent", "cancelled"].includes(delivery.status)) await ctx.db.patch(delivery._id, { status: "cancelled", leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: now });
  }
  await ctx.db.patch(request._id, { status: "completed", resolvedAt: now, workerToken: undefined, leaseUntil: undefined, response: request.kind === "cancel" ? "The selected meetings have been cancelled." : "Your changes have been approved and synchronized." });
  const updated = (await ctx.db.get(request._id))!;
  await requestNotices(ctx, updated, "completed");
  await audit(ctx, updated, request.kind === "cancel" ? "Requester cancellation completed; Calendar deletion verified and reservations released." : "Approved requester changes committed after Calendar synchronization.");
}});
export const failure = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string(), errorMessage: v.optional(v.string()) }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || request.workerToken !== args.token) return;
  const failed = (request.attempts ?? 0) >= 5;
  await ctx.db.patch(request._id, { status: failed ? "failed" : request.status, workerToken: undefined, leaseUntil: undefined,
    response: "Calendar could not finish this operation. RoomOps will retry; completion is not yet confirmed." });
  if (failed) {
    const booking = await ctx.db.get(request.bookingId);
    if (booking?.requesterOperationId === request._id) await ctx.db.patch(booking._id, { calendarSyncStatus: "failed" });
  }
  if (!failed) await ctx.scheduler.runAfter(60_000 * 2 ** ((request.attempts ?? 1) - 1), internal.googleCalendar.processRequesterOperation, { requestId: request._id });
  await writeAuditLog(ctx, { level: "error", category: "google_calendar", action: "requester_operation_failed", actorType: "system",
    entityType: "bookingRequest", entityId: request._id, message: "Requester operation failed during Calendar synchronization; reservations remain protected. Review Edit Requests.",
    detailsJson: JSON.stringify({ phase: request.phase, attempt: request.attempts, error: args.errorMessage?.slice(0, 1000) }), createdAt: Date.now() });
}});
export const recover = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string() }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || request.workerToken !== args.token) return;
  if ((request.leaseUntil ?? 0) > Date.now()) { await ctx.scheduler.runAfter(request.leaseUntil! - Date.now() + 1000, internal.bookingRequests.recover, args); return; }
  if ((request.attempts ?? 0) >= 5) {
    await ctx.db.patch(request._id, { status: "failed", workerToken: undefined, leaseUntil: undefined, response: "Synchronization timed out. An administrator can retry from Edit Requests." });
    await audit(ctx, request, "Requester operation timed out repeatedly; recovery needs attention.", true);
  } else {
    await ctx.db.patch(request._id, { workerToken: undefined, leaseUntil: undefined });
    await schedule(ctx, request._id);
  }
}});

export const abort = internalMutation({ args: { requestId: v.id("bookingRequests"), token: v.string() }, handler: async (ctx, args) => {
  const request = await ctx.db.get(args.requestId);
  if (!request || request.workerToken !== args.token || request.phase !== "rollback") return;
  const booking = await ctx.db.get(request.bookingId);
  if (booking) await unreserve(ctx, request, booking);
  await reject(ctx, request, "The requested room or time became unavailable. Your original booking remains unchanged.");
}});
export const revokeLink = mutation({ args: { bookingId: v.id("bookings") }, handler: async (ctx, args) => {
  await requireCapability(ctx, "bookings.edit");
  const links = await ctx.db.query("requesterLinks").withIndex("by_booking", q => q.eq("bookingId", args.bookingId)).collect();
  for (const link of links) await ctx.db.patch(link._id, { revokedAt: Date.now() });
}});
