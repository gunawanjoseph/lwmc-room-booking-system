import type { SubmitterBooking } from "./submitterBookings";

export type PublicMeeting = {
  allDay?:boolean; source?:"google"; googleStatus?:"confirmed"|"tentative";
  key:string; title:string; room:string; rooms:string[]; ministry:string;
  status:"approved"; startAt:number; endAt:number; timezone:string;
};
type PublicOccurrence={sequence:number;startAt:number;endAt:number;room?:string;resolvedVenues?:string[];details?:{eventName?:string;ministry?:string}};
type PublicBookingSource = Omit<SubmitterBooking,"occurrences"> & {
  ministry?:string; resolvedVenues?:string[];
  occurrences?:PublicOccurrence[];
};
/** Explicit public allowlist: never return contact details, answers, or internal logs. */
export function publicMeetings(booking:PublicBookingSource):PublicMeeting[] {
  const status=booking.status;
  if(status!=="approved")return [];
  const occurrences:PublicOccurrence[]=booking.occurrences??[{sequence:0,startAt:booking.startAt,endAt:booking.endAt}];
  return occurrences.map(item=>({
    key:`${booking._id}:${item.sequence}`,title:item.details?.eventName??booking.eventName??"Room booking",
    room:item.room??booking.room,
    rooms:item.resolvedVenues?.length?item.resolvedVenues: item.room?[item.room]:booking.resolvedVenues?.length?booking.resolvedVenues:[booking.room],
    ministry:(item.details?.ministry??booking.ministry??"").trim(),
    status,startAt:item.startAt,endAt:item.endAt,timezone:booking.timezone,
  }));
}
export type PublicFilters={ministries:readonly string[];rooms:readonly string[]};
export function filterPublicMeetings(rows:PublicMeeting[],filters:PublicFilters):PublicMeeting[] {
  return rows.filter(row=>row.status==="approved"&&
    (!filters.ministries.length||filters.ministries.includes(row.ministry))&&
    (!filters.rooms.length||filters.rooms.includes(row.room)||row.rooms.some(room=>filters.rooms.includes(room))))
    .sort((a,b)=>a.startAt-b.startAt||a.key.localeCompare(b.key));
}
