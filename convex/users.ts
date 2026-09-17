import { writeAuditLog } from "./lib/auditLog";
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  configuredHeadAdminId,
  sessionUser,
  requireActiveUser,
  effectiveCapabilities,
  isConfiguredHeadAdmin,
  normalizeUser,
  requireHeadAdmin,
  requireIdentity,
  requireRegistrationIdentity,
  userBySubject,
} from "./lib/auth";
import { isDeveloperEmail, isDeveloperIdentity } from "./lib/developerIdentity";
import { planLegacyUserMigration } from "./lib/userMigration";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
} from "../shared/roles";
import {
  nonHeadRoleValidator,
} from "./schema";

function cleanText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function developerProtected(user: { role: string; email: string }): boolean {
  return user.role === "developer" || user.role === "tech_support" || isDeveloperEmail(user.email);
}
function assertDeveloperUnmanaged(user: { role: string; email: string }): void {
  if (developerProtected(user)) throw new ConvexError("Developer accounts cannot be approved, rejected, removed or assigned roles in the app. Configure DEVELOPER_EMAIL in Convex.");
}

const MAX_MIGRATION_USERS = 1_000;

/** Called after Clerk sign-in. Ordinary administrator accounts are untouched. */
export const ensureDeveloper = mutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const { identity, subject } = await requireIdentity(ctx);
    if (!isDeveloperIdentity(identity)) return null;
    const email = String(identity.email).trim().toLowerCase();
    const existing = await userBySubject(ctx, subject);
    if (existing?.role === "developer" && existing.status === "active" && existing.email === email) return existing._id;
    const now = Date.now();
    const data = {
      clerkUserId: subject, email,
      displayName: existing?.displayName || cleanText(typeof identity.name === "string" ? identity.name : "Developer", 100) || "Developer",
      role: "developer" as const, status: "active" as const, updatedAt: now,
      reviewedAt: now, reviewedBy: subject,
    };
    const userId = existing ? existing._id : await ctx.db.insert("users", {...data, createdAt: now});
    if (existing) await ctx.db.patch(userId, {...data, identitySubject: undefined, name: undefined, requestedRole: undefined, requestedAt: undefined, removedAt: undefined});
    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "info", category: "authentication", action: "developer_registered",
      actorType: "user", actorId: subject, entityType: "user", entityId: String(userId),
      message: "The environment-configured Developer account was activated.",
    });
    return userId;
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await sessionUser(ctx);
    if (!user) return null;
    const configuredHead = isConfiguredHeadAdmin(user);

    return {
      ...user,
      capabilities: effectiveCapabilities(user),
      roleLabel: ROLE_LABELS[user.role],
      roleDescription: ROLE_DESCRIPTIONS[user.role],
      isConfiguredHeadAdmin: configuredHead,
    };
  },
});

export const submitRegistration = mutation({
  args: {
    displayName: v.string(),
    reason: v.optional(v.string()),
    requestedRole: v.optional(nonHeadRoleValidator),
  },
  handler: async (ctx, args) => {
    const { subject, email, identity } = await requireRegistrationIdentity(ctx);
    const displayName = cleanText(args.displayName, 100);
    const reason = args.reason
      ? cleanText(args.reason, 500)
      : undefined;

    if (displayName.length < 2) {
      throw new ConvexError({
        code: "DISPLAY_NAME_REQUIRED",
        message: "Enter a display name with at least two characters.",
      });
    }

    const now = Date.now();
    const isDeveloper = isDeveloperIdentity(identity);
    const isHead = !isDeveloper && subject === configuredHeadAdminId();
    const automatic = isHead || isDeveloper;
    const existing = await userBySubject(ctx, subject);

    if (existing?.status === "removed" && !automatic) {
      throw new ConvexError({
        code: "ACCOUNT_REMOVED",
        message:
          "This administrator account was removed. Contact the Head Administrator.",
      });
    }

    if (
      !isDeveloper &&
      existing?.role !== "developer" && existing?.role !== "tech_support" &&
      existing?.status === "active" &&
      (!isHead || existing.role === "head_admin")
    ) {
      await ctx.db.patch(existing._id, {
        clerkUserId: subject,
        displayName: existing.displayName,
        identitySubject: undefined,
        name: undefined,
        requestedAt: undefined,
      });
      return { status: existing.status, role: existing.role };
    }

    if (!automatic && (existing?.role === "developer" || existing?.role === "tech_support")) {
      throw new ConvexError("Developer access is controlled by DEVELOPER_EMAIL. Sign in with that verified email.");
    }
    const status = automatic ? "active" : "pending";
    const role = isDeveloper ? "developer" : isHead ? "head_admin" : "booking_viewer";

    let userId;
    if (existing) {
      await ctx.db.patch(existing._id, {
        clerkUserId: subject,
        identitySubject: undefined,
        email,
        displayName,
        name: undefined,
        requestedAt: undefined,
        reason,
        requestedRole: automatic ? undefined : args.requestedRole,
        role,
        status,
        updatedAt: now,
        reviewedAt: automatic ? now : undefined,
        reviewedBy: automatic ? subject : undefined,
        removedAt: automatic ? undefined : existing.removedAt,
      });
      userId = existing._id;
    } else {
      userId = await ctx.db.insert("users", {
        clerkUserId: subject,
        email,
        displayName,
        reason,
        requestedRole: automatic ? undefined : args.requestedRole,
        role,
        status,
        createdAt: now,
        updatedAt: now,
        reviewedAt: automatic ? now : undefined,
        reviewedBy: automatic ? subject : undefined,
      });
    }

    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "info",
      category: "authentication",
      action: isDeveloper ? "developer_registered" : isHead
        ? "head_admin_registered"
        : "registration_submitted",
      actorType: "user",
      actorId: subject,
      entityType: "user",
      entityId: String(userId),
      message: isDeveloper ? "The configured Developer account was activated." : isHead
        ? "The configured Head Administrator account was activated."
        : "A new administrator registration is awaiting review.",
    });

    return { status, role };
  },
});

