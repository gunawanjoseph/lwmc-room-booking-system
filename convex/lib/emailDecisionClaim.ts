export const EMAIL_DECISION_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EmailDecisionClaimSnapshot = {
  approverActive: boolean;
  bookingId: string;
  claimExpiresAt?: number;
  claimToken?: string;
  expiresAt: number;
  revokedAt?: number;
  usedAt?: number;
};

export type EmailDecisionClaimError = {
  code:
    | "EMAIL_DECISION_TOKEN_INVALID"
    | "EMAIL_DECISION_TOKEN_MISMATCH"
    | "EMAIL_APPROVER_INACTIVE"
    | "EMAIL_DECISION_CLAIM_LOST";
  message: string;
};

/**
 * Rechecks the complete bearer-token authorization immediately before a
 * booking reaches a terminal state. This deliberately includes approver
 * activation and revocation so a long Calendar request cannot outlive a Head
 * Administrator's decision to withdraw that email address.
 */
export function emailDecisionClaimError(
  snapshot: EmailDecisionClaimSnapshot | null,
  input: {
    claimToken: string;
    expectedBookingId: string;
    now: number;
  },
): EmailDecisionClaimError | null {
  if (
    !snapshot ||
    snapshot.expiresAt <= input.now ||
    snapshot.usedAt !== undefined ||
    snapshot.revokedAt !== undefined
  ) {
    return {
      code: "EMAIL_DECISION_TOKEN_INVALID",
      message:
        "This approval link is expired, revoked, or has already been used.",
    };
  }
  if (snapshot.bookingId !== input.expectedBookingId) {
    return {
      code: "EMAIL_DECISION_TOKEN_MISMATCH",
      message: "This approval link does not belong to that booking.",
    };
  }
  if (!snapshot.approverActive) {
    return {
      code: "EMAIL_APPROVER_INACTIVE",
      message: "This approver email is no longer authorized.",
    };
  }
  if (
    !input.claimToken ||
    snapshot.claimToken !== input.claimToken ||
    (snapshot.claimExpiresAt ?? 0) <= input.now
  ) {
    return {
      code: "EMAIL_DECISION_CLAIM_LOST",
      message: "This approval attempt no longer owns the decision link.",
    };
  }
  return null;
}
