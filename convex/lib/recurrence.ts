import { DateTime } from "luxon";

export const RECURRENCE_FREQUENCIES = [
  "none",
  "daily",
  "weekly_same_day",
  "biweekly_same_day",
  "monthly_same_day",
  "monthly_same_date",
] as const;

export type RecurrenceFrequency =
  (typeof RECURRENCE_FREQUENCIES)[number];

export type RecurrenceOccurrence = {
  /** Zero-based position in the expanded series. */
  sequence: number;
  startAt: number;
  endAt: number;
};

export type ExpandRecurrenceInput = {
  startAt: number;
  endAt: number;
  timezone: string;
  frequency: RecurrenceFrequency;
  /**
   * Maximum number of occurrences, including the initial booking.
   * Recurring rules must provide count and/or untilAt.
   */
  count?: number;
  /**
   * Inclusive upper bound for an occurrence's start instant.
   * Recurring rules must provide count and/or untilAt.
   */
  untilAt?: number;
};

/**
 * Keeps a single request from creating an unexpectedly large number of
 * database records, conflict checks, or downstream calendar events.
 */
export const MAX_RECURRENCE_OCCURRENCES = 120;

/**
 * An until-only rule needs both an occurrence cap and a calendar horizon so
 * sparse monthly patterns cannot scan indefinitely.
 */
export const MAX_RECURRENCE_HORIZON_YEARS = 20;

const RECURRENCE_FREQUENCY_SET = new Set<string>(
  RECURRENCE_FREQUENCIES,
);

/**
 * Keeps metadata-only booking edits from silently changing the concrete
 * length of an existing series when the deployment's default count changes.
 */
export function recurrenceCountForAdminEdit(input: {
  frequency: RecurrenceFrequency;
  hasEndDate: boolean;
  definitionChanged: boolean;
  existingOccurrenceCount?: number;
  defaultOccurrenceCount: () => number;
}): number | undefined {
  if (input.frequency === "none") return 1;
  if (
    !input.definitionChanged &&
    input.existingOccurrenceCount !== undefined
  ) {
    return input.existingOccurrenceCount;
  }
  if (input.hasEndDate) return undefined;
  return input.defaultOccurrenceCount();
}

export function recurrenceDefinitionChanged(input: {
  currentFrequency: RecurrenceFrequency;
  currentHasEndDate: boolean;
  currentStartAt: number;
  currentUntilAt?: number;
  nextFrequency: RecurrenceFrequency;
  nextHasEndDate: boolean;
  nextStartAt: number;
  nextUntilAt?: number;
}): boolean {
  return (
    input.nextFrequency !== input.currentFrequency ||
    input.nextHasEndDate !== input.currentHasEndDate ||
    input.nextStartAt !== input.currentStartAt ||
    input.nextUntilAt !== input.currentUntilAt
  );
}

function recurrenceError(code: string): never {
  throw new Error(code);
}

export function isRecurrenceFrequency(
  value: unknown,
): value is RecurrenceFrequency {
  return (
    typeof value === "string" &&
    RECURRENCE_FREQUENCY_SET.has(value)
  );
}

/**
 * Converts the labels currently used by the booking form to stable internal
 * values. Unknown labels are rejected instead of silently becoming one-time
 * bookings.
 */
