import { DateTime } from "luxon";
import {
  MAX_RECURRENCE_OCCURRENCES,
  parseRecurrenceFrequency,
  type RecurrenceFrequency,
} from "./recurrence";

export type JotformAnswer = {
  name?: string;
  text?: string;
  type?: string;
  order?: number | string;
  answer?: unknown;
  prettyFormat?: string;
};

export type JotformAnswers = Record<string, JotformAnswer>;

export type JotformFieldMap = {
  requesterName: string;
  requesterEmail: string;
  room: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  recurrence?: string;
  recurrenceHasEndDate?: string;
  recurrenceCount?: string;
  recurrenceUntil?: string;
  start?: string;
  end?: string;
  date?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
};

export type MappedBooking = {
  requesterName: string;
  requesterEmail: string;
  room: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  recurrenceFrequency: RecurrenceFrequency;
  recurrenceHasEndDate?: boolean;
  recurrenceCount?: number;
  recurrenceUntilAt?: number;
  startAt: number;
  endAt: number;
  timezone: string;
};

export const JOTFORM_CANONICAL_FIELDS = [
  "requesterName",
  "requesterEmail",
  "room",
  "eventName",
  "purpose",
  "ministry",
  "recurrence",
  "recurrenceHasEndDate",
  "recurrenceCount",
  "recurrenceUntil",
  "start",
  "end",
  "date",
  "startTime",
  "endDate",
  "endTime",
] as const;

export type JotformCanonicalField =
  (typeof JOTFORM_CANONICAL_FIELDS)[number];

export type JotformResponseSnapshot = {
  qid: string;
  name?: string;
  label: string;
  type?: string;
  order?: number;
  value: string;
  canonicalField?: JotformCanonicalField;
};

export type JotformSnapshotResult = {
  responses: JotformResponseSnapshot[];
  totalFields: number;
  truncated: boolean;
};

const MAX_SNAPSHOT_FIELDS = 80;
const MAX_SNAPSHOT_VALUE_CHARS = 4_000;
const MAX_SNAPSHOT_TOTAL_CHARS = 50_000;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en");
}

function findAnswer(
  answers: JotformAnswers,
  selector: string,
): JotformAnswer {
  const target = normalized(selector);
  // Stable question IDs are authoritative. Resolve them before retaining
  // the legacy name/label fallback so a newly added question cannot
  // shadow a configured qid with a coincidental name or label.
  const qidMatch = Object.entries(answers).find(
    ([qid]) => normalized(qid) === target,
  );
  if (qidMatch) return qidMatch[1];

  const match = Object.values(answers).find(
    (answer) =>
      (answer.name ? normalized(answer.name) === target : false) ||
      (answer.text ? normalized(answer.text) === target : false),
  );

  if (!match) {
    throw new Error(`JOTFORM_FIELD_NOT_FOUND:${selector}`);
  }
  return match;
}

function findOptionalAnswer(
  answers: JotformAnswers,
  selector: string | undefined,
): JotformAnswer | undefined {
  if (!selector) return undefined;
  try {
    return findAnswer(answers, selector);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("JOTFORM_FIELD_NOT_FOUND:")
    ) {
      return undefined;
    }
    throw error;
  }
}

const MAX_SERIALIZED_ANSWER_DEPTH = 6;
const MAX_SERIALIZED_ANSWER_VALUES = 200;
const MAX_SERIALIZED_ANSWER_CHARS = 20_000;
const NAME_PART_ORDER = [
  "prefix",
  "first",
  "middle",
  "last",
  "suffix",
] as const;
const NAME_PART_KEYS = new Set<string>(NAME_PART_ORDER);
const STRUCTURAL_JOTFORM_TYPES = new Set([
  "control_button",
  "control_collapse",
  "control_divider",
  "control_head",
  "control_image",
  "control_pagebreak",
  "control_text",
]);

type SerializedAnswer = {
  text: string;
  truncated: boolean;
};

type AnswerSerializationState = {
  visitedValues: number;
  truncated: boolean;
};

