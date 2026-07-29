import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireHeadAdmin } from "./lib/auth";

function conflictAdminError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    conflictAdminError(
      "CONFLICT_ADMIN_EMAIL_INVALID",
      "Enter a valid conflict administrator email address.",
    );
  }
  return email;
}

function normalizeDisplayName(
  value: string | undefined,
): string | undefined {
  const name = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return name || undefined;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireHeadAdmin(ctx);
    return await ctx.db
      .query("conflictAdmins")
      .withIndex("by_email")
      .collect();
  },
});

export const upsert = mutation({
  args: {
    email: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    const email = normalizeEmail(args.email);
    const displayName = normalizeDisplayName(args.displayName);
    const now = Date.now();
    const existing = await ctx.db
      .query("conflictAdmins")
      .withIndex("by_email", (range) => range.eq("email", email))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        active: true,
        displayName,
        updatedAt: now,
        updatedBy: user.clerkUserId,
      });
      return existing._id;
    }
    return await ctx.db.insert("conflictAdmins", {
      email,
      displayName,
      active: true,
      createdAt: now,
      createdBy: user.clerkUserId,
      updatedAt: now,
      updatedBy: user.clerkUserId,
    });
  },
});

export const setActive = mutation({
  args: {
    conflictAdminId: v.id("conflictAdmins"),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    const administrator = await ctx.db.get(args.conflictAdminId);
    if (!administrator) {
      conflictAdminError(
        "CONFLICT_ADMIN_NOT_FOUND",
        "That conflict administrator no longer exists.",
      );
    }
    await ctx.db.patch(administrator._id, {
      active: args.active,
      updatedAt: Date.now(),
      updatedBy: user.clerkUserId,
    });
  },
});

export const remove = mutation({
  args: {
    conflictAdminId: v.id("conflictAdmins"),
  },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    const administrator = await ctx.db.get(args.conflictAdminId);
    if (!administrator) {
      conflictAdminError(
        "CONFLICT_ADMIN_NOT_FOUND",
        "That conflict administrator no longer exists.",
      );
    }
    if (administrator.active) {
      conflictAdminError(
        "CONFLICT_ADMIN_STILL_ACTIVE",
        "Deactivate this conflict administrator before permanently removing it.",
      );
    }
    await ctx.db.delete(administrator._id);
    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "warning",
      category: "user_management",
      action: "conflict_admin_removed",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "conflictAdmin",
      entityId: String(administrator._id),
      message: `${
        administrator.displayName || administrator.email
      } was permanently removed as a conflict administrator.`,
    });
  },
});