export const listForManagement = query({
  args: {},
  handler: async (ctx) => {
    await requireHeadAdmin(ctx);
    const users = await ctx.db.query("users").order("desc").collect();
    return users.map((rawUser) => {
      const user = normalizeUser(rawUser);
      return {
        ...user,
        roleLabel: ROLE_LABELS[user.role],
        roleDescription: ROLE_DESCRIPTIONS[user.role],
        isConfiguredHeadAdmin: isConfiguredHeadAdmin(user),
        isDeveloperProtected: developerProtected(user),
      };
    });
  },
});

export const reviewRegistration = mutation({
  args: {
    userId: v.id("users"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    role: v.optional(nonHeadRoleValidator),
  },
  handler: async (ctx, args) => {
    const head = await requireHeadAdmin(ctx);
    if ("role" in args && args.role && !["booking_viewer", "booking_approver", "sheet_editor", "booking_manager"].includes(args.role)) throw new ConvexError("Developer cannot be assigned through user management.");
    const targetDocument = await ctx.db.get(args.userId);
    if (!targetDocument) {
      throw new ConvexError({
        code: "USER_NOT_FOUND",
        message: "The administrator account no longer exists.",
      });
    }
    const target = normalizeUser(targetDocument);
    assertDeveloperUnmanaged(target);
    if (target.clerkUserId === process.env.HEAD_ADMIN_CLERK_USER_ID?.trim()) {
      throw new ConvexError({
        code: "HEAD_ADMIN_IMMUTABLE",
        message: "The configured Head Administrator cannot be reviewed.",
      });
    }
    if (target.status === "removed") {
      throw new ConvexError({
        code: "ACCOUNT_REMOVED",
        message: "A removed account cannot be approved or rejected.",
      });
    }
    if (args.decision === "approve" && !args.role) {
      throw new ConvexError({
        code: "ROLE_REQUIRED",
        message: "Choose a role before approving this account.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(target._id, {
      status: args.decision === "approve" ? "active" : "rejected",
      role: args.decision === "approve" ? args.role! : target.role,
      reviewedAt: now,
      reviewedBy: head.clerkUserId,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "info",
      category: "user_management",
      action:
        args.decision === "approve"
          ? "registration_approved"
          : "registration_rejected",
      actorType: "user",
      actorId: head.clerkUserId,
      entityType: "user",
      entityId: String(target._id),
      message: `${target.displayName}'s registration was ${args.decision === "approve" ? "approved" : "rejected"}.`,
    });
  },
});

export const changeRole = mutation({
  args: {
    userId: v.id("users"),
    role: nonHeadRoleValidator,
  },
  handler: async (ctx, args) => {
    const head = await requireHeadAdmin(ctx);
    if ("role" in args && args.role && !["booking_viewer", "booking_approver", "sheet_editor", "booking_manager"].includes(args.role)) throw new ConvexError("Developer cannot be assigned through user management.");
    const targetDocument = await ctx.db.get(args.userId);
    if (!targetDocument) {
      throw new ConvexError({
        code: "USER_NOT_FOUND",
        message: "The administrator account no longer exists.",
      });
    }
    const target = normalizeUser(targetDocument);
    assertDeveloperUnmanaged(target);
    if (target.clerkUserId === process.env.HEAD_ADMIN_CLERK_USER_ID?.trim()) {
      throw new ConvexError({
        code: "HEAD_ADMIN_IMMUTABLE",
        message: "The Head Administrator role cannot be changed.",
      });
    }
    if (target.status !== "active") {
      throw new ConvexError({
        code: "ACCOUNT_NOT_ACTIVE",
        message: "Only active administrator roles can be changed.",
      });
    }

    await ctx.db.patch(target._id, {
      role: args.role,
      updatedAt: Date.now(),
      reviewedBy: head.clerkUserId,
    });
    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "info",
      category: "user_management",
      action: "role_changed",
      actorType: "user",
      actorId: head.clerkUserId,
      entityType: "user",
      entityId: String(target._id),
      message: `${target.displayName}'s role was changed to ${ROLE_LABELS[args.role]}.`,
    });
  },
});

