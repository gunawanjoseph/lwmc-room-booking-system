import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requestMeetings } from "./lib/requesterRules";
import { writeAuditLog } from "./lib/auditLog";
const HOUR=3600000, LEASE=31*60_000;
export const reminderOffsets = { two_days:48*HOUR, two_hours:2*HOUR } as const;
type Kind=keyof typeof reminderOffsets;
export async function planReminders(ctx:MutationCtx, booking:Doc<"bookings">, addedAt:number):Promise<void> {
  if(booking.status!=="approved" || booking.calendarSyncStatus!=="synced")return;
  const now=Date.now();
  const existing=await ctx.db.query("bookingReminders").withIndex("by_booking",q=>q.eq("bookingId",booking._id)).collect();
  const meetings=requestMeetings(booking);
  const valid=new Set(meetings.flatMap(row=>(Object.keys(reminderOffsets) as Kind[]).map(kind=>`${row.sequence}:${row.startAt}:${kind}`)));
  for(const row of existing)if(row.status==="pending" && !valid.has(row.key))await ctx.db.patch(row._id,{status:"skipped"});
  for(const meeting of meetings)for(const kind of Object.keys(reminderOffsets) as Kind[]) {
    const key=`${meeting.sequence}:${meeting.startAt}:${kind}`, dueAt=meeting.startAt-reminderOffsets[kind];
    if(dueAt<addedAt || dueAt<now)continue;
    const previous=existing.find(row=>row.key===key);
    if(previous) {
      // A future time restored by an edit can reuse an unsent, invalidated job.
      if(previous.status === "skipped" && previous.attempts === 0) {
        await ctx.db.patch(previous._id,{status:"pending",addedAt});
        await ctx.scheduler.runAfter(Math.max(0,dueAt-now),internal.emailNotifications.sendBookingReminder,{reminderId:previous._id});
      }
      continue;
    }
    const id=await ctx.db.insert("bookingReminders",{bookingId:booking._id,key,kind,sequence:meeting.sequence,startAt:meeting.startAt,dueAt,addedAt,status:"pending",attempts:0});
    await ctx.scheduler.runAfter(Math.max(0,dueAt-now),internal.emailNotifications.sendBookingReminder,{reminderId:id});
  }
}
// Also enrolls pre-existing approved bookings, one bounded page at a time.
export const sweep=internalMutation({args:{cursor:v.optional(v.string())},handler:async(ctx,args):Promise<void>=>{
  const page=await ctx.db.query("bookings").withIndex("by_status",q=>q.eq("status","approved")).paginate({numItems:1,cursor:args.cursor??null});
  for(const booking of page.page)await planReminders(ctx,booking,booking.calendarSyncedAt??booking.reviewedAt??booking.createdAt);
  if(!page.isDone)await ctx.scheduler.runAfter(0,internal.bookingReminders.sweep,{cursor:page.continueCursor});
}});
export const claim=internalMutation({args:{reminderId:v.id("bookingReminders"),token:v.string()},handler:async(ctx,args):Promise<{booking:Doc<"bookings">;meeting:ReturnType<typeof requestMeetings>[number];kind:Kind;linkToken?:string}|null>=>{
  const row=await ctx.db.get(args.reminderId),now=Date.now();
  if(!row || row.status!=="pending" || (row.leaseUntil??0)>now)return null;
  if(row.dueAt>now){await ctx.scheduler.runAfter(row.dueAt-now,internal.emailNotifications.sendBookingReminder,{reminderId:row._id});return null;}
  const booking=await ctx.db.get(row.bookingId);
  const meeting=booking?requestMeetings(booking).find(item=>item.sequence===row.sequence && item.startAt===row.startAt):undefined;
  if(!booking || booking.status!=="approved" || !meeting || now>=row.startAt || now-row.dueAt>15*60_000 || (row.kind==="two_days" && now>=row.startAt-2*HOUR)){
    await ctx.db.patch(row._id,{status:"skipped",token:undefined,leaseUntil:undefined});return null;
  }
  if(booking.calendarSyncStatus!=="synced" || booking.calendarSyncToken || booking.deletionToken || booking.requesterOperationId || (booking.reminderLeaseExpiresAt??0)>now){
    await ctx.scheduler.runAfter(60_000,internal.emailNotifications.sendBookingReminder,{reminderId:row._id});return null;
  }
  if(row.attempts>=5){await ctx.db.patch(row._id,{status:"failed"});return null;}
  await ctx.db.patch(row._id,{status:"sending",token:args.token,leaseUntil:now+LEASE,attempts:row.attempts+1});
  await ctx.db.patch(booking._id,{reminderLeaseToken:args.token,reminderLeaseExpiresAt:now+LEASE});
  await ctx.scheduler.runAfter(LEASE,internal.bookingReminders.recover,args);
  let linkToken:string|undefined;
  if(row.kind==="two_days") {
    const links=await ctx.db.query("requesterLinks").withIndex("by_booking",q=>q.eq("bookingId",booking._id)).collect();
    const email=booking.requesterEmail.trim().toLowerCase();
    linkToken=links.find(link=>!link.revokedAt&&link.email===email)?.token;
    if(!linkToken){linkToken=(crypto.randomUUID()+crypto.randomUUID()).replaceAll("-","");await ctx.db.insert("requesterLinks",{bookingId:booking._id,email,token:linkToken,createdAt:now});}
  }
  return {booking,meeting,kind:row.kind,linkToken};
}});
async function release(ctx:MutationCtx,row:Doc<"bookingReminders">,token:string){
  const booking=await ctx.db.get(row.bookingId);
  if(booking?.reminderLeaseToken===token)await ctx.db.patch(booking._id,{reminderLeaseToken:undefined,reminderLeaseExpiresAt:undefined});
}
export const finish=internalMutation({args:{reminderId:v.id("bookingReminders"),token:v.string(),error:v.optional(v.string())},handler:async(ctx,args):Promise<void>=>{
  const row=await ctx.db.get(args.reminderId);if(!row||row.token!==args.token)return;
  await release(ctx,row,args.token);
  const retry=!!args.error&&row.attempts<5&&Date.now()+60_000<=row.dueAt+15*60_000;
  await ctx.db.patch(row._id,{status:args.error?(retry?"pending":"failed"):"sent",token:undefined,leaseUntil:undefined,sentAt:args.error?undefined:Date.now()});
  if(retry)await ctx.scheduler.runAfter(60_000,internal.emailNotifications.sendBookingReminder,{reminderId:row._id});
  if(args.error)await writeAuditLog(ctx,{level:"error",category:"system",action:"booking_reminder_failed",actorType:"system",entityType:"booking",entityId:String(row.bookingId),message:"A booking reminder could not be delivered.",detailsJson:JSON.stringify({kind:row.kind,retry,error:args.error.slice(0,600)}),createdAt:Date.now()});
}});
export const recover=internalMutation({args:{reminderId:v.id("bookingReminders"),token:v.string()},handler:async(ctx,args):Promise<void>=>{
  const row=await ctx.db.get(args.reminderId);if(!row||row.token!==args.token)return;
  if((row.leaseUntil??0)>Date.now()){await ctx.scheduler.runAfter(row.leaseUntil!-Date.now(),internal.bookingReminders.recover,args);return;}
  await release(ctx,row,args.token);
  // A timed-out Gmail call may already have delivered. Do not send a duplicate.
  await ctx.db.patch(row._id,{status:"failed",token:undefined,leaseUntil:undefined});
  await writeAuditLog(ctx,{level:"error",category:"system",action:"booking_reminder_uncertain",actorType:"system",entityType:"booking",entityId:String(row.bookingId),message:"Reminder delivery timed out. Delivery is uncertain; no automatic duplicate was sent.",createdAt:Date.now()});
}});
