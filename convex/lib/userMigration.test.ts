import { describe, expect, it } from "vitest";
import { planLegacyUserMigration } from "./userMigration";

describe("planLegacyUserMigration", () => {
  it("maps a legacy identity and name to canonical fields", () => {
    const plan = planLegacyUserMigration([
      {
        _id: "legacy-1",
        identitySubject: "user_legacy",
        name: "Legacy Admin",
        requestedAt: 123,
      },
    ]);

    expect(plan.issues).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      clerkUserId: "user_legacy",
      displayName: "Legacy Admin",
      needsMigration: true,
    });
  });

  it("leaves a canonical record unchanged", () => {
    const plan = planLegacyUserMigration([
      {
        _id: "current-1",
        clerkUserId: "user_current",
        displayName: "Current Admin",
      },
    ]);

    expect(plan.issues).toEqual([]);
    expect(plan.candidates[0]?.needsMigration).toBe(false);
  });

  it("cleans a matching hybrid record without changing its identity", () => {
    const plan = planLegacyUserMigration([
      {
        _id: "hybrid-1",
        clerkUserId: "user_same",
        identitySubject: "user_same",
        displayName: "Preferred Name",
        name: "Legacy Name",
      },
    ]);

    expect(plan.issues).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      clerkUserId: "user_same",
      displayName: "Preferred Name",
      needsMigration: true,
    });
  });

  it("blocks conflicting identity fields", () => {
    const plan = planLegacyUserMigration([
      {
        _id: "conflict-1",
        clerkUserId: "user_new",
        identitySubject: "user_old",
        displayName: "Admin",
      },
    ]);

    expect(plan.candidates).toEqual([]);
    expect(plan.issues).toContainEqual({
      code: "IDENTITY_CONFLICT",
      userIds: ["conflict-1"],
    });
  });

  it("blocks duplicate canonical identities", () => {
    const plan = planLegacyUserMigration([
      {
        _id: "duplicate-1",
        clerkUserId: "user_duplicate",
        displayName: "First",
      },
      {
        _id: "duplicate-2",
        identitySubject: "user_duplicate",
        name: "Second",
      },
    ]);

    expect(plan.issues).toContainEqual({
      code: "DUPLICATE_IDENTITY",
      userIds: ["duplicate-1", "duplicate-2"],
      subject: "user_duplicate",
    });
  });

  it("blocks missing identity or display-name data", () => {
    const plan = planLegacyUserMigration([
      { _id: "missing-id", name: "No Identity" },
      { _id: "missing-name", identitySubject: "user_no_name" },
    ]);

    expect(plan.issues).toEqual([
      {
        code: "IDENTITY_MISSING",
        userIds: ["missing-id"],
      },
      {
        code: "DISPLAY_NAME_MISSING",
        userIds: ["missing-name"],
        subject: "user_no_name",
      },
    ]);
  });
});