function capSerializedText(
  value: string,
  state: AnswerSerializationState,
): string {
  if (value.length > MAX_SERIALIZED_ANSWER_CHARS) {
    state.truncated = true;
    return value.slice(0, MAX_SERIALIZED_ANSWER_CHARS);
  }
  return value;
}

function humanizeObjectKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function serializeAnswerValue(
  value: unknown,
  state: AnswerSerializationState,
  depth: number,
): string {
  state.visitedValues += 1;
  if (state.visitedValues > MAX_SERIALIZED_ANSWER_VALUES) {
    state.truncated = true;
    return "";
  }
  if (depth > MAX_SERIALIZED_ANSWER_DEPTH) {
    state.truncated = true;
    return "…";
  }
  if (typeof value === "string") {
    return capSerializedText(value, state);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = serializeAnswerValue(item, state, depth + 1).trim();
      if (part) parts.push(part);
      if (state.visitedValues >= MAX_SERIALIZED_ANSWER_VALUES) {
        if (parts.length < value.length) state.truncated = true;
        break;
      }
    }
    return capSerializedText(parts.join(", "), state);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const isNameObject =
      entries.length > 0 &&
      entries.every(([key]) => NAME_PART_KEYS.has(key));
    if (isNameObject) {
      const record = value as Record<string, unknown>;
      return capSerializedText(
        NAME_PART_ORDER
          .filter((key) =>
            Object.prototype.hasOwnProperty.call(record, key),
          )
          .map((key) =>
            serializeAnswerValue(
              record[key],
              state,
              depth + 1,
            ).trim(),
          )
          .filter(Boolean)
          .join(" "),
        state,
      );
    }

    const parts: string[] = [];
    for (const [key, nestedValue] of entries) {
      const nested = serializeAnswerValue(
        nestedValue,
        state,
        depth + 1,
      ).trim();
      if (nested) {
        const label = humanizeObjectKey(key);
        parts.push(label ? `${label}: ${nested}` : nested);
      }
      if (state.visitedValues >= MAX_SERIALIZED_ANSWER_VALUES) {
        if (parts.length < entries.length) state.truncated = true;
        break;
      }
    }
    return capSerializedText(parts.join("; "), state);
  }

  return "";
}

function serializeAnswer(answer: JotformAnswer): SerializedAnswer {
  const state: AnswerSerializationState = {
    visitedValues: 0,
    truncated: false,
  };
  const serialized = serializeAnswerValue(answer.answer, state, 0).trim();
  const prettyFormat = answer.prettyFormat?.trim() ?? "";
  const text = serialized || prettyFormat;
  return {
    text: capSerializedText(text, state),
    truncated: state.truncated,
  };
}

function isStructuralJotformAnswer(answer: JotformAnswer): boolean {
  return STRUCTURAL_JOTFORM_TYPES.has(
    answer.type?.trim().toLocaleLowerCase("en") ?? "",
  );
}

export function answerAsText(answer: JotformAnswer): string {
  return serializeAnswer(answer).text;
}

function answerAsOptionalBoolean(
  answer: JotformAnswer | undefined,
): boolean | undefined {
  if (!answer) return undefined;
  if (typeof answer.answer === "boolean") return answer.answer;
  if (answer.answer === 1) return true;
  if (answer.answer === 0) return false;

  const value = answerAsText(answer)
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!value) return undefined;
  if (["yes", "y", "true", "1"].includes(value)) return true;
  if (["no", "n", "false", "0"].includes(value)) return false;
  throw new Error("JOTFORM_RECURRENCE_END_DATE_CHOICE_INVALID");
}

