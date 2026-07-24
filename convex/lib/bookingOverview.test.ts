import { describe, expect, it } from "vitest";
import {
  calculateConflictOverview,
  type ConflictOverviewBooking,
} from "./bookingOverview";

function booking(
  value: Partial<ConflictOverviewBooking> &
    Pick<ConflictOverviewBooking, "_id" | "status">,
): ConflictOverviewBooking {
  return value;
}

describe("booking conflict overview", () => {
  it("counts reciprocal pending warnings once per request and pair", () => {
    expect(
      calculateConflictOverview([
        booking({
          _id: "pending-a",
          status: "pending",
          conflictWarningBookingIds: ["pending-b", "pending-b"],
        }),
        booking({
          _id: "pending-b",
          status: "pending",
          conflictWarningBookingIds: ["pending-a"],
        }),
      ]),
    ).toEqual({
      detectedConflictRequests: 2,
      pendingConflictRequests: 2,
      pendingConflictPairs: 1,
      unavailableConflictRequests: 0,
    });
  });

  it("includes Calendar and approved-booking auto-unavailable requests", () => {
    expect(
      calculateConflictOverview([
        booking({
          _id: "pending-a",
          status: "pending",
          conflictWarningBookingIds: ["pending-b"],
        }),
        booking({
          _id: "pending-b",
          status: "pending",
          conflictWarningBookingIds: ["pending-a"],
        }),
        booking({
          _id: "google-conflict",
          status: "unavailable",
          calendarAvailabilityStatus: "conflict",
        }),
        booking({
          _id: "approved-booking-conflict",
          status: "unavailable",
          conflictBookingId: "approved-a",
          calendarAvailabilityStatus: "conflict",
        }),
        booking({
          _id: "unrelated-unavailable",
          status: "unavailable",
        }),
        booking({
          _id: "approved-a",
          status: "approved",
        }),
      ]),
    ).toEqual({
      detectedConflictRequests: 4,
      pendingConflictRequests: 2,
      pendingConflictPairs: 1,
      unavailableConflictRequests: 2,
    });
  });

  it("ignores stale warning edges that no longer point to a pending request", () => {
    expect(
      calculateConflictOverview([
        booking({
          _id: "pending-a",
          status: "pending",
          conflictWarningBookingIds: ["old-request"],
        }),
      ]),
    ).toEqual({
      detectedConflictRequests: 1,
      pendingConflictRequests: 1,
      pendingConflictPairs: 0,
      unavailableConflictRequests: 0,
    });
  });
});
