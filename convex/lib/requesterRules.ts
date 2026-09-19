export const REQUEST_NOTICE_MS = 2 * 60 * 60 * 1000;
type Booking = {
  startAt: number; endAt: number; room: string; eventName?: string; purpose?: string; ministry?: string;
  formResponses?: Array<{ qid: string; label: string; value: string; canonicalField?: string; type?: string }>;
  occurrences?: Array<{ sequence: number; startAt: number; endAt: number; room?: string;
    details?: { responses?: Array<{ qid: string; value: string }>; eventName?: string; purpose?: string; ministry?: string } }>;
};
export function editableRequestFields(booking: Booking) {
  // Files, signatures, payment and structural controls need their original intake
  // UI. Text answers use the same bounded values as RoomOps table edits.
  const editableTypes = new Set(["control_textbox", "control_textarea", "control_number", "control_email", "control_phone"]);
  return (booking.formResponses ?? []).filter(row => !row.canonicalField && (!row.type || editableTypes.has(row.type))).slice(0, 40);
}
export function requestMeetings(booking: Booking) {
  return (booking.occurrences ?? [{ sequence: 0, startAt: booking.startAt, endAt: booking.endAt }])
    .map(item => ({ sequence: item.sequence, startAt: item.startAt, endAt: item.endAt,
      room: item.room ?? booking.room, title: item.details?.eventName ?? booking.eventName ?? "Room booking",
      purpose: item.details?.purpose ?? booking.purpose ?? "", ministry: item.details?.ministry ?? booking.ministry ?? "",
      fields: editableRequestFields(booking).map(field => ({ qid: field.qid, label: field.label, type: field.type, value: item.details?.responses?.find(row => row.qid === field.qid)?.value ?? field.value })) }))
    .sort((a, b) => a.startAt - b.startAt || a.sequence - b.sequence);
}
export function requestScope(booking: Booking, sequence: number, scope: "occurrence" | "following") {
  const meetings = requestMeetings(booking);
  const selected = meetings.find(item => item.sequence === sequence);
  if (!selected) throw new Error("This meeting is no longer available. Refresh the page.");
  return meetings.filter(item => scope === "occurrence" ? item.sequence === sequence : item.startAt >= selected.startAt);
}
export function checkRequestWindow(meetings: ReturnType<typeof requestMeetings>, now: number) {
  if (!meetings.length || meetings.some(item => item.startAt - now < REQUEST_NOTICE_MS)) {
    throw new Error("Requests must be submitted at least two hours before the selected meeting starts.");
  }
}