export function parseRecurrenceFrequency(
  value: unknown,
): RecurrenceFrequency {
  if (value === undefined || value === null) return "none";
  if (typeof value !== "string") {
    recurrenceError("RECURRENCE_FREQUENCY_INVALID");
  }

  const normalized = value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");

  const aliases: Record<string, RecurrenceFrequency> = {
    "": "none",
    none: "none",
    no: "none",
    no_repeat: "none",
    does_not_repeat: "none",
    one_time: "none",
    once: "none",
    daily: "daily",
    every_day: "daily",
    weekly: "weekly_same_day",
    every_week: "weekly_same_day",
    weekly_same_day: "weekly_same_day",
    weekly_on_same_day: "weekly_same_day",
    weekly_on_the_same_day: "weekly_same_day",
    biweekly: "biweekly_same_day",
    fortnightly: "biweekly_same_day",
    fortnightly_every_2_weeks: "biweekly_same_day",
    every_2_weeks: "biweekly_same_day",
    every_two_weeks: "biweekly_same_day",
    every_other_week: "biweekly_same_day",
    biweekly_same_day: "biweekly_same_day",
    biweekly_on_same_day: "biweekly_same_day",
    biweekly_on_the_same_day: "biweekly_same_day",
    every_month_on_same_day: "monthly_same_day",
    every_month_on_the_same_day: "monthly_same_day",
    monthly_same_day: "monthly_same_day",
    monthly_same_weekday: "monthly_same_day",
    monthly_on_same_day: "monthly_same_day",
    monthly_on_the_same_day: "monthly_same_day",
    monthly_on_same_weekday: "monthly_same_day",
    monthly_on_the_same_weekday: "monthly_same_day",
    every_month_on_same_date: "monthly_same_date",
    every_month_on_the_same_date: "monthly_same_date",
    monthly_same_date: "monthly_same_date",
    monthly_on_same_date: "monthly_same_date",
    monthly_on_the_same_date: "monthly_same_date",
  };
  const frequency = aliases[normalized];
  if (!frequency) {
    recurrenceError("RECURRENCE_FREQUENCY_INVALID");
  }
  return frequency;
}

function localDateSerial(dateTime: DateTime): number {
  return Math.floor(
    Date.UTC(dateTime.year, dateTime.month - 1, dateTime.day) /
      86_400_000,
  );
}

function calendarDayShift(
  baseDate: DateTime,
  targetDate: DateTime,
): number {
  return localDateSerial(targetDate) - localDateSerial(baseDate);
}

function daysInMonth(dateTime: DateTime): number {
  const result = dateTime.daysInMonth;
  if (!result) recurrenceError("RECURRENCE_DATE_INVALID");
  return result;
}

function monthlySameDateTarget(
  baseStart: DateTime,
  monthOffset: number,
): DateTime | null {
  const targetMonth = baseStart
    .startOf("month")
    .plus({ months: monthOffset });
  if (baseStart.day > daysInMonth(targetMonth)) return null;
  return targetMonth.set({ day: baseStart.day });
}

function monthlySameDayTarget(
  baseStart: DateTime,
  monthOffset: number,
): DateTime | null {
  const targetMonth = baseStart
    .startOf("month")
    .plus({ months: monthOffset });
  const ordinal = Math.floor((baseStart.day - 1) / 7) + 1;
  const firstMatchingDay =
    1 + ((baseStart.weekday - targetMonth.weekday + 7) % 7);
  const targetDay = firstMatchingDay + (ordinal - 1) * 7;
  if (targetDay > daysInMonth(targetMonth)) return null;
  return targetMonth.set({ day: targetDay });
}

function occurrenceAtStep(
  input: ExpandRecurrenceInput,
  baseStart: DateTime,
  baseEnd: DateTime,
  step: number,
): Omit<RecurrenceOccurrence, "sequence"> | null {
  let dayShift: number;
  switch (input.frequency) {
    case "none":
      if (step > 0) return null;
      dayShift = 0;
      break;
    case "daily":
      dayShift = step;
      break;
    case "weekly_same_day":
      dayShift = step * 7;
      break;
    case "biweekly_same_day":
      dayShift = step * 14;
      break;
    case "monthly_same_date": {
      const target = monthlySameDateTarget(baseStart, step);
      if (!target) return null;
      dayShift = calendarDayShift(baseStart, target);
      break;
    }
    case "monthly_same_day": {
      const target = monthlySameDayTarget(baseStart, step);
      if (!target) return null;
      dayShift = calendarDayShift(baseStart, target);
      break;
    }
    default:
      return recurrenceError("RECURRENCE_FREQUENCY_INVALID");
  }

  // Calendar-day arithmetic preserves the local wall-clock time through DST.
  // Shifting start and end independently also preserves overnight bookings.
  const start = baseStart.plus({ days: dayShift });
  const end = baseEnd.plus({ days: dayShift });
  if (
    !start.isValid ||
    !end.isValid ||
    end.toMillis() <= start.toMillis()
  ) {
    recurrenceError("RECURRENCE_OCCURRENCE_INVALID");
  }
  return {
    startAt: start.toMillis(),
    endAt: end.toMillis(),
  };
}

