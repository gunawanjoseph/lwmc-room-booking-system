// Shared by the public form and server; no credentials or booking data.
export function phoneInput(value: string): string {
  let digits = value.replace(/^full:\s*/i, "").replace(/^(?:\(65\)|\+65)\s*/, "").replace(/\D/g, "");
  if (digits.startsWith("65") && digits.length > 8) digits = digits.slice(2);
  digits = digits.slice(0, 8);
  return digits ? `(65) ${digits.slice(0, 4)}${digits.length > 4 ? " " + digits.slice(4) : ""}` : "";
}
export function normalizePhone(value: string): string {
  const clean = value.replace(/^full:\s*/i, "").trim();
  if (!/^(?:(?:\+65|\(65\)|65)\s*)?[3689]\d{3}\s?\d{4}$/.test(clean)) {
    throw Error("Enter a Singapore phone number, for example (65) 9087 3541.");
  }
  return phoneInput(clean);
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
