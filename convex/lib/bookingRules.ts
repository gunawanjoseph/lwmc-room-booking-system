export const DAY_MS = 86_400_000;
export const MAX_BOOKING_DAYS = 32;

export type Interval = {
  startAt: number;
  endAt: number;
};

export const BOOKING_RULE_ERROR_CODES = {
  occurrenceIntervalInvalid: "BOOKING_OCCURRENCE_INTERVAL_INVALID",
  occurrencesNotSorted: "BOOKING_OCCURRENCES_NOT_SORTED",
  occurrencesSelfOverlap: "BOOKING_OCCURRENCES_SELF_OVERLAP",
  venueCountInvalid: "BOOKING_VENUE_COUNT_INVALID",
  claimSlotLimitInvalid: "BOOKING_CLAIM_SLOT_LIMIT_INVALID",
  claimSlotLimitExceeded: "BOOKING_CLAIM_SLOT_LIMIT_EXCEEDED",
} as const;

export type BookingRuleErrorCode =
  (typeof BOOKING_RULE_ERROR_CODES)[keyof typeof BOOKING_RULE_ERROR_CODES];

export class BookingRuleError extends Error {
  readonly code: BookingRuleErrorCode;

  constructor(code: BookingRuleErrorCode, message: string) {
    super(message);
    this.name = "BookingRuleError";
    this.code = code;
  }
}

function bookingRuleError(
  code: BookingRuleErrorCode,
  message: string,
): never {
  throw new BookingRuleError(code, message);
}

export function intervalsOverlap(
  first: Interval,
  second: Interval,
): boolean {
  return first.startAt < second.endAt && first.endAt > second.startAt;
}

export function normalizeRoomKey(room: string): string {
  return room.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function utcDaysForInterval(
  startAt: number,
  endAt: number,
): number[] {
  if (
    !Number.isFinite(startAt) ||
    !Number.isFinite(endAt) ||
    endAt <= startAt
  ) {
    throw new Error("INVALID_BOOKING_INTERVAL");
  }

  const firstDay = Math.floor(startAt / DAY_MS);
  const lastDay = Math.floor((endAt - 1) / DAY_MS);
  const count = lastDay - firstDay + 1;
  if (count > MAX_BOOKING_DAYS) {
    throw new Error("BOOKING_INTERVAL_TOO_LONG");
  }

  return Array.from({ length: count }, (_, index) => firstDay + index);
}

/**
 * Verifies the ordering emitted by recurrence expansion and prevents one
 * request from reserving the same venue against itself. Adjacent half-open
 * intervals are valid.
 */
export function assertSortedNonOverlappingOccurrences(
  occurrences: readonly Interval[],
): void {
  let previous: Interval | undefined;

  for (const occurrence of occurrences) {
    if (
      !Number.isFinite(occurrence.startAt) ||
      !Number.isFinite(occurrence.endAt) ||
      occurrence.endAt <= occurrence.startAt
    ) {
      bookingRuleError(
        BOOKING_RULE_ERROR_CODES.occurrenceIntervalInvalid,
        "Every booking occurrence must have a finite start and an end after its start.",
      );
    }

    if (previous && occurrence.startAt < previous.startAt) {
      bookingRuleError(
        BOOKING_RULE_ERROR_CODES.occurrencesNotSorted,
        "Booking occurrences must be sorted by ascending start time.",
      );
    }

    if (previous && intervalsOverlap(previous, occurrence)) {
      bookingRuleError(
        BOOKING_RULE_ERROR_CODES.occurrencesSelfOverlap,
        "Recurring booking occurrences must not overlap each other.",
      );
    }

    previous = occurrence;
  }
}

/**
 * Counts the database claim rows needed for a request. A claim is created for
 * every UTC day touched by every occurrence on every physical venue.
 */
export function totalClaimSlotsForOccurrences(
  occurrences: readonly Interval[],
  venueCount: number,
): number {
  if (!Number.isSafeInteger(venueCount) || venueCount < 1) {
    bookingRuleError(
      BOOKING_RULE_ERROR_CODES.venueCountInvalid,
      "Venue count must be a positive safe integer.",
    );
  }

  const utcDaySlots = occurrences.reduce(
    (total, occurrence) =>
      total +
      utcDaysForInterval(occurrence.startAt, occurrence.endAt).length,
    0,
  );
  const totalClaimSlots = utcDaySlots * venueCount;

  if (!Number.isSafeInteger(totalClaimSlots)) {
    bookingRuleError(
      BOOKING_RULE_ERROR_CODES.claimSlotLimitExceeded,
      "The booking request requires too many claim slots.",
    );
  }

  return totalClaimSlots;
}

/**
 * Enforces a caller-selected safety limit and returns the computed slot count
 * so callers do not need to repeat the calculation.
 */
export function assertTotalClaimSlotsWithinLimit(
  occurrences: readonly Interval[],
  venueCount: number,
  maxTotalClaimSlots: number,
): number {
  if (
    !Number.isSafeInteger(maxTotalClaimSlots) ||
    maxTotalClaimSlots < 1
  ) {
    bookingRuleError(
      BOOKING_RULE_ERROR_CODES.claimSlotLimitInvalid,
      "Maximum total claim slots must be a positive safe integer.",
    );
  }

  const totalClaimSlots = totalClaimSlotsForOccurrences(
    occurrences,
    venueCount,
  );
  if (totalClaimSlots > maxTotalClaimSlots) {
    bookingRuleError(
      BOOKING_RULE_ERROR_CODES.claimSlotLimitExceeded,
      `The booking request requires ${totalClaimSlots} claim slots, exceeding the configured limit of ${maxTotalClaimSlots}.`,
    );
  }

  return totalClaimSlots;
}