/**
 * Google expands RRULE start times in the event timezone but applies the
 * first event's exact DTSTART/DTEND duration to every generated instance.
 * That can diverge from RoomOps' wall-clock start/end expansion at a UTC
 * offset transition. Reject new expansions before they reserve divergent
 * intervals, and reject legacy stored occurrence sets before Calendar can
 * emit a divergent RRULE.
 */
export function assertRecurrenceOccurrencesHaveStableUtcOffset(
  occurrences: readonly Pick<
    RecurrenceOccurrence,
    "startAt" | "endAt"
  >[],
  timezone: string,
): void {
  if (occurrences.length < 2) return;

  const initialStart = DateTime.fromMillis(occurrences[0].startAt, {
    zone: timezone,
  });
  if (!initialStart.isValid) {
    recurrenceError("RECURRENCE_TIMEZONE_INVALID");
  }
  const initialOffset = initialStart.offset;
  for (const occurrence of occurrences) {
    const start = DateTime.fromMillis(occurrence.startAt, {
      zone: timezone,
    });
    const end = DateTime.fromMillis(occurrence.endAt, {
      zone: timezone,
    });
    if (!start.isValid || !end.isValid) {
      recurrenceError("RECURRENCE_TIMEZONE_INVALID");
    }
    if (
      start.offset !== initialOffset ||
      end.offset !== initialOffset
    ) {
      recurrenceError(
        "RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED",
      );
    }
  }
}

function validateInput(input: ExpandRecurrenceInput): {
  baseStart: DateTime;
  baseEnd: DateTime;
} {
  if (!isRecurrenceFrequency(input.frequency)) {
    recurrenceError("RECURRENCE_FREQUENCY_INVALID");
  }
  if (
    !Number.isFinite(input.startAt) ||
    !Number.isFinite(input.endAt) ||
    input.endAt <= input.startAt
  ) {
    recurrenceError("RECURRENCE_INTERVAL_INVALID");
  }
  if (!input.timezone.trim()) {
    recurrenceError("RECURRENCE_TIMEZONE_INVALID");
  }

  const baseStart = DateTime.fromMillis(input.startAt, {
    zone: input.timezone,
  });
  const baseEnd = DateTime.fromMillis(input.endAt, {
    zone: input.timezone,
  });
  if (!baseStart.isValid || !baseEnd.isValid) {
    recurrenceError("RECURRENCE_TIMEZONE_INVALID");
  }

  if (
    input.count !== undefined &&
    (!Number.isInteger(input.count) ||
      input.count < 1 ||
      input.count > MAX_RECURRENCE_OCCURRENCES)
  ) {
    recurrenceError("RECURRENCE_COUNT_INVALID");
  }
  if (
    input.untilAt !== undefined &&
    !Number.isFinite(input.untilAt)
  ) {
    recurrenceError("RECURRENCE_UNTIL_INVALID");
  }
  if (
    input.untilAt !== undefined &&
    input.untilAt < input.startAt
  ) {
    recurrenceError("RECURRENCE_UNTIL_BEFORE_START");
  }

  if (input.frequency === "none") {
    if (input.count !== undefined && input.count !== 1) {
      recurrenceError("RECURRENCE_NONE_COUNT_INVALID");
    }
  } else if (
    input.count === undefined &&
    input.untilAt === undefined
  ) {
    recurrenceError("RECURRENCE_BOUND_REQUIRED");
  }

  // A count already provides a hard iteration bound. An until-only rule also
  // receives a maximum horizon to avoid scanning a far-future timestamp.
  if (input.count === undefined && input.untilAt !== undefined) {
    const horizon = baseStart
      .plus({ years: MAX_RECURRENCE_HORIZON_YEARS })
      .endOf("day")
      .toMillis();
    if (input.untilAt > horizon) {
      recurrenceError("RECURRENCE_HORIZON_EXCEEDED");
    }
  }

  return { baseStart, baseEnd };
}

