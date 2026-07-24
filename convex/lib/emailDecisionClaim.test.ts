import { describe, expect, it } from "vitest";
import { emailDecisionClaimError } from "./emailDecisionClaim";

const now = Date.parse("2026-07-24T12:00:00.000Z");
const activeClaim = {
  approverActive: true,
  bookingId: "booking-1",
  claimExpiresAt: now + 60_000,
  claimToken: "claim-1",
  expiresAt: now + 120_000,
};

describe("terminal email-decision authorization", () => {
  it("accepts the live claim for the expected booking", () => {
    expect(
      emailDecisionClaimError(activeClaim, {
        claimToken: "claim-1",
        expectedBookingId: "booking-1",
        now,
      }),
    ).toBeNull();
  });

  it("fails closed after the approver is deactivated or the token revoked", () => {
    expect(
      emailDecisionClaimError(
        { ...activeClaim, approverActive: false },
        {
          claimToken: "claim-1",
          expectedBookingId: "booking-1",
          now,
        },
      )?.code,
    ).toBe("EMAIL_APPROVER_INACTIVE");
    expect(
      emailDecisionClaimError(
        { ...activeClaim, revokedAt: now - 1 },
        {
          claimToken: "claim-1",
          expectedBookingId: "booking-1",
          now,
        },
      )?.code,
    ).toBe("EMAIL_DECISION_TOKEN_INVALID");
  });

  it("rejects a stale, stolen, or cross-booking claim", () => {
    expect(
      emailDecisionClaimError(activeClaim, {
        claimToken: "different-claim",
        expectedBookingId: "booking-1",
        now,
      })?.code,
    ).toBe("EMAIL_DECISION_CLAIM_LOST");
    expect(
      emailDecisionClaimError(
        { ...activeClaim, claimExpiresAt: now },
        {
          claimToken: "claim-1",
          expectedBookingId: "booking-1",
          now,
        },
      )?.code,
    ).toBe("EMAIL_DECISION_CLAIM_LOST");
    expect(
      emailDecisionClaimError(activeClaim, {
        claimToken: "claim-1",
        expectedBookingId: "booking-2",
        now,
      })?.code,
    ).toBe("EMAIL_DECISION_TOKEN_MISMATCH");
  });
});
