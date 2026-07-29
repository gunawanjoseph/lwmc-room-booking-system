import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireHeadAdmin } from "./lib/auth";
import {
  actionableEmailDecisionView,
  emailDecisionBookingState,
  emailDecisionCredentialState,
} from "./lib/emailDecisionView";

// Approval may check as many as 120 recurring occurrences one-by-one.
// Keep the token claim just beyond Convex's 30-minute action limit so a
// second click cannot take over while the first Calendar action is alive.
const DECISION_CLAIM_LEASE_MS = 31 * 60_000;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function approverError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    approverError("APPROVER_EMAIL_INVALID", "Enter a valid approver email address.");
  }
  return email;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const name = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return name || undefined;
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!TOKEN_PATTERN.test(token)) {
    approverError(
      "EMAIL_DECISION_TOKEN_INVALID",
      "This approval link is invalid.",
    );
  }
  return token;
}

function normalizeNote(value: string | undefined): string | undefined {
  const note = value
    ?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 1_000);
  return note || undefined;
}

async function revokeSiblingTokens(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
  exceptTokenId: Id<"emailDecisionTokens">,
  reason: string,
) {
  const tokens = await ctx.db
    .query("emailDecisionTokens")
    .withIndex("by_booking", (range) =>
      range.eq("bookingId", bookingId),
    )
    .collect();
  const now = Date.now();
  for (const token of tokens) {
    if (
      token._id === exceptTokenId ||
      token.usedAt !== undefined ||
      token.revokedAt !== undefined
    ) {
      continue;
    }
    await ctx.db.patch(token._id, {
      revokedAt: now,
      revokedReason: reason,
      claimedAt: undefined,
      claimToken: undefined,
      claimExpiresAt: undefined,
    });
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireHeadAdmin(ctx);
    return await ctx.db.query("approverEmails").withIndex("by_email").collect();
  },
});

export const listActiveInternal = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("approverEmails")
      .withIndex("by_active", (range) => range.eq("active", true))
      .collect(),
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
      .query("approverEmails")
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
    return await ctx.db.insert("approverEmails", {
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
    approverId: v.id("approverEmails"),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    const approver = await ctx.db.get(args.approverId);
    if (!approver) {
      approverError("APPROVER_NOT_FOUND", "That approver email no longer exists.");
    }
    await ctx.db.patch(approver._id, {
      active: args.active,
      updatedAt: Date.now(),
      updatedBy: user.clerkUserId,
    });
    if (!args.active) {
      const tokens = await ctx.db
        .query("emailDecisionTokens")
        .withIndex("by_approver_email", (range) =>
          range.eq("approverEmail", approver.email),
        )
        .collect();
      const now = Date.now();
      for (const token of tokens) {
        if (
          token.usedAt !== undefined ||
          token.revokedAt !== undefined
        ) {
          continue;
        }
        await ctx.db.patch(token._id, {
          revokedAt: now,
          revokedReason: "approver_deactivated",
          claimedAt: undefined,
          claimToken: undefined,
          claimExpiresAt: undefined,
        });
      }
    }
  },
});

export const remove = mutation({
  args: {
    approverId: v.id("approverEmails"),
  },
  handler: async (ctx, args) => {
    const user = await requireHeadAdmin(ctx);
    const approver = await ctx.db.get(args.approverId);
    if (!approver) {
      approverError(
        "APPROVER_NOT_FOUND",
        "That approver email no longer exists.",
      );
    }
    if (approver.active) {
      approverError(
        "APPROVER_STILL_ACTIVE",
        "Deactivate this approver before permanently removing it.",
      );
    }
    await ctx.db.delete(approver._id);
    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "warning",
      category: "user_management",
      action: "approver_removed",
      actorType: "user",
      actorId: user.clerkUserId,
      entityType: "approverEmail",
      entityId: String(approver._id),
      message: `${
        approver.displayName || approver.email
      } was permanently removed as an email approver.`,
    });
  },
});

export const createDecisionToken = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    approverEmail: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) =>
    await ctx.db.insert("emailDecisionTokens", {
      bookingId: args.bookingId,
      approverEmail: normalizeEmail(args.approverEmail),
      token: args.token,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    }),
});

export const getDecisionByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (!TOKEN_PATTERN.test(token)) {
      return { state: "invalid" as const };
    }
    const decision = await ctx.db
      .query("emailDecisionTokens")
      .withIndex("by_token", (range) => range.eq("token", token))
      .unique();
    if (!decision) return { state: "invalid" as const };
    const approver = await ctx.db
      .query("approverEmails")
      .withIndex("by_email", (range) =>
        range.eq("email", decision.approverEmail),
      )
      .unique();
    const now = Date.now();
    const credentialState = emailDecisionCredentialState(decision, {
      approverActive: approver?.active === true,
      now,
    });
    if (credentialState !== "actionable") {
      return { state: credentialState };
    }

    const booking = await ctx.db.get(decision.bookingId);
    if (!booking) {
      return { state: emailDecisionBookingState(booking) };
    }
    const bookingState = emailDecisionBookingState(booking);
    if (bookingState !== "actionable") {
      return { state: bookingState };
    }
    return actionableEmailDecisionView(decision, booking, now);
  },
});

