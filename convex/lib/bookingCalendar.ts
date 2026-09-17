import { dateKey, type SubmitterMeeting } from "./submitterBookings";

// Date-only UTC arithmetic keeps the grid independent of the browser's timezone/DST.
export function shiftMonth(month: string, offset: number): string {
  const [year,number]=month.split("-").map(Number);
  return new Date(Date.UTC(year,number-1+offset,1)).toISOString().slice(0,7);
}
export function monthDays(month: string): string[] {
  const [year,number]=month.split("-").map(Number);
  const first=new Date(Date.UTC(year,number-1,1));
  const start=first.getTime()-first.getUTCDay()*86400000;
  return Array.from({length:42},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10));
}
export function meetingsOnDay<T extends Pick<SubmitterMeeting,"key"|"startAt"|"endAt">>(rows: T[], day: string, timezone: string) {
  // End is exclusive: a meeting ending at midnight doesn't occupy the next day.
  return rows.filter(row=>dateKey(row.startAt,timezone)<=day&&dateKey(Math.max(row.startAt,row.endAt-1),timezone)>=day)
    .sort((a,b)=>a.startAt-b.startAt||a.key.localeCompare(b.key));
}

/** Show both endpoints; include dates when a meeting crosses local midnight. */
export function calendarTimeRange(meeting:Pick<SubmitterMeeting,"startAt"|"endAt">,timezone:string):string {
  const crossesDate=dateKey(meeting.startAt,timezone)!==dateKey(meeting.endAt,timezone);
  const format=new Intl.DateTimeFormat("en-SG",{
    hour:"numeric",minute:"2-digit",timeZone:timezone,
    ...(crossesDate?{day:"numeric" as const,month:"short" as const}:{}),
  });
  return `${format.format(meeting.startAt)} – ${format.format(meeting.endAt)}`;
}