export const removeUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const head = await requireHeadAdmin(ctx);
    const targetDocument = await ctx.db.get(args.userId);
    if (!targetDocument) {
      throw new ConvexError({
        code: "USER_NOT_FOUND",
        message: "The administrator account no longer exists.",
      });
    }
    const target = normalizeUser(targetDocument);
    assertDeveloperUnmanaged(target);
    if (target.clerkUserId === process.env.HEAD_ADMIN_CLERK_USER_ID?.trim()) {
      throw new ConvexError({
        code: "HEAD_ADMIN_IMMUTABLE",
        message: "The configured Head Administrator cannot be removed.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(target._id, {
      status: "removed",
      removedAt: now,
      updatedAt: now,
      reviewedBy: head.clerkUserId,
    });
    await ctx.scheduler.runAfter(0, internal.logs.write, {
      level: "warning",
      category: "user_management",
      action: "user_removed",
      actorType: "user",
      actorId: head.clerkUserId,
      entityType: "user",
      entityId: String(target._id),
      message: `${target.displayName}'s administrator access was removed.`,
    });
  },
});

export const authorizationBySubject = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const { subject } = await requireIdentity(ctx);
    if (subject !== args.clerkUserId) throw new ConvexError("Session identity mismatch.");
    const user = await requireActiveUser(ctx);
    return {
      ...user,
      capabilities: effectiveCapabilities(user),
    };
  },
});

export const inspectLegacyUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db
      .query("users")
      .take(MAX_MIGRATION_USERS + 1);
    if (users.length > MAX_MIGRATION_USERS) {
      throw new ConvexError({
        code: "LEGACY_USER_MIGRATION_TOO_LARGE",
        message:
          "More than 1,000 administrator records exist. Use a paginated migration.",
      });
    }
    const plan = planLegacyUserMigration(users);
    return {
      totalUsers: users.length,
      usersNeedingMigration: plan.candidates.filter(
        (candidate) => candidate.needsMigration,
      ).length,
      safeToMigrate: plan.issues.length === 0,
      issues: plan.issues,
    };
  },
});

export const migrateLegacyUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db
      .query("users")
      .take(MAX_MIGRATION_USERS + 1);
    if (users.length > MAX_MIGRATION_USERS) {
      throw new ConvexError({
        code: "LEGACY_USER_MIGRATION_TOO_LARGE",
        message:
          "More than 1,000 administrator records exist. Use a paginated migration.",
      });
    }
    const plan = planLegacyUserMigration(users);
    if (plan.issues.length > 0) {
      throw new ConvexError({
        code: "LEGACY_USER_MIGRATION_BLOCKED",
        message:
          "Legacy users contain missing, conflicting, or duplicate identity data. Run users:inspectLegacyUsers and resolve every issue first.",
        issues: plan.issues,
      });
    }

    let migrated = 0;
    for (const candidate of plan.candidates) {
      if (!candidate.needsMigration) continue;
      await ctx.db.patch(candidate.user._id, {
        clerkUserId: candidate.clerkUserId,
        displayName: candidate.displayName,
        identitySubject: undefined,
        name: undefined,
        requestedAt: undefined,
      });
      migrated += 1;
    }

    if (migrated > 0) {
      await writeAuditLog(ctx, {
        level: "info",
        category: "system",
        action: "legacy_users_migrated",
        actorType: "system",
        entityType: "users",
        message: `${migrated} legacy administrator record${migrated === 1 ? " was" : "s were"} migrated to the canonical Clerk identity fields.`,
        detailsJson: JSON.stringify({
          totalUsers: users.length,
          migrated,
        }),
        createdAt: Date.now(),
      });
    }

    return {
      totalUsers: users.length,
      migrated,
      alreadyCanonical: users.length - migrated,
    };
  },
});
