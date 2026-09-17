import { dateKey } from "./submitterBookings";
import type { PublicMeeting } from "./publicBookings";

/** Include a today anchor even on empty days; keep history before it. */
export function bookingListGroups(rows:PublicMeeting[],today:string,timezone:string) {
  const groups=new Map<string,PublicMeeting[]>([[today,[]]]);
  for(const row of rows){
    const day=dateKey(row.startAt,timezone);
    if(!groups.has(day))groups.set(day,[]);
    groups.get(day)!.push(row);
    // Overnight bookings still running today also belong in today's agenda.
    if(day<today&&dateKey(Math.max(row.startAt,row.endAt-1),timezone)>=today)groups.get(today)!.push(row);
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([day,meetings])=>({day,meetings:meetings.sort((a,b)=>a.startAt-b.startAt||a.key.localeCompare(b.key))}));
}
