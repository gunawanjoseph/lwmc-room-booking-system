import { describe, expect, it } from "vitest";
import {
  BOOKING_RULE_ERROR_CODES,
  BookingRuleError,
  DAY_MS,
  assertSortedNonOverlappingOccurrences,
  assertTotalClaimSlotsWithinLimit,
  intervalsOverlap,
  normalizeRoomKey,
  totalClaimSlotsForOccurrences,
  utcDaysForInterval,
} from "./bookingRules";

describe("booking overlap rules", () => {
  it("uses half-open intervals so adjacent bookings are allowed", () => {
    expect(
      intervalsOverlap(
        { startAt: 1_000, endAt: 2_000 },
        { startAt: 2_000, endAt: 3_000 },
      ),
    ).toBe(false);
  });

  it("detects partial, contained, and enclosing overlaps", () => {
    const existing = { startAt: 2_000, endAt: 4_000 };
    expect(
      intervalsOverlap(existing, { startAt: 1_000, endAt: 3_000 }),
    ).toBe(true);
    expect(
      intervalsOverlap(existing, { startAt: 2_500, endAt: 3_000 }),
    ).toBe(true);
    expect(
      intervalsOverlap(existing, { startAt: 1_000, endAt: 5_000 }),
    ).toBe(true);
  });

  it("generates every UTC day touched by an interval", () => {
    expect(utcDaysForInterval(DAY_MS - 1, DAY_MS + 1)).toEqual([0, 1]);
    expect(utcDaysForInterval(DAY_MS, DAY_MS * 2)).toEqual([1]);
  });

  it("normalizes equivalent room names", () => {
    expect(normalizeRoomKey("  Board   Room ")).toBe("board room");
  });

  it("allows sorted adjacent recurrence occurrences", () => {
    expect(() =>
      assertSortedNonOverlappingOccurrences([
        { startAt: 1_000, endAt: 2_000 },
        { startAt: 2_000, endAt: 3_000 },
      ]),
    ).not.toThrow();
  });

  it("rejects self-overlapping recurrence occurrences with a stable code", () => {
    expect.assertions(3);
    try {
      assertSortedNonOverlappingOccurrences([
        { startAt: 1_000, endAt: 2_500 },
        { startAt: 2_000, endAt: 3_000 },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(BookingRuleError);
      expect((error as BookingRuleError).code).toBe(
        BOOKING_RULE_ERROR_CODES.occurrencesSelfOverlap,
      );
      expect((error as Error).message).toContain("must not overlap");
    }
  });

  it("rejects recurrence occurrences that are not sorted", () => {
    expect(() =>
      assertSortedNonOverlappingOccurrences([
        { startAt: 2_000, endAt: 3_000 },
        { startAt: 1_000, endAt: 1_500 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: BOOKING_RULE_ERROR_CODES.occurrencesNotSorted,
      }),
    );
  });

  it("counts every touched UTC day for every physical venue", () => {
    expect(
      totalClaimSlotsForOccurrences(
        [
          { startAt: 1_000, endAt: 2_000 },
          { startAt: DAY_MS - 1, endAt: DAY_MS + 1 },
        ],
        3,
      ),
    ).toBe(9);
  });

  it("allows the configured claim-slot limit and rejects one slot above it", () => {
    const occurrences = [
      { startAt: DAY_MS - 1, endAt: DAY_MS + 1 },
    ];

    expect(
      assertTotalClaimSlotsWithinLimit(occurrences, 2, 4),
    ).toBe(4);
    expect(() =>
      assertTotalClaimSlotsWithinLimit(occurrences, 2, 3),
    ).toThrowError(
      expect.objectContaining({
        code: BOOKING_RULE_ERROR_CODES.claimSlotLimitExceeded,
        message: expect.stringContaining(
          "requires 4 claim slots",
        ),
      }),
    );
  });

  it("rejects invalid venue counts and configured limits", () => {
    const occurrences = [{ startAt: 1_000, endAt: 2_000 }];

    expect(() =>
      totalClaimSlotsForOccurrences(occurrences, 0),
    ).toThrowError(
      expect.objectContaining({
        code: BOOKING_RULE_ERROR_CODES.venueCountInvalid,
      }),
    );
    expect(() =>
      assertTotalClaimSlotsWithinLimit(occurrences, 1, 0),
    ).toThrowError(
      expect.objectContaining({
        code: BOOKING_RULE_ERROR_CODES.claimSlotLimitInvalid,
      }),
    );
  });
});
