import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { writeAuditLog } from "./lib/auditLog";
import type { Doc } from "./_generated/dataModel";
const LEASE=31*60_000;
export const claim=internalMutation({args:{noticeId:v.id("bookingNotices"),token:v.string()},handler:async(ctx,args):Promise<Doc<"bookingNotices">|null>=>{
  const row=await ctx.db.get(args.noticeId);
  if(!row||row.status==="sent"||row.status==="failed"||(row.leaseExpiresAt??0)>Date.now())return null;
  await ctx.db.patch(row._id,{status:"sending",token:args.token,leaseExpiresAt:Date.now()+LEASE,attempts:row.attempts+1,updatedAt:Date.now()});
  await ctx.scheduler.runAfter(LEASE,internal.bookingNotices.recover,args);
  return row;
}});
export const finish=internalMutation({args:{noticeId:v.id("bookingNotices"),token:v.string(),error:v.optional(v.string())},handler:async(ctx,args)=>{
  const row=await ctx.db.get(args.noticeId);if(!row||row.token!==args.token)return;
  const retry=!!args.error&&row.attempts<5;
  await ctx.db.patch(row._id,{status:args.error?(retry?"pending":"failed"):"sent",token:undefined,leaseExpiresAt:undefined,error:args.error?"Submitter notification failed. Check Gmail configuration.":undefined,updatedAt:Date.now()});
  if(retry)await ctx.scheduler.runAfter(60_000*2**(row.attempts-1),internal.emailNotifications.sendBookingNotice,{noticeId:row._id});
  if(args.error&&!retry)await writeAuditLog(ctx,{level:"error",category:"system",action:"submitter_change_email_failed",actorType:"system",entityType:"bookingNotice",entityId:String(row._id),message:"An opted-in booking change notification exhausted its email retries.",createdAt:Date.now()});
}});
export const recover=internalMutation({args:{noticeId:v.id("bookingNotices"),token:v.string()},handler:async(ctx,args)=>{
  const row=await ctx.db.get(args.noticeId);if(!row||row.token!==args.token)return;
  if((row.leaseExpiresAt??0)>Date.now()){await ctx.scheduler.runAfter(row.leaseExpiresAt!-Date.now()+1000,internal.bookingNotices.recover,args);return;}
  await ctx.db.patch(row._id,{status:row.attempts<5?"pending":"failed",token:undefined,leaseExpiresAt:undefined,error:"Email worker timed out; delivery may have been accepted.",updatedAt:Date.now()});
  if(row.attempts<5)await ctx.scheduler.runAfter(0,internal.emailNotifications.sendBookingNotice,{noticeId:row._id});
  else await writeAuditLog(ctx,{level:"error",category:"system",action:"submitter_change_email_failed",actorType:"system",entityType:"bookingNotice",entityId:String(row._id),message:"An opted-in booking change notification exhausted worker recovery attempts.",createdAt:Date.now()});
}});
