import { writeAuditLog } from "./lib/auditLog";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireCapability } from "./lib/auth";
import type { Doc } from "./_generated/dataModel";

const logLevel = v.union(
  v.literal("info"),
  v.literal("warning"),
  v.literal("error"),
);
const logCategory = v.union(
  v.literal("authentication"),
  v.literal("user_management"),
  v.literal("jotform"),
  v.literal("booking"),
  v.literal("google_calendar"),
  v.literal("google_sheets"),
  v.literal("system"),
);

export const write = internalMutation({
  args: {
    level: logLevel,
    category: logCategory,
    action: v.string(),
    actorType: v.union(v.literal("user"), v.literal("system")),
    actorId: v.optional(v.string()),
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    message: v.string(),
    detailsJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await writeAuditLog(ctx, {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, "logs.view");
    const requestedLimit = Math.floor(args.limit ?? 100);
    const limit = Math.min(Math.max(requestedLimit, 1), 250);
    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_created_at")
      .order("desc")
      .take(limit);
    const formId = process.env.JOTFORM_FORM_ID?.trim();
    const receipts = new Map<string, Promise<Doc<"externalSubmissions"> | null>>();
    return await Promise.all(logs.map(async log => {
      if (!formId || log.category !== "jotform" || log.entityType !== "jotform_submission" || !log.entityId) return log;
      const submissionId = log.entityId;
      let lookup = receipts.get(submissionId);
      if (!lookup) {
        lookup = ctx.db.query("externalSubmissions").withIndex("by_provider_submission", q =>
          q.eq("provider", "jotform").eq("formId", formId).eq("submissionId", submissionId)).unique();
        receipts.set(submissionId, lookup);
      }
      const receipt = await lookup;
      return receipt ? { ...log, jotformProcessing: {
        state: receipt.state, attempts: receipt.attempts, nextRetryAt: receipt.nextRetryAt,
        attentionNotifiedAt: receipt.attentionNotifiedAt, recoveredAt: receipt.recoveredAt,
      } } : log;
    }));
  },
});

export const recordClientError = mutation({
  args: {
    action: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "logs.view");
    return await writeAuditLog(ctx, {
      level: "warning",
      category: "system",
      action: args.action.slice(0, 120),
      actorType: "user",
      actorId: user.clerkUserId,
      message: args.message.slice(0, 500),
      createdAt: Date.now(),
    });
  },
});
