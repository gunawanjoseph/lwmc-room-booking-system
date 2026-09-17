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

export function shiftDay(day:string,offset:number):string {
  const date=new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+offset);
  return date.toISOString().slice(0,10);
}
export function weekDays(day:string):string[] {
  const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
  return Array.from({length:7},(_,i)=>shiftDay(day,i-weekday));
}
/** Position local-time blocks and give overlapping meetings separate columns. */
export function timelineMeetings<T extends Pick<SubmitterMeeting,"key"|"startAt"|"endAt">>(rows:T[],day:string,timezone:string) {
  function minute(timestamp:number) {
    const parts=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:timezone}).formatToParts(timestamp);
    return Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);
  }
  const blocks=meetingsOnDay(rows,day,timezone).map(meeting=>{
    const start=dateKey(meeting.startAt,timezone)<day?0:minute(meeting.startAt);
    const end=dateKey(meeting.endAt,timezone)>day?1440:minute(meeting.endAt);
    return {meeting,start,end:Math.min(1440,Math.max(start+30,end)),lane:0,lanes:1};
  }).sort((a,b)=>a.start-b.start||b.end-a.end||a.meeting.key.localeCompare(b.meeting.key));
  let group:typeof blocks=[];
  let ends:number[]=[];
  function finish(){for(const item of group)item.lanes=ends.length;group=[];ends=[];}
  for(const block of blocks){
    if(group.length&&block.start>=Math.max(...ends))finish();
    let lane=ends.findIndex(end=>end<=block.start);
    if(lane<0)lane=ends.length;
    ends[lane]=block.end;block.lane=lane;group.push(block);
  }
  finish();return blocks;
}
