import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { BOOKABLE_GOOGLE_CALENDAR_VENUES, PUBLIC_MINISTRY_NONE, googleCalendarRuntimeFromEnv, publicMinistryProperty } from "./lib/googleCalendar";
import { publicCalendarRange, projectGoogleEvent, isInPublicRange } from "./lib/googlePublicCalendar";
import type { PublicMeeting } from "./lib/publicBookings";
import { writeAuditLog } from "./lib/auditLog";
import { ministryCalendarLabel } from "../shared/requestFields";

type Cache=Doc<'publicCalendarCache'>;
// `unchanged` means the caller's copy (fetchedAt === since) is current, so the
// schedule is not re-read or re-sent; older clients never pass `since`.
type Result={rows:PublicMeeting[];fetchedAt:number|null;error:string|null;refreshing:boolean;unchanged?:boolean};
// The public calendar is a read-only convenience view. Refreshing a full
// schedule every minute causes the complete JSON cache to be read and written
// continuously, even while nobody changes a booking. Keep the schedule fresh
// enough for normal use while making its storage I/O proportional to actual
// booking activity instead of open browser tabs.
const CACHE_TTL_MS=15*60*1000;
const empty:Result={rows:[],fetchedAt:null,error:null,refreshing:false};
async function snapshot(ctx:QueryCtx,cache:Cache|null,since:number|undefined,refreshing:boolean):Promise<Result>{
  if(!cache)return {rows:[],fetchedAt:null,error:null,refreshing};
  const base={fetchedAt:cache.fetchedAt??null,error:cache.error??null,refreshing};
  if(since!==undefined&&cache.fetchedAt===since)return {...base,rows:[],unchanged:true};
  const json=cache.payloadId?(await ctx.db.get(cache.payloadId))?.json:cache.json;
  return {...base,rows:json?JSON.parse(json):[]};
}
async function hash(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}

export const claim=internalMutation({args:{key:v.string(),token:v.string(),since:v.optional(v.number())},handler:async(ctx,args):Promise<{fetch:true}|{fetch:false;result:Result}>=>{
  const now=Date.now();
  const expired=await ctx.db.query('publicCalendarCache').withIndex('by_retry',q=>q.lt('retryAt',now-86400000)).take(20);
  for(const row of expired)if(row.key!=='global'&&row.key!==args.key&&(row.leaseUntil??0)<now){
    if(row.payloadId)await ctx.db.delete(row.payloadId);
    await ctx.db.delete(row._id);
  }
  const cache=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key',args.key)).unique();
  if(cache&&(cache.retryAt>now||(cache.leaseUntil??0)>now))return {fetch:false,result:await snapshot(ctx,cache,args.since,!!cache.token)};
  const gate=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key','global')).unique();
  if(gate&&gate.retryAt>now)return {fetch:false,result:await snapshot(ctx,cache,args.since,true)};
  if(gate)await ctx.db.patch(gate._id,{retryAt:now+3000});else await ctx.db.insert('publicCalendarCache',{key:'global',retryAt:now+3000});
  const lease={token:args.token,leaseUntil:now+5*60000,retryAt:now};
  if(cache)await ctx.db.patch(cache._id,lease);else await ctx.db.insert('publicCalendarCache',{key:args.key,...lease});
  return {fetch:true};
}});
export const finish=internalMutation({args:{key:v.string(),token:v.string(),since:v.optional(v.number()),json:v.optional(v.string()),error:v.optional(v.string())},handler:async(ctx,args):Promise<Result|null>=>{
  const cache=await ctx.db.query('publicCalendarCache').withIndex('by_key',q=>q.eq('key',args.key)).unique();
  if(!cache||cache.token!==args.token)return null;
  const now=Date.now();
  let payloadId=cache.payloadId;
  if(args.json!==undefined){
    if(payloadId)await ctx.db.patch(payloadId,{json:args.json});
    else payloadId=await ctx.db.insert('publicCalendarPayloads',{json:args.json});
  }
  const next={token:undefined,leaseUntil:undefined,retryAt:now+CACHE_TTL_MS,error:args.error,...(args.json!==undefined?{payloadId,json:undefined,fetchedAt:now}:{})};
  await ctx.db.patch(cache._id,next);
  if(args.error)await writeAuditLog(ctx,{level:'error',category:'google_calendar',action:'public_calendar_read_failed',actorType:'system',message:'Public Google Calendar refresh failed. Check calendar sharing, credentials and response limits.',createdAt:now});
  // On success the action already holds the new rows, so do not read them
  // back; on failure fall back to the last good schedule.
  if(args.json!==undefined)return {rows:[],fetchedAt:now,error:args.error??null,refreshing:false};
  return await snapshot(ctx,{...cache,...next},args.since,false);
}});
// Fallback for events written before roomopsMinistry existed: only use
// metadata from a verified, approved RoomOps row. Never override Google times/titles.
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

