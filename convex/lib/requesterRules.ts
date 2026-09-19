export const REQUEST_NOTICE_MS = 2 * 60 * 60 * 1000;
type Booking = {
  startAt: number; endAt: number; room: string; eventName?: string; purpose?: string; ministry?: string;
  occurrences?: Array<{ sequence: number; startAt: number; endAt: number; room?: string;
    details?: { eventName?: string; purpose?: string; ministry?: string } }>;
};
export function requestMeetings(booking: Booking) {
  return (booking.occurrences ?? [{ sequence: 0, startAt: booking.startAt, endAt: booking.endAt }])
    .map(item => ({ sequence: item.sequence, startAt: item.startAt, endAt: item.endAt,
      room: item.room ?? booking.room, title: item.details?.eventName ?? booking.eventName ?? "Room booking",
      purpose: item.details?.purpose ?? booking.purpose ?? "", ministry: item.details?.ministry ?? booking.ministry ?? "" }))
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
