import { v } from "convex/values";
import { action, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { BOOKABLE_GOOGLE_CALENDAR_VENUES, googleCalendarRuntimeFromEnv } from "./lib/googleCalendar";
import { publicCalendarRange, projectGoogleEvent, isInPublicRange } from "./lib/googlePublicCalendar";
import type { PublicMeeting } from "./lib/publicBookings";
import { writeAuditLog } from "./lib/auditLog";
import { ministryCalendarLabel } from "../shared/requestFields";

type Cache={json?:string;fetchedAt?:number;error?:string};
type Result={rows:PublicMeeting[];fetchedAt:number|null;error:string|null;refreshing:boolean};
// The public calendar is a read-only convenience view. Refreshing a full
// schedule every minute causes the complete JSON cache to be read and written
// continuously, even while nobody changes a booking. Keep the schedule fresh
// enough for normal use while making its storage I/O proportional to actual
// booking activity instead of open browser tabs.
const CACHE_TTL_MS=15*60*1000;
function result(cache:Cache|null,refreshing=false):Result{return {rows:cache?.json?JSON.parse(cache.json):[],fetchedAt:cache?.fetchedAt??null,error:cache?.error??null,refreshing};}
async function hash(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}

export const claim=internalMutation({args:{key:v.string(),token:v.string()},handler:async(ctx,args)=>{
  const now=Date.now();
  const expired=await ctx.db.query('publicCalendarCache').withIndex('by_retry',q=>q.lt('retryAt',now-86400000)).take(20);
  for(const row of expired)if(row.key!=='global'&&row.key!==args.key&&(row.leaseUntil??0)<now)await ctx.db.delete(row._id);
  let cache=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key',args.key)).unique();
  if(cache&&(cache.retryAt>now||(cache.leaseUntil??0)>now))return {fetch:false,cache,refreshing:!!cache.token};
  const gate=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key','global')).unique();
  if(gate&&gate.retryAt>now)return {fetch:false,cache,refreshing:true};
  if(gate)await ctx.db.patch(gate._id,{retryAt:now+3000});else await ctx.db.insert('publicCalendarCache',{key:'global',retryAt:now+3000});
  const lease={token:args.token,leaseUntil:now+5*60000,retryAt:now};
  if(cache)await ctx.db.patch(cache._id,lease);else {const id=await ctx.db.insert('publicCalendarCache',{key:args.key,...lease});cache=await ctx.db.get(id);}
  return {fetch:true,cache,refreshing:true};
}});
export const finish=internalMutation({args:{key:v.string(),token:v.string(),json:v.optional(v.string()),error:v.optional(v.string())},handler:async(ctx,args)=>{
  const cache=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key',args.key)).unique();
  if(!cache||cache.token!==args.token)return null;
  const now=Date.now();
  const next={token:undefined,leaseUntil:undefined,retryAt:now+CACHE_TTL_MS,error:args.error,...(args.json!==undefined?{json:args.json,fetchedAt:now}:{})};
  await ctx.db.patch(cache._id,next);
  if(args.error)await writeAuditLog(ctx,{level:'error',category:'google_calendar',action:'public_calendar_read_failed',actorType:'system',message:'Public Google Calendar refresh failed. Check calendar sharing, credentials and response limits.',createdAt:now});
  // `cache` already contains the current JSON. Returning a constructed value
  // avoids rereading that potentially large document immediately after writing
  // it just to send the same schedule back to this action.
  return {...cache,...next};
}});
// Only use metadata from a verified, approved RoomOps row. Never override Google times/titles.
async function linkedMinistry(ctx:QueryCtx,args:{bookingId:string;startAt:number}):Promise<string>{
  const id=ctx.db.normalizeId('bookings',args.bookingId);if(!id)return '';
  const booking=await ctx.db.get(id);if(!booking||booking.status!=='approved')return '';
  const occurrence=booking.occurrences?.find(row=>row.startAt===args.startAt);
  if(booking.occurrences?.some(row=>row.details?.ministry!==undefined)&&!occurrence)return '';
  return ministryCalendarLabel(occurrence?.details?.ministry??booking.ministry??'');
}
export const ministry=internalQuery({args:{bookingId:v.string(),startAt:v.number()},handler:linkedMinistry});
export const ministries=internalQuery({args:{items:v.array(v.object({bookingId:v.string(),startAt:v.number()}))},handler:async(ctx,args)=>{
  if(args.items.length>100)throw Error('Metadata batch too large.');
  return await Promise.all(args.items.map(item=>linkedMinistry(ctx,item)));
}});

export const read=action({args:{month:v.string()},handler:async(ctx,args):Promise<Result>=>{
  const range=publicCalendarRange(args.month);
  const timezone=process.env.BOOKING_TIME_ZONE||'Asia/Singapore';
  let runtime:ReturnType<typeof googleCalendarRuntimeFromEnv>;
  try{runtime=googleCalendarRuntimeFromEnv(process.env);}catch{return {rows:[],fetchedAt:null,error:'Google Calendar configuration needs administrator attention.',refreshing:false};}
  if(!runtime)return {rows:[],fetchedAt:null,error:'Google Calendar is not enabled.',refreshing:false};
  const targets=new Map<string,string[]>();
  for(const venue of BOOKABLE_GOOGLE_CALENDAR_VENUES)for(const id of runtime.venueMap[venue])targets.set(id,[...new Set([...(targets.get(id)??[]),venue])]);
  if(!targets.size)return {rows:[],fetchedAt:null,error:'No venue calendars are configured.',refreshing:false};
  const key=await hash(JSON.stringify([args.month,timezone,[...targets],runtime.credentials.clientEmail]));
  const token=crypto.randomUUID();
  const claimed=await ctx.runMutation(internal.publicCalendar.claim,{key,token});
  if(!claimed.fetch)return result(claimed.cache,claimed.refreshing);
  try{
    const rows:PublicMeeting[]=[];
    // A single RoomOps booking can be represented in more than one venue
    // calendar. Look up its ministry once per occurrence, then apply it to
    // every projected calendar row instead of rereading the booking document.
    const linked=new Map<string,{bookingId:string;startAt:number;rows:PublicMeeting[]}>();
    for(const [calendarId,rooms] of targets){
      const events=await runtime.client.listPublicSchedule(calendarId,range.from,range.until,timezone);
      for(const event of events){
        const row=projectGoogleEvent(event,await hash(calendarId+'\n'+event.id),rooms,timezone);
        if(!row||!isInPublicRange(row,args.month,timezone))continue;
        const props=event.extendedProperties?.private;
        if(event.visibility!=='private'&&event.visibility!=='confidential'&&props?.roomopsManaged==='true'&&props.roomopsBookingId){
          const linkKey=`${props.roomopsBookingId}\u0000${row.startAt}`;
          const entry=linked.get(linkKey)??{bookingId:props.roomopsBookingId,startAt:row.startAt,rows:[]};
          entry.rows.push(row);
          linked.set(linkKey,entry);
        }
        rows.push(row);
      }
    }
    const linkedEntries=[...linked.values()];
    for(let i=0;i<linkedEntries.length;i+=100){
      const batch=linkedEntries.slice(i,i+100);
      const values=await ctx.runQuery(internal.publicCalendar.ministries,{items:batch.map(({bookingId,startAt})=>({bookingId,startAt}))});
      batch.forEach((entry,index)=>{for(const row of entry.rows)row.ministry=values[index]??'';});
    }
    const json=JSON.stringify(rows.sort((a,b)=>a.startAt-b.startAt||a.key.localeCompare(b.key)));
    if(new TextEncoder().encode(json).length>750000)throw Error('Schedule too large.');
    return result(await ctx.runMutation(internal.publicCalendar.finish,{key,token,json}));
  }catch{
    const cache=await ctx.runMutation(internal.publicCalendar.finish,{key,token,error:'Google Calendar could not be refreshed. Any displayed events are from the last successful refresh.'});
    return result(cache);
  }
}});
