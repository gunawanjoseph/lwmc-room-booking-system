import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  actionableEmailDecisionView,
  emailDecisionBookingState,
  emailDecisionCredentialState,
  type EmailDecisionBooking,
} from "./emailDecisionView";

const now = Date.parse("2026-07-24T12:00:00.000Z");
const credential = {
  expiresAt: now + 60_000,
};
const booking: EmailDecisionBooking = {
  _id: "booking-1" as Id<"bookings">,
  requesterName: "Private Requester",
  requesterEmail: "private@example.com",
  room: "Board Room",
  startAt: now + 3_600_000,
  endAt: now + 7_200_000,
  timezone: "Asia/Singapore",
  eventName: "Private event",
  ministry: "Private ministry",
  status: "pending",
};

describe("public email-decision view", () => {
  it.each([
    ["expired", { ...credential, expiresAt: now }],
    ["revoked", { ...credential, revokedAt: now - 1 }],
  ])("fails closed for an %s credential", (_label, candidate) => {
    const state = emailDecisionCredentialState(candidate, {
      approverActive: true,
      now,
    });
    const response = { state };

    expect(response).toEqual({ state: "invalid" });
    expect(JSON.stringify(response)).not.toContain(
      booking.requesterEmail,
    );
    expect(JSON.stringify(response)).not.toContain(
      booking.requesterName,
    );
  });

  it("fails closed when the approver has been deactivated", () => {
    const state = emailDecisionCredentialState(credential, {
      approverActive: false,
      now,
    });

    expect({ state }).toEqual({ state: "invalid" });
  });

  it("exposes only a non-sensitive terminal state for a used token", () => {
    const state = emailDecisionCredentialState(
      { ...credential, usedAt: now - 1 },
      { approverActive: true, now },
    );
    const response = { state };

    expect(response).toEqual({ state: "terminal" });
    expect(Object.keys(response)).toEqual(["state"]);
    expect(JSON.stringify(response)).not.toContain(
      booking.requesterEmail,
    );
  });

  it("does not expose a staged booking before availability completes", () => {
    expect(
      emailDecisionBookingState({
        availabilityCheckPending: true,
        status: "pending",
      }),
    ).toBe("invalid");
  });

  it.each(["approved", "rejected", "unavailable"] as const)(
    "exposes only a terminal state for an already-%s booking",
    (status) => {
      const response = {
        state: emailDecisionBookingState({ status }),
      };

      expect(response).toEqual({ state: "terminal" });
      expect(Object.keys(response)).toEqual(["state"]);
      expect(JSON.stringify(response)).not.toContain(
        booking.requesterEmail,
      );
    },
  );

  it("fails closed when the booking no longer exists", () => {
    expect({ state: emailDecisionBookingState(null) }).toEqual({
      state: "invalid",
    });
  });

  it("returns booking details only for an actionable credential", () => {
    const view = actionableEmailDecisionView(
      {
        ...credential,
        claimToken: "live-claim",
        claimExpiresAt: now + 1,
      },
      booking,
      now,
    );

    expect(view.state).toBe("actionable");
    expect(view.claimed).toBe(true);
    expect(view.booking.requesterEmail).toBe(
      "private@example.com",
    );
    expect(view.booking.recurrenceFrequency).toBe("none");
    expect(view.booking.occurrences).toHaveLength(1);
  });
});