export const beginDecisionToken = internalMutation({
  args: {
    token: v.string(),
    bookingId: v.id("bookings"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    const rawToken = normalizeToken(args.token);
    const decisionToken = await ctx.db
      .query("emailDecisionTokens")
      .withIndex("by_token", (range) => range.eq("token", rawToken))
      .unique();
    if (!decisionToken) {
      approverError(
        "EMAIL_DECISION_TOKEN_INVALID",
        "This approval link is invalid.",
      );
    }
    if (decisionToken.bookingId !== args.bookingId) {
      approverError(
        "EMAIL_DECISION_TOKEN_MISMATCH",
        "This approval link does not belong to that booking.",
      );
    }
    const now = Date.now();
    if (
      decisionToken.expiresAt <= now ||
      decisionToken.usedAt !== undefined ||
      decisionToken.revokedAt !== undefined
    ) {
      approverError(
        "EMAIL_DECISION_TOKEN_INVALID",
        "This approval link is expired or has already been used.",
      );
    }
    const approver = await ctx.db
      .query("approverEmails")
      .withIndex("by_email", (range) =>
        range.eq("email", decisionToken.approverEmail),
      )
      .unique();
    if (!approver?.active) {
      approverError(
        "EMAIL_APPROVER_INACTIVE",
        "This approver email is no longer authorized.",
      );
    }
    const booking = await ctx.db.get(decisionToken.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.availabilityCheckPending === true
    ) {
      approverError(
        "INVALID_BOOKING_STATE",
        "This booking is no longer awaiting a decision.",
      );
    }
    const claimToken = args.claimToken.trim();
    if (!claimToken || claimToken.length > 160) {
      approverError(
        "EMAIL_DECISION_CLAIM_INVALID",
        "The approval attempt could not be started.",
      );
    }
    if (
      decisionToken.claimToken &&
      decisionToken.claimToken !== claimToken &&
      (decisionToken.claimExpiresAt ?? 0) > now
    ) {
      approverError(
        "EMAIL_DECISION_IN_PROGRESS",
        "This approval link is already being processed.",
      );
    }
    await ctx.db.patch(decisionToken._id, {
      claimedAt: now,
      claimToken,
      claimExpiresAt: now + DECISION_CLAIM_LEASE_MS,
    });
    return {
      tokenId: decisionToken._id,
      bookingId: decisionToken.bookingId,
      approverEmail: decisionToken.approverEmail,
      decision: args.decision,
      note: normalizeNote(args.note),
    };
  },
});

export const completeDecisionToken = internalMutation({
  args: {
    token: v.string(),
    claimToken: v.string(),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rawToken = normalizeToken(args.token);
    const decisionToken = await ctx.db
      .query("emailDecisionTokens")
      .withIndex("by_token", (range) => range.eq("token", rawToken))
      .unique();
    if (
      !decisionToken ||
      decisionToken.usedAt !== undefined ||
      decisionToken.revokedAt !== undefined ||
      decisionToken.claimToken !== args.claimToken
    ) {
      approverError(
        "EMAIL_DECISION_CLAIM_LOST",
        "This approval attempt no longer owns the decision link.",
      );
    }
    const booking = await ctx.db.get(decisionToken.bookingId);
    const terminalStatus = booking?.status;
    const statusMatches =
      args.decision === "approve"
        ? terminalStatus === "approved" ||
          terminalStatus === "unavailable"
        : terminalStatus === "rejected";
    if (!statusMatches) {
      approverError(
        "EMAIL_DECISION_NOT_COMPLETED",
        "The booking decision did not reach a terminal state.",
      );
    }
    const now = Date.now();
    await ctx.db.patch(decisionToken._id, {
      usedAt: now,
      decision: args.decision,
      note: normalizeNote(args.note),
      claimedAt: undefined,
      claimToken: undefined,
      claimExpiresAt: undefined,
    });
    await revokeSiblingTokens(
      ctx,
      decisionToken.bookingId,
      decisionToken._id,
      `booking_${terminalStatus}`,
    );
    return {
      bookingId: decisionToken.bookingId,
      approverEmail: decisionToken.approverEmail,
      status: terminalStatus,
    };
  },
});

export const releaseDecisionToken = internalMutation({
  args: {
    token: v.string(),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    const rawToken = normalizeToken(args.token);
    const decisionToken = await ctx.db
      .query("emailDecisionTokens")
      .withIndex("by_token", (range) => range.eq("token", rawToken))
      .unique();
    if (
      !decisionToken ||
      decisionToken.usedAt !== undefined ||
      decisionToken.revokedAt !== undefined ||
      decisionToken.claimToken !== args.claimToken
    ) {
      return;
    }
    await ctx.db.patch(decisionToken._id, {
      claimedAt: undefined,
      claimToken: undefined,
      claimExpiresAt: undefined,
    });
  },
});