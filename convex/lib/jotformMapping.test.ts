import { describe, expect, it } from "vitest";
import {
  answerAsText,
  mapJotformBooking,
  parseFieldMap,
  snapshotJotformAnswers,
  type JotformAnswers,
} from "./jotformMapping";

const answers: JotformAnswers = {
  "3": {
    name: "requesterName",
    text: "Name",
    answer: { first: "Ada", last: "Lovelace" },
  },
  "4": {
    name: "email",
    text: "Email",
    answer: "ADA@example.com",
  },
  "5": {
    name: "room",
    text: "Room",
    answer: "Board Room",
  },
  "6": {
    name: "date",
    text: "Booking date",
    answer: { year: "2026", month: "8", day: "1" },
  },
  "7": {
    name: "startTime",
    text: "Start time",
    answer: { hour: "9", min: "30", ampm: "AM" },
  },
  "8": {
    name: "endTime",
    text: "End time",
    answer: { hour: "11", min: "00", ampm: "AM" },
  },
};

const splitFieldMap = {
  requesterName: "3",
  requesterEmail: "4",
  room: "5",
  date: "6",
  startTime: "7",
  endTime: "8",
} as const;

describe("Jotform mapping", () => {
  it("formats Jotform full-name objects", () => {
    expect(answerAsText(answers["3"])).toBe("Ada Lovelace");
  });

  it("maps split date and time fields in the configured timezone", () => {
    const mapped = mapJotformBooking(
      answers,
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
      "Asia/Singapore",
    );

    expect(mapped.requesterEmail).toBe("ada@example.com");
    expect(new Date(mapped.startAt).toISOString()).toBe(
      "2026-08-01T01:30:00.000Z",
    );
    expect(new Date(mapped.endAt).toISOString()).toBe(
      "2026-08-01T03:00:00.000Z",
    );
  });

  it("rejects a mapping with no supported timing shape", () => {
    expect(() =>
      parseFieldMap(
        JSON.stringify({
          requesterName: "3",
          requesterEmail: "4",
          room: "5",
        }),
      ),
    ).toThrow("JOTFORM_FIELD_MAP_MISSING:date/time");
  });

  it("rejects duplicate canonical-field selectors", () => {
    expect(() =>
      parseFieldMap(
        JSON.stringify({
          requesterName: "3",
          requesterEmail: "4",
          room: "5",
          date: "6",
          startTime: "7",
          endTime: "7",
        }),
      ),
    ).toThrow(
      "JOTFORM_FIELD_MAP_DUPLICATE:startTime,endTime",
    );
  });

  it("supports a separate end date for overnight bookings", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": {
          name: "endDate",
          answer: { year: "2026", month: "8", day: "2" },
        },
        "10": {
          name: "endTime",
          answer: { hour: "1", min: "00", ampm: "AM" },
        },
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endDate: "9",
        endTime: "10",
      },
      "Asia/Singapore",
    );

    expect(new Date(mapped.endAt).toISOString()).toBe(
      "2026-08-01T17:00:00.000Z",
    );
  });

  it("maps the event name, purpose, and ministry fields", () => {
    const extendedAnswers: JotformAnswers = {
      ...answers,
      "9": {
        name: "eventName",
        text: "Event name",
        answer: "Volunteer Appreciation",
      },
      "10": {
        name: "purpose",
        text: "Purpose of booking",
        answer: "Thank and equip volunteers",
      },
      "11": {
        name: "ministry",
        text: "Ministry",
        answer: "Connections Ministry",
      },
    };
    const extendedFieldMap = {
      ...splitFieldMap,
      eventName: "9",
      purpose: "10",
      ministry: "11",
    };

    expect(
      mapJotformBooking(
        extendedAnswers,
        extendedFieldMap,
        "Asia/Singapore",
      ),
    ).toMatchObject({
      eventName: "Volunteer Appreciation",
      purpose: "Thank and equip volunteers",
      ministry: "Connections Ministry",
    });

    const snapshot = snapshotJotformAnswers(
      extendedAnswers,
      extendedFieldMap,
    );
    expect(
      snapshot.responses
        .filter((field) => ["9", "10", "11"].includes(field.qid))
        .map((field) => [field.qid, field.canonicalField]),
    ).toEqual([
      ["9", "eventName"],
      ["10", "purpose"],
      ["11", "ministry"],
    ]);
  });

  it.each([
    ["Daily", "daily"],
    ["Weekly on the same day", "weekly_same_day"],
    ["Monthly on the same day", "monthly_same_day"],
    ["Monthly on the same date", "monthly_same_date"],
  ] as const)(
    "maps the %s repeat option and applies the default count",
    (answer, expectedFrequency) => {
      const mapped = mapJotformBooking(
        {
          ...answers,
          "9": {
            name: "repeat",
            text: "Repeat",
            answer,
          },
        },
        {
          ...splitFieldMap,
          recurrence: "9",
        },
        "Asia/Singapore",
      );

      expect(mapped.recurrenceFrequency).toBe(expectedFrequency);
      expect(mapped.recurrenceCount).toBe(12);
      expect(mapped.recurrenceUntilAt).toBeUndefined();
    },
  );

  it("uses the configured default count when a recurring answer has no bound", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Daily" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
      },
      "Asia/Singapore",
      { defaultRecurrenceCount: 24 },
    );

    expect(mapped).toMatchObject({
      recurrenceFrequency: "daily",
      recurrenceCount: 24,
      recurrenceUntilAt: undefined,
    });
  });

  it("maps an explicit recurrence count", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Weekly on the same day" },
        "10": { answer: "8" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceCount: "10",
      },
      "Asia/Singapore",
    );

    expect(mapped).toMatchObject({
      recurrenceFrequency: "weekly_same_day",
      recurrenceCount: 8,
      recurrenceUntilAt: undefined,
    });
  });

  it.each(["0", "367", "2.5", "eight"])(
    "rejects the invalid recurrence count %s",
    (answer) => {
      expect(() =>
        mapJotformBooking(
          {
            ...answers,
            "9": { answer: "Daily" },
            "10": { answer },
          },
          {
            ...splitFieldMap,
            recurrence: "9",
            recurrenceCount: "10",
          },
          "Asia/Singapore",
        ),
      ).toThrow("JOTFORM_RECURRENCE_COUNT_INVALID");
    },
  );

  it.each([1, 367, 2.5])(
    "rejects the invalid default recurrence count %s",
    (defaultRecurrenceCount) => {
      expect(() =>
        mapJotformBooking(
          {
            ...answers,
            "9": { answer: "Daily" },
          },
          {
            ...splitFieldMap,
            recurrence: "9",
          },
          "Asia/Singapore",
          { defaultRecurrenceCount },
        ),
      ).toThrow("BOOKING_RECURRENCE_DEFAULT_COUNT_INVALID");
    },
  );

  it("maps an until-only recurrence without inventing a count", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Monthly on the same date" },
        "10": {
          answer: { year: "2026", month: "11", day: "30" },
        },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceUntil: "10",
      },
      "Asia/Singapore",
    );

    expect(mapped.recurrenceFrequency).toBe("monthly_same_date");
    expect(mapped.recurrenceCount).toBeUndefined();
    expect(new Date(mapped.recurrenceUntilAt!).toISOString()).toBe(
      "2026-11-30T15:59:59.999Z",
    );
  });

  it("maps count and until together so the earlier bound can win", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Daily" },
        "10": { answer: 10 },
        "11": { answer: "2026-08-05" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceCount: "10",
        recurrenceUntil: "11",
      },
      "Asia/Singapore",
    );

    expect(mapped.recurrenceFrequency).toBe("daily");
    expect(mapped.recurrenceCount).toBe(10);
    expect(new Date(mapped.recurrenceUntilAt!).toISOString()).toBe(
      "2026-08-05T15:59:59.999Z",
    );
  });

  it("forces a non-recurring answer to one occurrence and removes stale bounds", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "No repeat" },
        "10": { answer: "20" },
        "11": { answer: "2026-12-31" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceCount: "10",
        recurrenceUntil: "11",
      },
      "Asia/Singapore",
    );

    expect(mapped).toMatchObject({
      recurrenceFrequency: "none",
      recurrenceCount: 1,
      recurrenceUntilAt: undefined,
    });
  });

  it("treats mapped optional fields missing from a submission as absent", () => {
    const optionalFieldMap = {
      ...splitFieldMap,
      eventName: "90",
      purpose: "91",
      ministry: "92",
      recurrence: "93",
      recurrenceCount: "94",
      recurrenceUntil: "95",
    };
    const mapped = mapJotformBooking(
      answers,
      optionalFieldMap,
      "Asia/Singapore",
    );
    const snapshot = snapshotJotformAnswers(
      answers,
      optionalFieldMap,
    );

    expect(mapped).toMatchObject({
      eventName: undefined,
      purpose: undefined,
      ministry: undefined,
      recurrenceFrequency: "none",
      recurrenceCount: 1,
      recurrenceUntilAt: undefined,
    });
    expect(snapshot.totalFields).toBe(6);
    expect(
      snapshot.responses.some((field) =>
        ["90", "91", "92", "93", "94", "95"].includes(field.qid),
      ),
    ).toBe(false);
  });

  it("ignores unrelated questions added to the form", () => {
    const fieldMap = {
      requesterName: "3",
      requesterEmail: "4",
      room: "5",
      date: "6",
      startTime: "7",
      endTime: "8",
    };
    const baseline = mapJotformBooking(
      answers,
      fieldMap,
      "Asia/Singapore",
    );
    const withRemarks = mapJotformBooking(
      {
        ...answers,
        "99": {
          name: "remarks",
          text: "Remarks",
          type: "control_textarea",
          answer: {
            paragraph:
              "Please arrange a projector and two microphones.",
          },
        },
      },
      fieldMap,
      "Asia/Singapore",
    );

    expect(withRemarks).toEqual(baseline);
  });

  it("prefers an exact qid over a colliding legacy field name", () => {
    const mapped = mapJotformBooking(
      {
        "1": {
          name: "3",
          text: "Unrelated field",
          answer: "Wrong Person",
        },
        ...answers,
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
      "Asia/Singapore",
    );

    expect(mapped.requesterName).toBe("Ada Lovelace");
  });

  it("captures a bounded dynamic field snapshot keyed by qid", () => {
    const snapshot = snapshotJotformAnswers(
      {
        ...answers,
        "99": {
          name: "remarks",
          text: "Room setup remarks",
          type: "control_textarea",
          order: "9",
          answer: "Projector and two microphones",
        },
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );

    expect(snapshot).toMatchObject({
      totalFields: 7,
      truncated: false,
    });
    expect(
      snapshot.responses.find((field) => field.qid === "3")
        ?.canonicalField,
    ).toBe("requesterName");
    expect(
      snapshot.responses.find((field) => field.qid === "99"),
    ).toMatchObject({
      name: "remarks",
      label: "Room setup remarks",
      order: 9,
      value: "Projector and two microphones",
      canonicalField: undefined,
    });
  });

  it("drops nonnumeric field keys and removes unsafe control characters", () => {
    const snapshot = snapshotJotformAnswers(
      {
        ...answers,
        constructor: {
          text: "Unexpected object key",
          answer: "Do not create a column",
        },
        "100": {
          name: "remarks",
          text: "Remarks",
          answer: "Line one\u0000\r\nLine two\u0007",
        },
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );

    expect(
      snapshot.responses.some(
        (field) => field.qid === "constructor",
      ),
    ).toBe(false);
    expect(
      snapshot.responses.find((field) => field.qid === "100")
        ?.value,
    ).toBe("Line one\nLine two");
  });

  it("keeps explicitly blank optional responses and skips structural entries", () => {
    const snapshot = snapshotJotformAnswers(
      {
        ...answers,
        "99": {
          name: "remarks",
          text: "Remarks",
          type: "control_textarea",
          answer: "",
        },
        "100": {
          name: "pageBreak",
          text: "Page break",
          type: "control_pagebreak",
          prettyFormat: "Structural metadata",
        },
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );

    expect(snapshot.totalFields).toBe(7);
    expect(snapshot.truncated).toBe(false);
    expect(
      snapshot.responses.find((field) => field.qid === "99"),
    ).toMatchObject({
      label: "Remarks",
      value: "",
    });
    expect(
      snapshot.responses.some((field) => field.qid === "100"),
    ).toBe(false);
  });

  it("prioritizes canonical fields and newer high qids at the field cap", () => {
    const dynamicAnswers = Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => {
        const qid = String(100 + index);
        return [
          qid,
          {
            name: `dynamic${qid}`,
            text: `Dynamic ${qid}`,
            answer: `Value ${qid}`,
          },
        ];
      }),
    );
    const snapshot = snapshotJotformAnswers(
      { ...answers, ...dynamicAnswers },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );

    expect(snapshot.totalFields).toBe(96);
    expect(snapshot.responses).toHaveLength(80);
    expect(snapshot.truncated).toBe(true);
    expect(
      snapshot.responses
        .filter((field) => field.canonicalField)
        .map((field) => field.qid),
    ).toEqual(["3", "4", "5", "6", "7", "8"]);
    expect(
      snapshot.responses.some((field) => field.qid === "189"),
    ).toBe(true);
    expect(
      snapshot.responses.some((field) => field.qid === "100"),
    ).toBe(false);
  });

  it("flags per-field and total answer truncation", () => {
    const oversized = snapshotJotformAnswers(
      {
        ...answers,
        "99": {
          text: "Long answer",
          answer: "x".repeat(4_001),
        },
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );
    expect(oversized.truncated).toBe(true);
    expect(
      oversized.responses.find((field) => field.qid === "99")
        ?.value,
    ).toHaveLength(4_000);

    const totalCapped = snapshotJotformAnswers(
      {
        ...answers,
        ...Object.fromEntries(
          Array.from({ length: 13 }, (_, index) => {
            const qid = String(200 + index);
            return [
              qid,
              {
                text: `Large ${qid}`,
                answer: "y".repeat(4_000),
              },
            ];
          }),
        ),
      },
      {
        requesterName: "3",
        requesterEmail: "4",
        room: "5",
        date: "6",
        startTime: "7",
        endTime: "8",
      },
    );
    expect(totalCapped.truncated).toBe(true);
    expect(
      totalCapped.responses.reduce(
        (total, field) => total + field.value.length,
        0,
      ),
    ).toBe(50_000);
  });
});
