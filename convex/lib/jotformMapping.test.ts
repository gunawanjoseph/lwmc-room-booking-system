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

  it("serializes unfamiliar booleans, nested objects, and object arrays as readable text", () => {
    expect(answerAsText({ answer: true })).toBe("Yes");
    expect(
      answerAsText({
        answer: {
          Friday: {
            morning: true,
            evening: false,
          },
          attendees: [
            { name: "Ada", ministry: "Youth" },
            { name: "Grace", ministry: "Music" },
          ],
        },
      }),
    ).toBe(
      "Friday: morning: Yes; evening: No; attendees: name: Ada; ministry: Youth, name: Grace; ministry: Music",
    );
    expect(
      answerAsText({
        answer: [{ fileName: "floor-plan.pdf", size: 2048 }],
      }),
    ).not.toContain("[object Object]");
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

  it("requires a last-date mapping when the recurrence end-date choice is mapped", () => {
    expect(() =>
      parseFieldMap(
        JSON.stringify({
          ...splitFieldMap,
          recurrence: "9",
          recurrenceHasEndDate: "10",
        }),
      ),
    ).toThrow("JOTFORM_FIELD_MAP_MISSING:recurrenceUntil");
  });

  it("requires the repeat selector whenever recurrence bounds are mapped", () => {
    for (const recurrenceField of [
      "recurrenceHasEndDate",
      "recurrenceCount",
      "recurrenceUntil",
    ] as const) {
      expect(() =>
        parseFieldMap(
          JSON.stringify({
            ...splitFieldMap,
            [recurrenceField]: "10",
            ...(recurrenceField === "recurrenceHasEndDate"
              ? { recurrenceUntil: "11" }
              : {}),
          }),
        ),
      ).toThrow("JOTFORM_FIELD_MAP_MISSING:recurrence");
    }
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
    ["Every week", "weekly_same_day"],
    ["Every 2 weeks", "biweekly_same_day"],
    ["Every month on the same day", "monthly_same_day"],
    ["Every month on the same date", "monthly_same_date"],
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

  it.each([
    ["Weekly on the same day", "weekly_same_day"],
    ["Biweekly", "biweekly_same_day"],
    ["Monthly on the same day", "monthly_same_day"],
    ["Monthly on the same date", "monthly_same_date"],
  ] as const)(
    "continues accepting the legacy %s repeat label",
    (answer, expectedFrequency) => {
      const mapped = mapJotformBooking(
        {
          ...answers,
          "9": { answer },
        },
        {
          ...splitFieldMap,
          recurrence: "9",
        },
        "Asia/Singapore",
      );
      expect(mapped.recurrenceFrequency).toBe(expectedFrequency);
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

  it.each(["0", "10030", "2.5", "eight"])(
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

  it.each([1, 10030, 2.5])(
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

  it("requires and maps the last date when the new end-date answer is Yes", () => {
    const fieldMap = {
      ...splitFieldMap,
      recurrence: "9",
      recurrenceHasEndDate: "10",
      recurrenceUntil: "11",
    };
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Every 2 weeks" },
        "10": { answer: "Yes" },
        "11": {
          answer: { year: "2026", month: "10", day: "31" },
        },
      },
      fieldMap,
      "Asia/Singapore",
    );

    expect(mapped.recurrenceFrequency).toBe("biweekly_same_day");
    expect(mapped.recurrenceHasEndDate).toBe(true);
    expect(mapped.recurrenceCount).toBeUndefined();
    expect(new Date(mapped.recurrenceUntilAt!).toISOString()).toBe(
      "2026-10-31T15:59:59.999Z",
    );
    expect(
      snapshotJotformAnswers(
        {
          ...answers,
          "9": { answer: "Every 2 weeks" },
          "10": {
            text: "Does this recurring booking have an end date?",
            answer: "Yes",
          },
          "11": {
            text: "What is the LAST date required for the booking?",
            answer: "2026-10-31",
          },
        },
        fieldMap,
      ).responses.find((response) => response.qid === "10"),
    ).toMatchObject({
      canonicalField: "recurrenceHasEndDate",
      value: "Yes",
    });
  });

  it("rejects a repeating Yes answer without a last date", () => {
    expect(() =>
      mapJotformBooking(
        {
          ...answers,
          "9": { answer: "Daily" },
          "10": { answer: "Yes" },
          "11": { answer: "" },
        },
        {
          ...splitFieldMap,
          recurrence: "9",
          recurrenceHasEndDate: "10",
          recurrenceUntil: "11",
        },
        "Asia/Singapore",
      ),
    ).toThrow("JOTFORM_RECURRENCE_UNTIL_REQUIRED");
  });

  it("ignores a stale last-date answer when the new end-date answer is No", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Every week" },
        "10": { answer: false },
        "11": { answer: "not a date" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceHasEndDate: "10",
        recurrenceUntil: "11",
      },
      "Asia/Singapore",
      { defaultRecurrenceCount: 20 },
    );

    expect(mapped).toMatchObject({
      recurrenceFrequency: "weekly_same_day",
      recurrenceHasEndDate: false,
      recurrenceCount: 20,
      recurrenceUntilAt: undefined,
    });
  });

  it("makes the new end-date choice authoritative over an obsolete mapped count", () => {
    const fieldMap = {
      ...splitFieldMap,
      recurrence: "9",
      recurrenceHasEndDate: "10",
      recurrenceCount: "11",
      recurrenceUntil: "12",
    };
    const yes = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Daily" },
        "10": { answer: "Yes" },
        "11": { answer: "2" },
        "12": { answer: "2026-08-10" },
      },
      fieldMap,
      "Asia/Singapore",
      { defaultRecurrenceCount: 20 },
    );
    const no = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Daily" },
        "10": { answer: "No" },
        "11": { answer: "2" },
        "12": { answer: "2026-08-10" },
      },
      fieldMap,
      "Asia/Singapore",
      { defaultRecurrenceCount: 20 },
    );

    expect(yes.recurrenceCount).toBeUndefined();
    expect(yes.recurrenceUntilAt).toBeDefined();
    expect(no).toMatchObject({
      recurrenceHasEndDate: false,
      recurrenceCount: 20,
      recurrenceUntilAt: undefined,
    });
  });

  it("preserves legacy until-date behavior when the Yes/No field is not mapped", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "Daily" },
        "11": { answer: "2026-08-05" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceUntil: "11",
      },
      "Asia/Singapore",
    );

    expect(mapped.recurrenceHasEndDate).toBe(true);
    expect(mapped.recurrenceCount).toBeUndefined();
    expect(mapped.recurrenceUntilAt).toBeDefined();
  });

  it("ignores stale conditional recurrence answers for No repeat", () => {
    const mapped = mapJotformBooking(
      {
        ...answers,
        "9": { answer: "No repeat" },
        "10": { answer: "unexpected value" },
        "11": { answer: "not a date" },
      },
      {
        ...splitFieldMap,
        recurrence: "9",
        recurrenceHasEndDate: "10",
        recurrenceUntil: "11",
      },
      "Asia/Singapore",
    );

    expect(mapped).toMatchObject({
      recurrenceFrequency: "none",
      recurrenceHasEndDate: false,
      recurrenceCount: 1,
      recurrenceUntilAt: undefined,
    });
  });

  it("rejects an unknown end-date choice for a repeating request", () => {
    expect(() =>
      mapJotformBooking(
        {
          ...answers,
          "9": { answer: "Daily" },
          "10": { answer: "Maybe" },
        },
        {
          ...splitFieldMap,
          recurrence: "9",
          recurrenceHasEndDate: "10",
        },
        "Asia/Singapore",
      ),
    ).toThrow("JOTFORM_RECURRENCE_END_DATE_CHOICE_INVALID");
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
      recurrenceHasEndDate: "94",
      recurrenceCount: "95",
      recurrenceUntil: "96",
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
        ["90", "91", "92", "93", "94", "95", "96"].includes(
          field.qid,
        ),
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

  it("keeps pretty-format-only widget values but excludes explicit structural controls", () => {
    const snapshot = snapshotJotformAnswers(
      {
        ...answers,
        "99": {
          name: "customWidget",
          text: "Custom widget",
          type: "control_widget",
          prettyFormat: "Selected widget value",
        },
        "100": {
          name: "instructions",
          text: "Instructions",
          type: "control_text",
          prettyFormat: "This is display-only form text.",
        },
      },
      splitFieldMap,
    );

    expect(snapshot.totalFields).toBe(7);
    expect(
      snapshot.responses.find((field) => field.qid === "99"),
    ).toMatchObject({
      label: "Custom widget",
      value: "Selected widget value",
    });
    expect(
      snapshot.responses.some((field) => field.qid === "100"),
    ).toBe(false);
  });

  it("marks an answer snapshot as capped when recursive serialization reaches its value limit", () => {
    const snapshot = snapshotJotformAnswers(
      {
        ...answers,
        "99": {
          text: "Large structured answer",
          answer: Array.from({ length: 250 }, (_, index) => ({
            item: index,
          })),
        },
      },
      splitFieldMap,
    );

    expect(snapshot.truncated).toBe(true);
    expect(
      snapshot.responses.find((field) => field.qid === "99")
        ?.value,
    ).not.toContain("[object Object]");
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
