// Shared by the public form and server; no credentials or booking data.
export const PHONE_PLACEHOLDER = "(65) 1234 5678";
export const PHONE_ERROR = "Enter a valid phone number with its country code, for example (65) 8123 4567 or +44 20 7946 0958.";
// Loose browser-side hint only; normalizePhone is the source of truth.
export const PHONE_INPUT_PATTERN = "[+\\(]?\\d[\\d\\s\\(\\)\\.\\-]{6,30}";

// Live typing: strip Jotform's "full:" prefix and anything that cannot be part of a phone number.
export function phoneInput(value: string): string {
  return value.replace(/^full:\s*/i, "").replace(/[^\d\s+()\-.]/g, "").replace(/\s+/g, " ").replace(/^\s+/, "").slice(0, 32);
}
// Existing values: show the canonical form when valid, otherwise whatever the person previously typed.
export function phoneForEdit(value: string): string {
  try { return normalizePhone(value); } catch { return phoneInput(value); }
}
const tidyPhoneGroups = (value: string) => value.replace(/[\s().-]+/g, " ").trim();
// Singapore numbers (local, 65, +65 or (65)) are stored as "(65) 1234 5678". Any other country must
// give its code as "+<code> ..." or "(<code>) ...", with 8-15 digits in total (E.164 length limits).
export function normalizePhone(value: string): string {
  const clean = value.replace(/^full:\s*/i, "").trim();
  if (!/^[\d\s+()\-.]+$/.test(clean)) throw Error(PHONE_ERROR);
  const digits = clean.replace(/\D/g, "");
  if (/^(?:(?:\+65|\(65\)|65)\s*)?[3689]\d{3}\s?\d{4}$/.test(clean)) {
    const national = digits.slice(-8);
    return `(65) ${national.slice(0, 4)} ${national.slice(4)}`;
  }
  const plus = /^\+\s*([1-9][\d\s().-]*)$/.exec(clean);
  const paren = /^\(\s*([1-9]\d{0,2})\s*\)\s*(\d[\d\s().-]*)$/.exec(clean);
  const international = plus ?? paren;
  if (!international || digits.length < 8 || digits.length > 15 || digits.startsWith("65")) throw Error(PHONE_ERROR);
  return plus ? `+${tidyPhoneGroups(plus[1])}` : `(${paren![1]}) ${tidyPhoneGroups(paren![2])}`;
}
export function isPhoneField(field: {type?: string; label: string}): boolean {
  return field.type === "control_phone" || /phone|mobile|contact number/i.test(field.label);
}
export function recurrenceLabel(frequency?: string): string {
  return ({daily:"Daily", weekly_same_day:"Weekly", biweekly_same_day:"Every two weeks", monthly_same_day:"Monthly on the same ordinal weekday", monthly_same_date:"Monthly on the same date"} as Record<string,string>)[frequency ?? ""] ?? "Existing schedule";
}

export function recurrenceDescription(startAt: number, frequency: string | undefined, timezone: string): string {
  const weekday = new Intl.DateTimeFormat("en-SG",{weekday:"long",timeZone:timezone}).format(startAt);
  const day = Number(new Intl.DateTimeFormat("en-SG",{day:"numeric",timeZone:timezone}).format(startAt));
  if (frequency === "monthly_same_day") return `Monthly on the ${["first","second","third","fourth","fifth"][Math.floor((day-1)/7)]} ${weekday}`;
  if (frequency === "monthly_same_date") return `Monthly on day ${day}`;
  if (frequency === "weekly_same_day") return `Every ${weekday}`;
  if (frequency === "biweekly_same_day") return `Every two weeks on ${weekday}`;
  return recurrenceLabel(frequency);
}

export const OTHER_MINISTRY = "Others (Please Specify)";
export function ministryDisplay(ministry: string, otherMinistry?: string): string {
  return ministry === OTHER_MINISTRY && otherMinistry?.trim()
    ? `${OTHER_MINISTRY}: ${otherMinistry.trim()}` : ministry;
}
export function ministrySelection(value: string): {ministry:string;otherMinistry:string} {
  const prefix = `${OTHER_MINISTRY}: `;
  return value.startsWith(prefix)
    ? {ministry:OTHER_MINISTRY,otherMinistry:value.slice(prefix.length)}
    : {ministry:value,otherMinistry:""};
}
// Google Calendar and the public calendar show only the name people typed, not the "Others (Please Specify)" label.
export function ministryCalendarLabel(value: string): string {
  const {ministry, otherMinistry} = ministrySelection(value.trim());
  return ministry === OTHER_MINISTRY && otherMinistry.trim() ? otherMinistry.trim() : value;
}
