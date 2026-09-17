import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { Capability } from "../../shared/roles";
import { isDeveloperEmail, isDeveloperIdentity } from "./developerIdentity";
import { capabilitiesForRole } from "../../shared/roles";

type DatabaseCtx = QueryCtx | MutationCtx;
type AuthorizationUser = Pick<
  Doc<"users">,
  "clerkUserId" | "identitySubject" | "role" | "status" | "email"
>;

export type NormalizedUser = Doc<"users"> & {
  clerkUserId: string;
  displayName: string;
};

function authError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

export function configuredHeadAdminId(): string {
  const id = process.env.HEAD_ADMIN_CLERK_USER_ID?.trim();
  if (!id) {
    authError(
      "HEAD_ADMIN_NOT_CONFIGURED",
      "HEAD_ADMIN_CLERK_USER_ID is not configured in Convex.",
    );
  }
  return id;
}

function normalizedSubject(
  user: Pick<
    Doc<"users">,
    "clerkUserId" | "identitySubject"
  >,
): string {
  const currentSubject = user.clerkUserId?.trim() ?? "";
  const legacySubject = user.identitySubject?.trim() ?? "";

  if (
    currentSubject &&
    legacySubject &&
    currentSubject !== legacySubject
  ) {
    authError(
      "USER_IDENTITY_CONFLICT",
      "This administrator record contains conflicting Clerk identity fields.",
    );
  }

  const subject = currentSubject || legacySubject;
  if (!subject) {
    authError(
      "USER_IDENTITY_CORRUPT",
      "This administrator record has no Clerk user ID.",
    );
  }
  return subject;
}

export function normalizeUser(
  user: Doc<"users">,
): NormalizedUser {
  const displayName =
    user.displayName?.trim() ||
    user.name?.trim() ||
    user.email.trim();
  if (!displayName) {
    authError(
      "USER_NAME_CORRUPT",
      "This administrator record has no display name.",
    );
  }
  return {
    ...user,
    clerkUserId: normalizedSubject(user),
    displayName,
  };
}

export function isConfiguredHeadAdmin(
  user: Pick<
    AuthorizationUser,
    "clerkUserId" | "identitySubject" | "role"
  >,
): boolean {
  return (
    user.role === "head_admin" &&
    normalizedSubject(user) === process.env.HEAD_ADMIN_CLERK_USER_ID?.trim()
  );
}

export function effectiveCapabilities(
  user: AuthorizationUser,
): Capability[] {
  if (user.status !== "active") return [];
  if (user.role === "head_admin" && !isConfiguredHeadAdmin(user)) {
    return [];
  }
  if (user.role === "tech_support") return [];
  if (user.role === "developer" && !isDeveloperEmail(user.email)) return [];
  return capabilitiesForRole(user.role);
}

export async function requireIdentity(ctx: DatabaseCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    authError("AUTH_REQUIRED", "Please sign in to continue.");
  }

  return {
    identity,
    subject: identity.subject,
  };
}

export async function requireRegistrationIdentity(ctx: MutationCtx) {
  const { identity, subject } = await requireIdentity(ctx);
  const email =
    typeof identity.email === "string"
      ? identity.email.trim().toLowerCase()
      : "";

  if (!email) {
    authError(
      "AUTH_IDENTITY_MISSING_EMAIL",
      "Your Clerk session is missing the email claim. Add the Clerk session claims described in the setup guide, then sign out and in again.",
    );
  }

  if (typeof identity.emailVerified !== "boolean") {
    authError(
      "AUTH_IDENTITY_MISSING_EMAIL_VERIFIED",
      "Your Clerk session is missing the boolean email_verified claim. Add the Clerk session claims described in the setup guide, then sign out and in again.",
    );
  }

  if (!identity.emailVerified) {
    authError(
      "AUTH_EMAIL_NOT_VERIFIED",
      "Verify your email address with Clerk before registering.",
    );
  }

  return { identity, subject, email };
}

export async function userBySubject(
  ctx: DatabaseCtx,
  subject: string,
): Promise<NormalizedUser | null> {
  const [currentUsers, legacyUsers] = await Promise.all([
    ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (query) =>
        query.eq("clerkUserId", subject),
      )
      .take(2),
    ctx.db
      .query("users")
      .withIndex("by_identity_subject", (query) =>
        query.eq("identitySubject", subject),
      )
      .take(2),
  ]);
  const matches = new Map(
    [...currentUsers, ...legacyUsers].map((user) => [
      String(user._id),
      user,
    ]),
  );
  if (matches.size > 1) {
    authError(
      "DUPLICATE_USER_IDENTITY",
      "Multiple administrator records use this Clerk identity. Run the legacy-user migration preflight and resolve the duplicate.",
    );
  }
  const user = matches.values().next().value as
    | Doc<"users">
    | undefined;
  return user ? normalizeUser(user) : null;
}

/** Developer elevation is based on the current verified JWT, never a stored email alone. */
export async function sessionUser(ctx: DatabaseCtx): Promise<NormalizedUser | null> {
  const { identity, subject } = await requireIdentity(ctx);
  const user = await userBySubject(ctx, subject);
  if (!user) return null;
  if (isDeveloperIdentity(identity)) {
    return { ...user, email: String(identity.email).trim().toLowerCase(), role: "developer", status: "active" };
  }
  if (user.role === "developer" || user.role === "tech_support") {
    return { ...user, status: "removed" };
  }
  return user;
}

export async function requireActiveUser(ctx: DatabaseCtx): Promise<NormalizedUser> {
  const user = await sessionUser(ctx);
  if (!user) authError("REGISTRATION_REQUIRED", "Complete your account registration first.");
  if (user.status !== "active") {
    authError("ACCOUNT_NOT_ACTIVE", user.role === "developer" || user.role === "tech_support"
      ? "Developer access requires the current verified DEVELOPER_EMAIL."
      : "Your administrator account is not active.");
  }
  if (user.role === "head_admin" && !isConfiguredHeadAdmin(user)) {
    authError("HEAD_ADMIN_ACCESS_REVOKED", "The configured Head Administrator has changed.");
  }
  return user;
}

export async function requireCapability(
  ctx: DatabaseCtx,
  capability: Capability,
): Promise<NormalizedUser> {
  const user = await requireActiveUser(ctx);
  if (!effectiveCapabilities(user).includes(capability)) {
    authError(
      "FORBIDDEN",
      `Your role does not include the ${capability} permission.`,
    );
  }
  return user;
}

/** Privileged administration gate; legacy name retained for existing callers. */
export async function requireHeadAdmin(
  ctx: DatabaseCtx,
): Promise<NormalizedUser> {
  const user = await requireActiveUser(ctx);
  if (user.role !== "developer" && !isConfiguredHeadAdmin(user)) {
    authError(
      "HEAD_ADMIN_REQUIRED",
      "Only the configured Head Administrator or Developer can perform this action.",
    );
  }
  return user;
}
