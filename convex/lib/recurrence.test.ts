import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  MAX_RECURRENCE_HORIZON_YEARS,
  MAX_RECURRENCE_OCCURRENCES,
  buildGoogleRecurrenceRule,
  expandRecurrence,
  parseRecurrenceFrequency,
} from "./recurrence";

function millis(
  value: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
  },
  zone = "Asia/Singapore",
): number {
  return DateTime.fromObject(value, { zone }).toMillis();
}

function isoDates(
  occurrences: ReturnType<typeof expandRecurrence>,
  zone = "Asia/Singapore",
): string[] {
  return occurrences.map((occurrence) =>
    DateTime.fromMillis(occurrence.startAt, { zone }).toFormat(
      "yyyy-MM-dd",
    ),
  );
}

describe("recurrence expansion", () => {
  const base = {
    startAt: millis({
      year: 2026,
      month: 1,
      day: 16,
      hour: 9,
    }),
    endAt: millis({
      year: 2026,
      month: 1,
      day: 16,
      hour: 10,
    }),
    timezone: "Asia/Singapore",
  };

  it("returns the base booking for a non-recurring rule", () => {
    expect(
      expandRecurrence({ ...base, frequency: "none" }),
    ).toEqual([
      {
        sequence: 0,
        startAt: base.startAt,
        endAt: base.endAt,
      },
    ]);
  });

  it("expands daily and weekly rules with count including the base", () => {
    expect(
      isoDates(
        expandRecurrence({
          ...base,
          frequency: "daily",
          count: 3,
        }),
      ),
    ).toEqual(["2026-01-16", "2026-01-17", "2026-01-18"]);

    expect(
      isoDates(
        expandRecurrence({
          ...base,
          frequency: "weekly_same_day",
          count: 3,
        }),
      ),
    ).toEqual(["2026-01-16", "2026-01-23", "2026-01-30"]);
  });

  it("uses the same ordinal weekday for monthly_same_day", () => {
    // 16 January 2026 is the third Friday of the month.
    expect(
      isoDates(
        expandRecurrence({
          ...base,
          frequency: "monthly_same_day",
          count: 4,
        }),
      ),
    ).toEqual([
      "2026-01-16",
      "2026-02-20",
      "2026-03-20",
      "2026-04-17",
    ]);
  });

  it("skips months without the requested fifth weekday", () => {
    const fifthFriday = {
      startAt: millis({
        year: 2026,
        month: 1,
        day: 30,
        hour: 9,
      }),
      endAt: millis({
        year: 2026,
        month: 1,
        day: 30,
        hour: 10,
      }),
      timezone: "Asia/Singapore",
    };

    expect(
      isoDates(
        expandRecurrence({
          ...fifthFriday,
          frequency: "monthly_same_day",
          count: 3,
        }),
      ),
    ).toEqual(["2026-01-30", "2026-05-29", "2026-07-31"]);
  });

  it("uses the same date and skips months without that date", () => {
    const monthEnd = {
      startAt: millis({
        year: 2026,
        month: 1,
        day: 31,
        hour: 9,
      }),
      endAt: millis({
        year: 2026,
        month: 1,
        day: 31,
        hour: 10,
      }),
      timezone: "Asia/Singapore",
    };

    expect(
      isoDates(
        expandRecurrence({
          ...monthEnd,
          frequency: "monthly_same_date",
          count: 4,
        }),
      ),
    ).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
    ]);
  });

  it("treats untilAt as inclusive and honors the earlier bound", () => {
    const throughJanuary30 = millis({
      year: 2026,
      month: 1,
      day: 30,
      hour: 9,
    });
    expect(
      isoDates(
        expandRecurrence({
          ...base,
          frequency: "weekly_same_day",
          count: 10,
          untilAt: throughJanuary30,
        }),
      ),
    ).toEqual(["2026-01-16", "2026-01-23", "2026-01-30"]);
  });

  it("keeps local wall-clock times through daylight-saving changes", () => {
    const zone = "America/New_York";
    const dstBase = {
      startAt: millis(
        {
          year: 2026,
          month: 3,
          day: 1,
          hour: 9,
        },
        zone,
      ),
      endAt: millis(
        {
          year: 2026,
          month: 3,
          day: 1,
          hour: 10,
        },
        zone,
      ),
      timezone: zone,
    };
    const occurrences = expandRecurrence({
      ...dstBase,
      frequency: "weekly_same_day",
      count: 3,
    });

    expect(
      occurrences.map((occurrence) =>
        DateTime.fromMillis(occurrence.startAt, { zone }).toFormat(
          "yyyy-MM-dd HH:mm",
        ),
      ),
    ).toEqual([
      "2026-03-01 09:00",
      "2026-03-08 09:00",
      "2026-03-15 09:00",
    ]);
    expect(
      occurrences.map((occurrence) =>
        new Date(occurrence.startAt).toISOString(),
      ),
    ).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
    ]);
  });

  it("preserves an overnight booking across monthly ordinal shifts", () => {
    const overnight = {
      startAt: millis({
        year: 2026,
        month: 1,
        day: 16,
        hour: 23,
      }),
      endAt: millis({
        year: 2026,
        month: 1,
        day: 17,
        hour: 1,
      }),
      timezone: "Asia/Singapore",
    };
    const occurrences = expandRecurrence({
      ...overnight,
      frequency: "monthly_same_day",
      count: 2,
    });

    expect(
      DateTime.fromMillis(occurrences[1].startAt, {
        zone: overnight.timezone,
      }).toFormat("yyyy-MM-dd HH:mm"),
    ).toBe("2026-02-20 23:00");
    expect(
      DateTime.fromMillis(occurrences[1].endAt, {
        zone: overnight.timezone,
      }).toFormat("yyyy-MM-dd HH:mm"),
    ).toBe("2026-02-21 01:00");
  });

  it("requires a positive finite bound for recurring rules", () => {
    expect(() =>
      expandRecurrence({ ...base, frequency: "daily" }),
    ).toThrow("RECURRENCE_BOUND_REQUIRED");
    expect(() =>
      expandRecurrence({
        ...base,
        frequency: "daily",
        count: 0,
      }),
    ).toThrow("RECURRENCE_COUNT_INVALID");
    expect(() =>
      expandRecurrence({
        ...base,
        frequency: "daily",
        count: MAX_RECURRENCE_OCCURRENCES + 1,
      }),
    ).toThrow("RECURRENCE_COUNT_INVALID");
    expect(() =>
      expandRecurrence({
        ...base,
        frequency: "daily",
        untilAt: base.startAt - 1,
      }),
    ).toThrow("RECURRENCE_UNTIL_BEFORE_START");
  });

  it("caps until-only rules by horizon and occurrence count", () => {
    const tooFar = DateTime.fromMillis(base.startAt, {
      zone: base.timezone,
    })
      .plus({ years: MAX_RECURRENCE_HORIZON_YEARS, days: 2 })
      .toMillis();
    expect(() =>
      expandRecurrence({
        ...base,
        frequency: "monthly_same_day",
        untilAt: tooFar,
      }),
    ).toThrow("RECURRENCE_HORIZON_EXCEEDED");

    const moreThanMaximumDailyOccurrences =
      DateTime.fromMillis(base.startAt, {
        zone: base.timezone,
      })
        .plus({ days: MAX_RECURRENCE_OCCURRENCES })
        .toMillis();
    expect(() =>
      expandRecurrence({
        ...base,
        frequency: "daily",
        untilAt: moreThanMaximumDailyOccurrences,
      }),
    ).toThrow("RECURRENCE_OCCURRENCE_LIMIT_EXCEEDED");
  });

  it("parses current Jotform recurrence labels and rejects unknown ones", () => {
    expect(parseRecurrenceFrequency("Daily")).toBe("daily");
    expect(
      parseRecurrenceFrequency("Weekly on the same day"),
    ).toBe("weekly_same_day");
    expect(
      parseRecurrenceFrequency("Monthly on the same day"),
    ).toBe("monthly_same_day");
    expect(
      parseRecurrenceFrequency("Monthly on the same date"),
    ).toBe("monthly_same_date");
    expect(parseRecurrenceFrequency("No repeat")).toBe("none");
    expect(() =>
      parseRecurrenceFrequency("Whenever possible"),
    ).toThrow("RECURRENCE_FREQUENCY_INVALID");
  });
});

describe("Google Calendar recurrence rules", () => {
  const startAt = millis({
    year: 2026,
    month: 7,
    day: 17,
    hour: 19,
  });

  it("builds daily, weekly, ordinal-weekday, and same-date rules", () => {
    expect(
      buildGoogleRecurrenceRule({
        frequency: "daily",
        occurrenceCount: 12,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBe("RRULE:FREQ=DAILY;COUNT=12");
    expect(
      buildGoogleRecurrenceRule({
        frequency: "weekly_same_day",
        occurrenceCount: 12,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBe("RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=12");
    expect(
      buildGoogleRecurrenceRule({
        frequency: "monthly_same_day",
        occurrenceCount: 12,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBe("RRULE:FREQ=MONTHLY;BYDAY=3FR;COUNT=12");
    expect(
      buildGoogleRecurrenceRule({
        frequency: "monthly_same_date",
        occurrenceCount: 12,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=17;COUNT=12");
  });

  it("omits RRULE for a one-time booking", () => {
    expect(
      buildGoogleRecurrenceRule({
        frequency: "none",
        occurrenceCount: 1,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBeUndefined();
  });
});