/**
 * Expands a booking into concrete occurrences using local calendar arithmetic
 * in the configured booking timezone.
 *
 * `count` includes the original occurrence. `untilAt` is inclusive and is
 * compared with each occurrence's start instant. If both are supplied, the
 * first limit reached wins.
 *
 * "monthly_same_day" means the same ordinal weekday, such as the third Friday.
 * "monthly_same_date" means the same day number. Months without the requested
 * fifth weekday or date (for example, February 31) are skipped.
 */
export function expandRecurrence(
  input: ExpandRecurrenceInput,
): RecurrenceOccurrence[] {
  const { baseStart, baseEnd } = validateInput(input);
  const occurrences: RecurrenceOccurrence[] = [];
  let step = 0;

  while (true) {
    const candidate = occurrenceAtStep(
      input,
      baseStart,
      baseEnd,
      step,
    );
    step += 1;

    if (!candidate) {
      if (input.frequency === "none") break;
      continue;
    }
    if (
      input.untilAt !== undefined &&
      candidate.startAt > input.untilAt
    ) {
      break;
    }
    if (occurrences.length >= MAX_RECURRENCE_OCCURRENCES) {
      recurrenceError("RECURRENCE_OCCURRENCE_LIMIT_EXCEEDED");
    }

    occurrences.push({
      sequence: occurrences.length,
      ...candidate,
    });

    if (
      input.frequency === "none" ||
      (input.count !== undefined &&
        occurrences.length >= input.count)
    ) {
      break;
    }
  }

  if (occurrences.length === 0) {
    recurrenceError("RECURRENCE_HAS_NO_OCCURRENCES");
  }
  assertRecurrenceOccurrencesHaveStableUtcOffset(
    occurrences,
    input.timezone,
  );
  return occurrences;
}

const GOOGLE_WEEKDAYS = [
  "",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
] as const;

/**
 * Builds the single RRULE stored on the Google Calendar parent event.
 *
 * A concrete occurrence count is used even when Jotform supplied an end
 * date. That keeps Google Calendar aligned with the exact occurrence set
 * accepted and reserved by Convex, including skipped fifth weekdays and
 * dates such as the 31st in shorter months.
 */
export function buildGoogleRecurrenceRule(input: {
  frequency: RecurrenceFrequency;
  occurrenceCount: number;
  startAt: number;
  timezone: string;
}): string | undefined {
  if (input.frequency === "none" || input.occurrenceCount === 1) {
    return undefined;
  }
  if (
    !Number.isInteger(input.occurrenceCount) ||
    input.occurrenceCount < 2 ||
    input.occurrenceCount > MAX_RECURRENCE_OCCURRENCES
  ) {
    recurrenceError("RECURRENCE_COUNT_INVALID");
  }
  const start = DateTime.fromMillis(input.startAt, {
    zone: input.timezone,
  });
  if (!start.isValid) {
    recurrenceError("RECURRENCE_TIMEZONE_INVALID");
  }

  const count = `COUNT=${input.occurrenceCount}`;
  switch (input.frequency) {
    case "daily":
      return `RRULE:FREQ=DAILY;${count}`;
    case "weekly_same_day":
      return `RRULE:FREQ=WEEKLY;BYDAY=${GOOGLE_WEEKDAYS[start.weekday]};${count}`;
    case "biweekly_same_day":
      return `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${GOOGLE_WEEKDAYS[start.weekday]};${count}`;
    case "monthly_same_day": {
      const ordinal = Math.floor((start.day - 1) / 7) + 1;
      return `RRULE:FREQ=MONTHLY;BYDAY=${ordinal}${GOOGLE_WEEKDAYS[start.weekday]};${count}`;
    }
    case "monthly_same_date":
      return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${start.day};${count}`;
    default:
      return recurrenceError("RECURRENCE_FREQUENCY_INVALID");
  }
}
