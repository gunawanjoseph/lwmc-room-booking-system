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

function objectString(value: Record<string, unknown>): string {
  const preferredKeys = [
    "first",
    "middle",
    "last",
    "prefix",
    "suffix",
  ];
  const preferred = preferredKeys
    .map((key) => value[key])
    .filter(
      (part): part is string | number =>
        typeof part === "string" || typeof part === "number",
    )
    .map(String)
    .filter(Boolean);

  if (preferred.length > 0) return preferred.join(" ");

  return Object.values(value)
    .filter(
      (part): part is string | number =>
        typeof part === "string" || typeof part === "number",
    )
    .map(String)
    .filter(Boolean)
    .join(" ");
}

export function answerAsText(answer: JotformAnswer): string {
  const value = answer.answer;
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ").trim();
  }
  if (value && typeof value === "object") {
    return objectString(value as Record<string, unknown>).trim();
  }
  return answer.prettyFormat?.trim() ?? "";
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
      // Optional questions arrive with an explicit empty `answer`. Preserve
      // mapped core fields defensively even if Jotform represents one through
      // prettyFormat alone; other entries without `answer` are structural.
      if (
        !Object.prototype.hasOwnProperty.call(answer, "answer") &&
        !canonicalByAnswer.has(answer)
      ) {
        return [];
      }
      return [
        {
          qid,
          answer,
          canonicalField: canonicalByAnswer.get(answer),
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
    const fullValue = cleanResponseValue(answerAsText(answer));
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

  let recurrenceCount: number | undefined;
  if (recurrenceCountAnswer) {
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

  let recurrenceUntilAt: number | undefined;
  if (
    recurrenceUntilAnswer &&
    answerAsText(recurrenceUntilAnswer)
  ) {
    recurrenceUntilAt = parseDateAnswer(
      recurrenceUntilAnswer,
      timezone,
    )
      .endOf("day")
      .toMillis();
  }

  if (recurrenceFrequency === "none") {
    recurrenceCount = 1;
    recurrenceUntilAt = undefined;
  } else if (
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
    recurrenceCount,
    recurrenceUntilAt,
    startAt: start.toMillis(),
    endAt: end.toMillis(),
    timezone,
  };
}
