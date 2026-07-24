import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireCapability } from "./lib/auth";

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
    return await ctx.db.insert("auditLogs", {
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
    return await ctx.db
      .query("auditLogs")
      .withIndex("by_created_at")
      .order("desc")
      .take(limit);
  },
});

export const recordClientError = mutation({
  args: {
    action: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireCapability(ctx, "logs.view");
    return await ctx.db.insert("auditLogs", {
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
