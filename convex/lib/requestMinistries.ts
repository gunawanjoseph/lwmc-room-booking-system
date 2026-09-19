import { OTHER_MINISTRY, ministryDisplay } from "../../shared/requestFields";
// This list is deliberately not inferred from unvalidated historical submissions.
export function requestMinistries(): string[] {
  try {
    const values: unknown = JSON.parse(process.env.BOOKING_MINISTRIES_JSON ?? "[]");
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== "string" || !value.trim() || value.length > 160)) return [];
    return [...new Set(values.map(value => (value as string).trim()))].sort();
  } catch { return []; }
}
export function validateRequestMinistry(value: string, otherMinistry?: string): string {
  const ministries = requestMinistries();
  if (!ministries.length) throw Error("Ministry options are not available yet. Please contact the booking administrator.");
  if (!ministries.includes(value)) throw Error("Select a ministry from the list before continuing.");
  if (value === OTHER_MINISTRY && (!otherMinistry?.trim() || otherMinistry.trim().length > 120 || /[\r\n\u0000-\u001f]/.test(otherMinistry))) throw Error("Specify your ministry using 1 to 120 characters.");
  return ministryDisplay(value,otherMinistry);
}
