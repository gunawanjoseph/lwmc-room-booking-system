import { dateKey } from "./submitterBookings";
import { monthDays, shiftDay } from "./bookingCalendar";
import type { PublicMeeting } from "./publicBookings";
export type PublicGoogleEvent={id?:string;status?:string;summary?:string;visibility?:string;start?:{date?:string;dateTime?:string;timeZone?:string};end?:{date?:string;dateTime?:string;timeZone?:string};extendedProperties?:{private?:Record<string,string>}};
export function publicCalendarRange(month:string){
  if(!/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(month))throw Error('Choose a valid month (1900–9999).');
  const days=monthDays(month);
  // UTC padding covers all local timezone offsets at either edge of the grid.
  return {from:shiftDay(days[0],-1)+'T00:00:00Z',until:shiftDay(days[41],2)+'T00:00:00Z',firstDay:days[0],lastDay:days[41]};
}
export function midnightInZone(day:string,zone:string):number {
  const target=Date.parse(day+'T00:00:00Z');let guess=target;
  for(let i=0;i<4;i++){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(guess);
    const value=(key:string)=>Number(parts.find(p=>p.type===key)!.value);
    const local=Date.UTC(value('year'),value('month')-1,value('day'),value('hour'),value('minute'),value('second'));
    if(local===target)return guess;
    guess+=target-local;
  }
  throw Error('Unable to resolve all-day event timezone.');
}
export function projectGoogleEvent(event:PublicGoogleEvent,key:string,rooms:string[],timezone:string,ministry=""):PublicMeeting|null {
  if(event.status==='cancelled')return null;
  if(!event.id||!event.start||!event.end)throw Error('Incomplete Google event.');
  const allDay=!!event.start.date;
  const startAt=allDay?midnightInZone(event.start.date!,timezone):Date.parse(event.start.dateTime??'');
  const endAt=event.end.date?midnightInZone(event.end.date,timezone):Date.parse(event.end.dateTime??'');
  if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt)throw Error('Invalid Google event times.');
  const privateEvent=event.visibility==='private'||event.visibility==='confidential';
  return {key,title:privateEvent?'Busy':event.summary?.trim()||'Busy',room:rooms.join(' / '),rooms,ministry:privateEvent?'':ministry,status:'approved',startAt,endAt,timezone,allDay,source:'google',googleStatus:event.status==='tentative'?'tentative':'confirmed'};
}
export function isInPublicRange(row:PublicMeeting,month:string,timezone:string){const range=publicCalendarRange(month);return dateKey(row.startAt,timezone)<=range.lastDay&&dateKey(row.endAt-1,timezone)>=range.firstDay;}
