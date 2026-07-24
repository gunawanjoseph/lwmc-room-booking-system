export type LegacyUserLike = {
  _id: string;
  clerkUserId?: string;
  identitySubject?: string;
  displayName?: string;
  name?: string;
  requestedAt?: number;
};

export type UserMigrationIssue = {
  code:
    | "IDENTITY_CONFLICT"
    | "IDENTITY_MISSING"
    | "DISPLAY_NAME_MISSING"
    | "DUPLICATE_IDENTITY";
  userIds: string[];
  subject?: string;
};

export function planLegacyUserMigration<T extends LegacyUserLike>(
  users: T[],
) {
  const issues: UserMigrationIssue[] = [];
  const candidates: Array<{
    user: T;
    clerkUserId: string;
    displayName: string;
    needsMigration: boolean;
  }> = [];
  const usersBySubject = new Map<string, string[]>();

  for (const user of users) {
    const currentSubject = user.clerkUserId?.trim() ?? "";
    const legacySubject = user.identitySubject?.trim() ?? "";
    if (
      currentSubject &&
      legacySubject &&
      currentSubject !== legacySubject
    ) {
      issues.push({
        code: "IDENTITY_CONFLICT",
        userIds: [String(user._id)],
      });
      continue;
    }
    const clerkUserId = currentSubject || legacySubject;
    if (!clerkUserId) {
      issues.push({
        code: "IDENTITY_MISSING",
        userIds: [String(user._id)],
      });
      continue;
    }

    const displayName =
      user.displayName?.trim() || user.name?.trim() || "";
    if (!displayName) {
      issues.push({
        code: "DISPLAY_NAME_MISSING",
        userIds: [String(user._id)],
        subject: clerkUserId,
      });
      continue;
    }

    usersBySubject.set(clerkUserId, [
      ...(usersBySubject.get(clerkUserId) ?? []),
      String(user._id),
    ]);
    candidates.push({
      user,
      clerkUserId,
      displayName,
      needsMigration:
        user.clerkUserId !== clerkUserId ||
        user.displayName !== displayName ||
        user.identitySubject !== undefined ||
        user.name !== undefined ||
        user.requestedAt !== undefined,
    });
  }

  for (const [subject, userIds] of usersBySubject) {
    if (userIds.length > 1) {
      issues.push({
        code: "DUPLICATE_IDENTITY",
        userIds,
        subject,
      });
    }
  }

  return { candidates, issues };
}