export const read=action({args:{month:v.string(),since:v.optional(v.number())},handler:async(ctx,args):Promise<Result>=>{
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
  const claimed=await ctx.runMutation(internal.publicCalendar.claim,{key,token,since:args.since});
  if(!claimed.fetch)return claimed.result;
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
          // RoomOps writes the label onto the event; only events written
          // before that need the booking read below.
          if(props.roomopsMinistry!==undefined){row.ministry=props.roomopsMinistry===PUBLIC_MINISTRY_NONE?'':props.roomopsMinistry;rows.push(row);continue;}
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
    const saved=await ctx.runMutation(internal.publicCalendar.finish,{key,token,json});
    return saved?{...saved,rows}:empty;
  }catch{
    const saved=await ctx.runMutation(internal.publicCalendar.finish,{key,token,since:args.since,error:'Google Calendar could not be refreshed. Any displayed events are from the last successful refresh.'});
    return saved??empty;
  }
}});

// One-off: adds roomopsMinistry to events synced before it existed, so the
// public calendar never needs the booking fallback for them. Safe to rerun.
//   npx convex run publicCalendar:backfillEventMinistries
const BACKFILL_LOOKBACK_MS=62*86400000;
export const approvedEventMinistries=internalQuery({args:{cursor:v.union(v.string(),v.null())},handler:async(ctx,args)=>{
  const since=Date.now()-BACKFILL_LOOKBACK_MS;
  const page=await ctx.db.query('bookings').withIndex('by_status',q=>q.eq('status','approved')).paginate({numItems:25,cursor:args.cursor});
  const events=page.page.flatMap(booking=>(booking.calendarEvents??[]).filter(ref=>(ref.endAt??Infinity)>=since).map(ref=>{
    const occurrence=booking.occurrences?.find(row=>row.sequence===ref.occurrenceSequence);
    return {calendarId:ref.calendarId,eventId:ref.eventId,ministry:occurrence?.details?.ministry??booking.ministry??''};
  }));
  return {events,isDone:page.isDone,cursor:page.continueCursor};
}});
export const backfillEventMinistries=internalAction({args:{},handler:async(ctx):Promise<{updated:number;failed:number}>=>{
  const runtime=googleCalendarRuntimeFromEnv(process.env);
  if(!runtime)return {updated:0,failed:0};
  let cursor:string|null=null,updated=0,failed=0;
  for(;;){
    const page:{events:{calendarId:string;eventId:string;ministry:string}[];isDone:boolean;cursor:string}=await ctx.runQuery(internal.publicCalendar.approvedEventMinistries,{cursor});
    for(const event of page.events){
      try{await runtime.client.setPrivateProperties(event.calendarId,event.eventId,{roomopsMinistry:publicMinistryProperty(event.ministry)});updated++;}
      catch{failed++;}
    }
    if(page.isDone)break;
    cursor=page.cursor;
  }
  return {updated,failed};
}});