function compactSingleLine(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function cleanResponseValue(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

export function snapshotJotformAnswers(
  answers: JotformAnswers,
  fieldMap: JotformFieldMap,
): JotformSnapshotResult {
  const canonicalByAnswer = new Map<
    JotformAnswer,
    JotformCanonicalField
  >();
  for (const canonicalField of JOTFORM_CANONICAL_FIELDS) {
    const selector = fieldMap[canonicalField];
    if (!selector) continue;
    const answer = findOptionalAnswer(answers, selector);
    if (answer) canonicalByAnswer.set(answer, canonicalField);
  }

  const eligible = Object.entries(answers)
    .flatMap(([rawQid, answer]) => {
      const qid = compactSingleLine(rawQid, 80);
      // Jotform question IDs are numeric. Restricting the key here keeps
      // arbitrary object properties from becoming application column IDs.
      if (!/^\d{1,20}$/.test(qid)) return [];
      // Optional questions usually arrive with an explicit empty `answer`.
      // Some widgets expose only `prettyFormat`; retain that display value
      // while excluding known headings, page breaks, and other structural
      // controls. A configured core field remains eligible defensively so a
      // malformed mapping fails in the canonical parser instead of silently
      // disappearing from the response snapshot.
      const canonicalField = canonicalByAnswer.get(answer);
      if (!canonicalField && isStructuralJotformAnswer(answer)) {
        return [];
      }
      if (
        !Object.prototype.hasOwnProperty.call(answer, "answer") &&
        !answer.prettyFormat?.trim() &&
        !canonicalField
      ) {
        return [];
      }
      return [
        {
          qid,
          answer,
          canonicalField,
        },
      ];
    })
    .sort((first, second) => {
      const firstCanonical = first.canonicalField
        ? JOTFORM_CANONICAL_FIELDS.indexOf(first.canonicalField)
        : -1;
      const secondCanonical = second.canonicalField
        ? JOTFORM_CANONICAL_FIELDS.indexOf(second.canonicalField)
        : -1;
      if (firstCanonical >= 0 && secondCanonical < 0) return -1;
      if (firstCanonical < 0 && secondCanonical >= 0) return 1;
      if (
        firstCanonical >= 0 &&
        secondCanonical >= 0 &&
        firstCanonical !== secondCanonical
      ) {
        return firstCanonical - secondCanonical;
      }
      const firstQid = BigInt(first.qid);
      const secondQid = BigInt(second.qid);
      if (firstQid === secondQid) return 0;
      return firstQid > secondQid ? -1 : 1;
    });

  const snapshots: JotformResponseSnapshot[] = [];
  let remainingCharacters = MAX_SNAPSHOT_TOTAL_CHARS;
  let truncated = eligible.length > MAX_SNAPSHOT_FIELDS;
  for (const {
    qid,
    answer,
    canonicalField,
  } of eligible.slice(0, MAX_SNAPSHOT_FIELDS)) {
    const serializedAnswer = serializeAnswer(answer);
    const fullValue = cleanResponseValue(serializedAnswer.text);
    if (serializedAnswer.truncated) {
      truncated = true;
    }
    const perFieldValue = fullValue.slice(
      0,
      MAX_SNAPSHOT_VALUE_CHARS,
    );
    if (perFieldValue.length < fullValue.length) {
      truncated = true;
    }
    const value = perFieldValue.slice(0, remainingCharacters);
    if (value.length < perFieldValue.length) {
      truncated = true;
    }
    remainingCharacters -= value.length;
    const name = answer.name
      ? compactSingleLine(answer.name, 120)
      : undefined;
    const label =
      compactSingleLine(answer.text ?? "", 240) ||
      name ||
      `Question ${qid}`;
    const type = answer.type
      ? compactSingleLine(answer.type, 80)
      : undefined;
    const numericOrder = Number(answer.order);

    snapshots.push({
      qid,
      name,
      label,
      type,
      order: Number.isFinite(numericOrder)
        ? numericOrder
        : undefined,
      value,
      canonicalField,
    });
  }
  return {
    responses: snapshots,
    totalFields: eligible.length,
    truncated,
  };
}

function numberPart(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const part = value[key];
    if (typeof part === "number" && Number.isFinite(part)) return part;
    if (typeof part === "string" && part.trim()) {
      const parsed = Number(part);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function dateTimeFromObject(
  value: Record<string, unknown>,
  timezone: string,
  dateFallback?: DateTime,
): DateTime | null {
  const year =
    numberPart(value, ["year"]) ?? dateFallback?.year;
  const month =
    numberPart(value, ["month"]) ?? dateFallback?.month;
  const day =
    numberPart(value, ["day"]) ?? dateFallback?.day;
  let hour = numberPart(value, ["hour", "hours"]) ?? 0;
  const minute = numberPart(value, ["min", "minute", "minutes"]) ?? 0;
  const second = numberPart(value, ["sec", "second", "seconds"]) ?? 0;
  const ampm =
    typeof value.ampm === "string"
      ? value.ampm.toLocaleLowerCase("en")
      : "";

  if (!year || !month || !day) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const result = DateTime.fromObject(
    { year, month, day, hour, minute, second },
    { zone: timezone },
  );
  return result.isValid ? result : null;
}

const DATE_TIME_FORMATS = [
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd'T'HH:mm",
  "yyyy-MM-dd HH:mm",
  "yyyy-MM-dd h:mm a",
  "M/d/yyyy h:mm a",
  "MM/dd/yyyy h:mm a",
  "M-d-yyyy h:mm a",
  "MM-dd-yyyy h:mm a",
  "dd/MM/yyyy HH:mm",
];

const DATE_FORMATS = [
  "yyyy-MM-dd",
  "M/d/yyyy",
  "MM/dd/yyyy",
  "M-d-yyyy",
  "MM-dd-yyyy",
  "dd/MM/yyyy",
];

const TIME_FORMATS = ["H:mm", "HH:mm", "h:mm a", "hh:mm a"];

function parseString(
  value: string,
  formats: string[],
  timezone: string,
): DateTime | null {
  const iso = DateTime.fromISO(value, { zone: timezone });
  if (iso.isValid) return iso;

  for (const format of formats) {
    const result = DateTime.fromFormat(value, format, {
      zone: timezone,
      locale: "en",
    });
    if (result.isValid) return result;
  }
  return null;
}

function parseDateTimeAnswer(
  answer: JotformAnswer,
  timezone: string,
): DateTime {
  if (answer.answer && typeof answer.answer === "object") {
    const result = dateTimeFromObject(
      answer.answer as Record<string, unknown>,
      timezone,
    );
    if (result) return result;
  }

  const value = answerAsText(answer);
  const result = parseString(value, DATE_TIME_FORMATS, timezone);
  if (!result) {
    throw new Error(`JOTFORM_DATETIME_INVALID:${answer.name ?? answer.text}`);
  }
  return result;
}

function parseDateAnswer(
  answer: JotformAnswer,
  timezone: string,
): DateTime {
  if (answer.answer && typeof answer.answer === "object") {
    const result = dateTimeFromObject(
      answer.answer as Record<string, unknown>,
      timezone,
    );
    if (result) return result.startOf("day");
  }
  const value = answerAsText(answer);
  const result = parseString(value, DATE_FORMATS, timezone);
  if (!result) {
    throw new Error(`JOTFORM_DATE_INVALID:${answer.name ?? answer.text}`);
  }
  return result.startOf("day");
}

function combineDateAndTime(
  dateAnswer: JotformAnswer,
  timeAnswer: JotformAnswer,
  timezone: string,
): DateTime {
  const date = parseDateAnswer(dateAnswer, timezone);
  if (timeAnswer.answer && typeof timeAnswer.answer === "object") {
    const result = dateTimeFromObject(
      timeAnswer.answer as Record<string, unknown>,
      timezone,
      date,
    );
    if (result) return result;
  }

  const timeText = answerAsText(timeAnswer);
  const time = parseString(timeText, TIME_FORMATS, timezone);
  if (!time) {
    throw new Error(
      `JOTFORM_TIME_INVALID:${timeAnswer.name ?? timeAnswer.text}`,
    );
  }
  return date.set({
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  });
}

export function parseFieldMap(json: string): JotformFieldMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("JOTFORM_FIELD_MAP_JSON_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JOTFORM_FIELD_MAP_JSON_INVALID");
  }

  const map = parsed as Record<string, unknown>;
  const normalizedMap: Partial<
    Record<JotformCanonicalField, string>
  > = {};
  for (const field of JOTFORM_CANONICAL_FIELDS) {
    const selector = map[field];
    if (selector === undefined) continue;
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error(`JOTFORM_FIELD_MAP_INVALID:${field}`);
    }
    normalizedMap[field] = selector.trim();
  }
  for (const required of ["requesterName", "requesterEmail", "room"]) {
    if (!normalizedMap[required as JotformCanonicalField]) {
      throw new Error(`JOTFORM_FIELD_MAP_MISSING:${required}`);
    }
  }

  const hasFullDateTimes =
    Boolean(normalizedMap.start) && Boolean(normalizedMap.end);
  const hasSplitDateTimes =
    Boolean(normalizedMap.date) &&
    Boolean(normalizedMap.startTime) &&
    Boolean(normalizedMap.endTime);
  if (!hasFullDateTimes && !hasSplitDateTimes) {
    throw new Error("JOTFORM_FIELD_MAP_MISSING:date/time");
  }
  if (
    !normalizedMap.recurrence &&
    (normalizedMap.recurrenceHasEndDate ||
      normalizedMap.recurrenceCount ||
      normalizedMap.recurrenceUntil)
  ) {
    throw new Error("JOTFORM_FIELD_MAP_MISSING:recurrence");
  }
  if (
    normalizedMap.recurrenceHasEndDate &&
    !normalizedMap.recurrenceUntil
  ) {
    throw new Error(
      "JOTFORM_FIELD_MAP_MISSING:recurrenceUntil",
    );
  }

  const selectorOwners = new Map<string, JotformCanonicalField>();
  for (const [field, selector] of Object.entries(normalizedMap) as Array<
    [JotformCanonicalField, string]
  >) {
    const selectorKey = normalized(selector);
    const existingField = selectorOwners.get(selectorKey);
    if (existingField) {
      throw new Error(
        `JOTFORM_FIELD_MAP_DUPLICATE:${existingField},${field}`,
      );
    }
    selectorOwners.set(selectorKey, field);
  }

  return normalizedMap as JotformFieldMap;
}

export function mapJotformBooking(
  answers: JotformAnswers,
  fieldMap: JotformFieldMap,
  timezone: string,
  options: { defaultRecurrenceCount?: number } = {},
): MappedBooking {
  const requesterName = answerAsText(
    findAnswer(answers, fieldMap.requesterName),
  );
  const requesterEmail = answerAsText(
    findAnswer(answers, fieldMap.requesterEmail),
  ).toLocaleLowerCase("en");
  const room = answerAsText(findAnswer(answers, fieldMap.room));
  const eventNameAnswer = findOptionalAnswer(
    answers,
    fieldMap.eventName,
  );
  const purposeAnswer = findOptionalAnswer(
    answers,
    fieldMap.purpose,
  );
  const ministryAnswer = findOptionalAnswer(
    answers,
    fieldMap.ministry,
  );
  const recurrenceAnswer = findOptionalAnswer(
    answers,
    fieldMap.recurrence,
  );
  const recurrenceCountAnswer = findOptionalAnswer(
    answers,
    fieldMap.recurrenceCount,
  );
  const recurrenceHasEndDateAnswer = findOptionalAnswer(
    answers,
    fieldMap.recurrenceHasEndDate,
  );
  const recurrenceUntilAnswer = findOptionalAnswer(
    answers,
    fieldMap.recurrenceUntil,
  );
  const eventName = eventNameAnswer
    ? answerAsText(eventNameAnswer)
    : undefined;
  const purpose = purposeAnswer
    ? answerAsText(purposeAnswer)
    : undefined;
  const ministry = ministryAnswer
    ? answerAsText(ministryAnswer)
    : undefined;
  const recurrenceFrequency = parseRecurrenceFrequency(
    recurrenceAnswer ? answerAsText(recurrenceAnswer) : undefined,
  );

  let recurrenceHasEndDate: boolean | undefined;
  let recurrenceCount: number | undefined;
  let recurrenceUntilAt: number | undefined;
  if (recurrenceFrequency === "none") {
    // Conditional Jotform controls can retain hidden stale values. They are
    // irrelevant for a one-time request and must not make intake fail.
    recurrenceHasEndDate = false;
    recurrenceCount = 1;
  } else {
    recurrenceHasEndDate = answerAsOptionalBoolean(
      recurrenceHasEndDateAnswer,
    );

    // Kept for compatibility with older forms that asked for an explicit
    // count. Once the new Yes/No field is mapped it is authoritative: Yes is
    // bounded by the last date and No uses the configured safe default, even
    // if an obsolete count question remains in the environment mapping.
    if (!fieldMap.recurrenceHasEndDate && recurrenceCountAnswer) {
      const countText = answerAsText(recurrenceCountAnswer);
      if (countText) {
        if (!/^\d{1,3}$/.test(countText)) {
          throw new Error("JOTFORM_RECURRENCE_COUNT_INVALID");
        }
        recurrenceCount = Number(countText);
        if (
          recurrenceCount < 1 ||
          recurrenceCount > MAX_RECURRENCE_OCCURRENCES
        ) {
          throw new Error("JOTFORM_RECURRENCE_COUNT_INVALID");
        }
      }
    }

    const recurrenceUntilText = recurrenceUntilAnswer
      ? answerAsText(recurrenceUntilAnswer)
      : "";
    if (recurrenceHasEndDate === true && !recurrenceUntilText) {
      throw new Error("JOTFORM_RECURRENCE_UNTIL_REQUIRED");
    }
    if (
      recurrenceHasEndDate !== false &&
      recurrenceUntilAnswer &&
      recurrenceUntilText
    ) {
      recurrenceUntilAt = parseDateAnswer(
        recurrenceUntilAnswer,
        timezone,
      )
        .endOf("day")
        .toMillis();
      // A deployment whose map predates the Yes/No question keeps the old
      // behavior: a supplied last date is treated as an explicit end.
      recurrenceHasEndDate ??= true;
    }

    if (
      recurrenceCount === undefined &&
      recurrenceUntilAt === undefined
    ) {
      const defaultCount = options.defaultRecurrenceCount ?? 12;
      if (
        !Number.isInteger(defaultCount) ||
        defaultCount < 2 ||
        defaultCount > MAX_RECURRENCE_OCCURRENCES
      ) {
        throw new Error("BOOKING_RECURRENCE_DEFAULT_COUNT_INVALID");
      }
      recurrenceCount = defaultCount;
    }
  }

  let start: DateTime;
  let end: DateTime;
  if (fieldMap.start && fieldMap.end) {
    start = parseDateTimeAnswer(
      findAnswer(answers, fieldMap.start),
      timezone,
    );
    end = parseDateTimeAnswer(
      findAnswer(answers, fieldMap.end),
      timezone,
    );
  } else {
    const date = findAnswer(answers, fieldMap.date!);
    const endDate = fieldMap.endDate
      ? findAnswer(answers, fieldMap.endDate)
      : date;
    start = combineDateAndTime(
      date,
      findAnswer(answers, fieldMap.startTime!),
      timezone,
    );
    end = combineDateAndTime(
      endDate,
      findAnswer(answers, fieldMap.endTime!),
      timezone,
    );
  }

  if (
    !requesterName ||
    !requesterEmail ||
    !room ||
    !start.isValid ||
    !end.isValid ||
    end.toMillis() <= start.toMillis()
  ) {
    throw new Error("JOTFORM_REQUIRED_BOOKING_DATA_INVALID");
  }

  return {
    requesterName,
    requesterEmail,
    room,
    eventName: eventName || undefined,
    purpose: purpose || undefined,
    ministry: ministry || undefined,
    recurrenceFrequency,
    recurrenceHasEndDate,
    recurrenceCount,
    recurrenceUntilAt,
    startAt: start.toMillis(),
    endAt: end.toMillis(),
    timezone,
  };
}
