import { describe, expect, it } from "vitest";
import {
  claimPendingConflictEdges,
  detectBookingConflictTransition,
  isBookingCalendarProcessing,
  type BookingConflictSnapshot,
} from "./booking-conflict-transition";

function snapshot(
  value: Partial<BookingConflictSnapshot> = {},
): BookingConflictSnapshot {
  return {
    id: "booking-1",
    revision: 1,
    updatedAt: 1_000,
    calendarAvailabilityStatus: "available",
    calendarSyncStatus: "not_created",
    ...value,
  };
}

describe("booking conflict transitions", () => {
  it("recognizes both queued approval and edit reconciliation locks", () => {
    expect(
      isBookingCalendarProcessing({
        calendarSyncStatus: "creating",
      }),
    ).toBe(true);
    expect(
      isBookingCalendarProcessing({
        calendarSyncStatus: "failed",
      }),
    ).toBe(false);
  });

  it("detects a new Calendar conflict but not an unchanged one", () => {
    const previous = snapshot({
      calendarSyncStatus: "creating",
    });
    const current = snapshot({
      revision: 2,
      calendarAvailabilityStatus: "conflict",
      calendarConflictSummary: "Board Room is busy.",
      calendarSyncStatus: "conflict",
    });

    expect(detectBookingConflictTransition(previous, current)).toMatchObject({
      kind: "calendar",
    });
    expect(detectBookingConflictTransition(current, current)).toBeNull();
  });

  it("detects conflicts on bookings added after the initial snapshot", () => {
    expect(
      detectBookingConflictTransition(
        undefined,
        snapshot({
          calendarAvailabilityStatus: "conflict",
          calendarSyncStatus: "conflict",
        }),
      ),
    ).toMatchObject({ kind: "calendar" });
  });

  it("waits for reconciliation before reporting a repeated conflict", () => {
    const summary = "Board Room is busy.";
    const firstAttempt = detectBookingConflictTransition(
      snapshot({
        updatedAt: 1_100,
        calendarAvailabilityStatus: "conflict",
        calendarConflictSummary: summary,
        calendarSyncStatus: "creating",
      }),
      snapshot({
        updatedAt: 1_200,
        calendarAvailabilityStatus: "conflict",
        calendarConflictSummary: summary,
        calendarSyncStatus: "failed",
      }),
    );
    const retrying = snapshot({
      updatedAt: 1_300,
      calendarAvailabilityStatus: "conflict",
      calendarConflictSummary: summary,
      calendarSyncStatus: "creating",
    });
    const repeatedConflict = detectBookingConflictTransition(
      retrying,
      snapshot({
        updatedAt: 1_400,
        calendarAvailabilityStatus: "conflict",
        calendarConflictSummary: summary,
        calendarSyncStatus: "failed",
      }),
    );

    expect(
      detectBookingConflictTransition(
        snapshot({
          updatedAt: 1_200,
          calendarAvailabilityStatus: "conflict",
          calendarConflictSummary: summary,
          calendarSyncStatus: "failed",
        }),
        retrying,
      ),
    ).toBeNull();
    expect(
      detectBookingConflictTransition(undefined, retrying),
    ).toBeNull();
    expect(firstAttempt).toMatchObject({ kind: "calendar" });
    expect(repeatedConflict).toMatchObject({ kind: "calendar" });
    expect(repeatedConflict?.key).not.toBe(firstAttempt?.key);
  });

  it("detects only newly-added pending conflict warnings", () => {
    const previous = snapshot({
      conflictWarningBookingIds: ["booking-2"],
    });
    const current = snapshot({
      revision: 2,
      conflictWarningBookingIds: ["booking-2", "booking-3"],
    });

    expect(detectBookingConflictTransition(previous, current)).toMatchObject({
      kind: "pending",
      addedPendingConflictBookingIds: ["booking-3"],
      addedPendingConflictCount: 1,
    });
    expect(detectBookingConflictTransition(current, current)).toBeNull();
  });

  it("claims a reciprocal pending conflict pair only once", () => {
    const claimedEdges = new Set<string>();

    expect(
      claimPendingConflictEdges(
        "booking-1",
        ["booking-2"],
        claimedEdges,
      ),
    ).toEqual(["booking-2"]);
    expect(
      claimPendingConflictEdges(
        "booking-2",
        ["booking-1"],
        claimedEdges,
      ),
    ).toEqual([]);
  });

  it("does not report resolved conflicts or successful approvals", () => {
    expect(
      detectBookingConflictTransition(
        snapshot({
          calendarSyncStatus: "creating",
          conflictWarningBookingIds: ["booking-2"],
        }),
        snapshot({
          revision: 2,
          calendarSyncStatus: "synced",
          conflictWarningBookingIds: [],
        }),
      ),
    ).toBeNull();
  });
});
