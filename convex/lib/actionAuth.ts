import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { NormalizedUser } from "./auth";
import type {
  Capability,
} from "../../shared/roles";

function actionAuthError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

export async function requireActionCapability(
  ctx: ActionCtx,
  capability: Capability,
): Promise<
  NormalizedUser & {
    capabilities: Capability[];
  }
> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    actionAuthError("AUTH_REQUIRED", "Please sign in to continue.");
  }
  const user = (await ctx.runQuery(
    internal.users.authorizationBySubject,
    {
      clerkUserId: identity.subject,
    },
  )) as
    | (NormalizedUser & {
        capabilities: Capability[];
      })
    | null;
  if (!user || user.status !== "active") {
    actionAuthError(
      "ACCOUNT_NOT_ACTIVE",
      "Your administrator account is not active.",
    );
  }
  if (!user.capabilities.includes(capability)) {
    actionAuthError(
      "FORBIDDEN",
      `Your role does not include the ${capability} permission.`,
    );
  }
  return user;
}

/** Privileged integration gate shared by the Developer and Head Administrator. */
export async function requireActionHeadAdmin(
  ctx: ActionCtx,
): Promise<
  NormalizedUser & {
    capabilities: Capability[];
  }
> {
  const user = await requireActionCapability(ctx, "integrations.manage");
  const configuredId = process.env.HEAD_ADMIN_CLERK_USER_ID?.trim();
  if (user.role !== "developer" && (
    !configuredId ||
    user.role !== "head_admin" ||
    user.clerkUserId !== configuredId
  )) {
    actionAuthError(
      "HEAD_ADMIN_REQUIRED",
      "Only the configured Head Administrator or Developer can manage integrations.",
    );
  }
  return user;
}
