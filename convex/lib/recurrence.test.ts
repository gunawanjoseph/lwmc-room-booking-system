import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECURRENCE_HORIZON_YEARS,
  MAX_RECURRENCE_OCCURRENCES,
  assertRecurrenceOccurrencesHaveStableUtcOffset,
  buildGoogleRecurrenceRule,
  expandRecurrence,
  parseRecurrenceFrequency,
  recurrenceCountForAdminEdit,
  recurrenceDefinitionChanged,
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

  it("expands daily, weekly, and every-two-weeks rules with count including the base", () => {
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

    expect(
      isoDates(
        expandRecurrence({
          ...base,
          frequency: "biweekly_same_day",
          count: 3,
        }),
      ),
    ).toEqual(["2026-01-16", "2026-01-30", "2026-02-13"]);
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

  it("rejects a recurring series whose starts cross a daylight-saving offset change", () => {
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
    expect(() =>
      expandRecurrence({
        ...dstBase,
        frequency: "weekly_same_day",
        count: 3,
      }),
    ).toThrow(
      "RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED",
    );
  });

  it("rejects a recurring occurrence whose interval crosses a daylight-saving offset change", () => {
    const zone = "America/New_York";
    expect(() =>
      expandRecurrence({
        startAt: millis(
          {
            year: 2026,
            month: 3,
            day: 8,
            hour: 1,
            minute: 30,
          },
          zone,
        ),
        endAt: millis(
          {
            year: 2026,
            month: 3,
            day: 8,
            hour: 3,
            minute: 30,
          },
          zone,
        ),
        timezone: zone,
        frequency: "weekly_same_day",
        count: 2,
      }),
    ).toThrow(
      "RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED",
    );
  });

  it("rejects a generated start that falls in a nonexistent daylight-saving wall time", () => {
    const zone = "America/New_York";
    expect(() =>
      expandRecurrence({
        startAt: millis(
          {
            year: 2026,
            month: 3,
            day: 7,
            hour: 2,
            minute: 30,
          },
          zone,
        ),
        endAt: millis(
          {
            year: 2026,
            month: 3,
            day: 7,
            hour: 4,
            minute: 30,
          },
          zone,
        ),
        timezone: zone,
        frequency: "daily",
        count: 3,
      }),
    ).toThrow(
      "RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED",
    );
  });

  it("allows a one-time interval across a daylight-saving offset change", () => {
    const zone = "America/New_York";
    const occurrence = expandRecurrence({
      startAt: millis(
        {
          year: 2026,
          month: 3,
          day: 8,
          hour: 1,
          minute: 30,
        },
        zone,
      ),
      endAt: millis(
        {
          year: 2026,
          month: 3,
          day: 8,
          hour: 3,
          minute: 30,
        },
        zone,
      ),
      timezone: zone,
      frequency: "none",
    });

    expect(occurrence).toHaveLength(1);
  });

  it("rejects a legacy stored occurrence set that crosses a UTC-offset transition", () => {
    const zone = "America/New_York";
    const storedOccurrences = [
      {
        startAt: millis(
          { year: 2026, month: 3, day: 1, hour: 9 },
          zone,
        ),
        endAt: millis(
          { year: 2026, month: 3, day: 1, hour: 10 },
          zone,
        ),
      },
      {
        startAt: millis(
          { year: 2026, month: 3, day: 15, hour: 9 },
          zone,
        ),
        endAt: millis(
          { year: 2026, month: 3, day: 15, hour: 10 },
          zone,
        ),
      },
    ];

    expect(() =>
      assertRecurrenceOccurrencesHaveStableUtcOffset(
        storedOccurrences,
        zone,
      ),
    ).toThrow(
      "RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED",
    );
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

  it("caps until-only rules by horizon", () => {
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

    // The 120-occurrence cap keeps conflict, claim, and per-occurrence
    // Calendar work within the action runtime. Explicit counts above the cap
    // are covered in the preceding test.
  });

  it("parses current Jotform recurrence labels and rejects unknown ones", () => {
    expect(parseRecurrenceFrequency("Daily")).toBe("daily");
    expect(
      parseRecurrenceFrequency("Weekly on the same day"),
    ).toBe("weekly_same_day");
    expect(parseRecurrenceFrequency("Every week")).toBe(
      "weekly_same_day",
    );
    expect(parseRecurrenceFrequency("Every 2 weeks")).toBe(
      "biweekly_same_day",
    );
    expect(parseRecurrenceFrequency("Every two weeks")).toBe(
      "biweekly_same_day",
    );
    expect(
      parseRecurrenceFrequency("Monthly on the same day"),
    ).toBe("monthly_same_day");
    expect(
      parseRecurrenceFrequency("Every month on the same day"),
    ).toBe("monthly_same_day");
    expect(
      parseRecurrenceFrequency("Monthly on the same date"),
    ).toBe("monthly_same_date");
    expect(
      parseRecurrenceFrequency("Every month on the same date"),
    ).toBe("monthly_same_date");
    expect(parseRecurrenceFrequency("No repeat")).toBe("none");
    expect(() =>
      parseRecurrenceFrequency("Whenever possible"),
    ).toThrow("RECURRENCE_FREQUENCY_INVALID");
  });
});

describe("recurrence edit bounds", () => {
  it("treats a moved series start as a recurrence-definition change", () => {
    expect(
      recurrenceDefinitionChanged({
        currentFrequency: "daily",
        currentHasEndDate: true,
        currentStartAt: 1_000,
        currentUntilAt: 10_000,
        nextFrequency: "daily",
        nextHasEndDate: true,
        nextStartAt: 2_000,
        nextUntilAt: 10_000,
      }),
    ).toBe(true);
    expect(
      recurrenceDefinitionChanged({
        currentFrequency: "daily",
        currentHasEndDate: true,
        currentStartAt: 1_000,
        currentUntilAt: 10_000,
        nextFrequency: "daily",
        nextHasEndDate: true,
        nextStartAt: 1_000,
        nextUntilAt: 10_000,
      }),
    ).toBe(false);
  });

  it("preserves an existing no-end series count for metadata-only edits", () => {
    const defaultCount = vi.fn(() => 12);

    expect(
      recurrenceCountForAdminEdit({
        frequency: "weekly_same_day",
        hasEndDate: false,
        definitionChanged: false,
        existingOccurrenceCount: 20,
        defaultOccurrenceCount: defaultCount,
      }),
    ).toBe(20);
    expect(defaultCount).not.toHaveBeenCalled();
  });

  it("preserves the accepted count of an unchanged dated series", () => {
    const defaultCount = vi.fn(() => 12);

    expect(
      recurrenceCountForAdminEdit({
        frequency: "daily",
        hasEndDate: true,
        definitionChanged: false,
        existingOccurrenceCount: 3,
        defaultOccurrenceCount: defaultCount,
      }),
    ).toBe(3);
    expect(defaultCount).not.toHaveBeenCalled();
  });

  it("uses the configured count only for a new or changed no-end rule", () => {
    expect(
      recurrenceCountForAdminEdit({
        frequency: "biweekly_same_day",
        hasEndDate: false,
        definitionChanged: true,
        existingOccurrenceCount: 20,
        defaultOccurrenceCount: () => 12,
      }),
    ).toBe(12);
  });

  it("does not resolve a default count for one-time or dated rules", () => {
    const defaultCount = vi.fn(() => 12);

    expect(
      recurrenceCountForAdminEdit({
        frequency: "none",
        hasEndDate: false,
        definitionChanged: true,
        defaultOccurrenceCount: defaultCount,
      }),
    ).toBe(1);
    expect(
      recurrenceCountForAdminEdit({
        frequency: "monthly_same_date",
        hasEndDate: true,
        definitionChanged: true,
        defaultOccurrenceCount: defaultCount,
      }),
    ).toBeUndefined();
    expect(defaultCount).not.toHaveBeenCalled();
  });
});

describe("Google Calendar recurrence rules", () => {
  const startAt = millis({
    year: 2026,
    month: 7,
    day: 17,
    hour: 19,
  });

  it("builds daily, weekly, every-two-weeks, ordinal-weekday, and same-date rules", () => {
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
        frequency: "biweekly_same_day",
        occurrenceCount: 12,
        startAt,
        timezone: "Asia/Singapore",
      }),
    ).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=12");
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
