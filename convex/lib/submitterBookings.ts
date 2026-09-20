export type SubmitterBooking = {
  _id: string; jotformSubmissionId: string; sourceSubmissionId?: string; requesterEmail: string;
  room: string; eventName?: string; status: string; timezone: string;
  startAt: number; endAt: number; createdAt: number; submittedAt?: number;
  calendarSyncStatus?: string;
  occurrences?: Array<{sequence:number;startAt:number;endAt:number;room?:string;details?:{eventName?:string}}>;
};
export type SubmitterMeeting = {
  key: string; reference: string; title: string; room: string; status: string;
  startAt: number; endAt: number; submittedAt: number; submissionDateEstimated: boolean; timezone: string; calendarSyncStatus?: string;
};
export type BookingFilter = "all" | "pending" | "outstanding" | "past";
export function dateKey(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(timestamp);
  return ["year","month","day"].map(type=>parts.find(part=>part.type===type)!.value).join("-");
}
export function bookingWindow(now: number, timezone = "Asia/Singapore") {
  const today = dateKey(now,timezone);
  return {today,timezone};
}
export function submitterMeetings(booking: SubmitterBooking): SubmitterMeeting[] {
  const occurrences: NonNullable<SubmitterBooking["occurrences"]> = booking.occurrences ?? [{sequence:0,startAt:booking.startAt,endAt:booking.endAt}];
  return occurrences.map(item=>({
    key:`${booking._id}:${item.sequence}`,reference:booking.sourceSubmissionId??booking.jotformSubmissionId,
    title:item.details?.eventName ?? booking.eventName ?? "Room booking",room:item.room??booking.room,
    status:booking.status,startAt:item.startAt,endAt:item.endAt,submittedAt:booking.submittedAt??booking.createdAt,submissionDateEstimated:booking.submittedAt===undefined,
    timezone:booking.timezone,calendarSyncStatus:booking.calendarSyncStatus,
  }));
}
export function filterMeetings(rows: SubmitterMeeting[], filter: BookingFilter, now: number, timezone: string): SubmitterMeeting[] {
  const {today}=bookingWindow(now,timezone);
  return rows.filter(row=>{
    if(filter==="all")return true;
    if(filter==="pending")return row.status==="pending";
    const day=dateKey(row.startAt,timezone);
    if(filter==="past")return day<today;
    return (row.status==="pending"||row.status==="approved")&&day>=today;
  });
}
export function sortMeetings(rows: SubmitterMeeting[], sort: "booking"|"submitted", direction: "asc"|"desc") {
  const field=sort==="booking"?"startAt":"submittedAt";
  return [...rows].sort((a,b)=>(direction==="asc"?1:-1)*(a[field]-b[field] || a.startAt-b.startAt || a.key.localeCompare(b.key)));
}
export function escapeBookingHtml(value: unknown): string {
  return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
}
export function meetingTable(rows: SubmitterMeeting[]): {html:string;text:string} {
  const lines=rows.map(row=>[
    row.reference,row.title,row.room,new Intl.DateTimeFormat("en-SG",{dateStyle:"medium",timeStyle:"short",timeZone:row.timezone}).format(row.startAt),
    `${new Intl.DateTimeFormat("en-SG",{dateStyle:"medium",timeStyle:"short",timeZone:row.timezone}).format(row.endAt)} (${row.timezone})`,row.status,
  ]);
  const headers=["Reference","Event","Room","Booking date / start","End","Status"];
  const cell='style="padding:12px;border:1px solid #dce3df;text-align:left;vertical-align:top;font-size:14px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word"';
  // Two columns keep the complete meeting details readable on narrow email clients.
  const html=rows.length ? `<table style="width:100%;table-layout:fixed;border-collapse:collapse"><thead><tr><th ${cell}>Booking</th><th ${cell}>When</th></tr></thead><tbody>${lines.map(line=>`<tr><td ${cell}><strong>${escapeBookingHtml(line[1])}</strong><br>${escapeBookingHtml(line[2])}<br>${escapeBookingHtml(line[5])}<br><small>Reference: ${escapeBookingHtml(line[0])}</small></td><td ${cell}>Starts ${escapeBookingHtml(line[3])}<br>Ends ${escapeBookingHtml(line[4])}</td></tr>`).join("")}</tbody></table>` : "<p>No bookings in this view.</p>";
  return {html,text:rows.length?[headers.join(" | "),...lines.map(line=>line.join(" | "))].join("\n"):"No bookings in this view."};
}
