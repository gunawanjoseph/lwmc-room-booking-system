import { configuredDeveloperEmail } from "./lib/developerIdentity";
import type { Doc } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireHeadAdmin } from "./lib/auth";
import { writeAuditLog } from "./lib/auditLog";

const LEASE_MS = 31 * 60_000;
const MAX_ATTEMPTS = 5;
export const list = query({args: {}, handler: async ctx => {
  await requireHeadAdmin(ctx);
  return { developerEmail: configuredDeveloperEmail(),
    deliveries: await ctx.db.query("techAlertDeliveries").withIndex("by_created_at").order("desc").take(30) };
}});
export const save = mutation({args: {email: v.string(), active: v.boolean()}, handler: async (ctx) => {
  await requireHeadAdmin(ctx);
  // Keep the endpoint so stale clients fail safely, rather than changing recipients.
  throw new ConvexError("Developer identity and notifications are configured only through DEVELOPER_EMAIL in Convex.");
}});
export const claim = internalMutation({args:{deliveryId:v.id("techAlertDeliveries"), token:v.string()}, handler:async(ctx,args): Promise<{ email: string; log: Doc<"auditLogs"> } | null> => {
  const row=await ctx.db.get(args.deliveryId);
  if(!row || row.status==='sent' || row.status==='cancelled' || row.status==='failed' || (row.leaseExpiresAt ?? 0)>Date.now())return null;
  const log=await ctx.db.get(row.logId);
  if(row.email !== configuredDeveloperEmail() || !log){await ctx.db.patch(row._id,{status:'cancelled',updatedAt:Date.now()});return null;}
  if(row.attempts>=MAX_ATTEMPTS){await ctx.db.patch(row._id,{status:'failed',updatedAt:Date.now()});return null;}
  await ctx.db.patch(row._id,{status:'sending',attempts:row.attempts+1,leaseToken:args.token,leaseExpiresAt:Date.now()+LEASE_MS,updatedAt:Date.now()});
  await ctx.scheduler.runAfter(LEASE_MS,internal.techSupport.recover,{deliveryId:row._id,token:args.token});
  return {email:row.email,log};
}});
export const finish = internalMutation({args:{deliveryId:v.id("techAlertDeliveries"),token:v.string(),error:v.optional(v.string())},handler:async(ctx,args)=>{
  const row=await ctx.db.get(args.deliveryId);
  if(!row || row.leaseToken!==args.token)return;
  const failed=Boolean(args.error);
  const retry=failed && row.attempts<MAX_ATTEMPTS;
  await ctx.db.patch(row._id,{status:failed ? (retry?'pending':'failed'):'sent',error:args.error?.slice(0,1000),leaseToken:undefined,leaseExpiresAt:undefined,updatedAt:Date.now()});
  if(retry)await ctx.scheduler.runAfter(Math.min(15*60_000,60_000*2**(row.attempts-1)),internal.emailNotifications.sendTechAlert,{deliveryId:row._id});
  if(failed && !retry)await writeAuditLog(ctx,{level:'error',category:'system',action:'tech_alert_delivery_failed',actorType:'system',entityType:'techAlertDelivery',entityId:String(row._id),message:'Developer email exhausted its delivery retries. Check support alert delivery status and Gmail configuration.',createdAt:Date.now()});
}});
export const recover=internalMutation({args:{deliveryId:v.id("techAlertDeliveries"),token:v.string()},handler:async(ctx,args)=>{
  const row=await ctx.db.get(args.deliveryId);
  if(!row || row.leaseToken!==args.token)return;
  if((row.leaseExpiresAt ?? 0)>Date.now()){
    await ctx.scheduler.runAfter(row.leaseExpiresAt!-Date.now()+1000,internal.techSupport.recover,args);return;
  }
  await ctx.db.patch(row._id,{status:row.attempts>=MAX_ATTEMPTS?'failed':'pending',leaseToken:undefined,leaseExpiresAt:undefined,error:'Alert worker timed out; delivery outcome may be unknown.',updatedAt:Date.now()});
  if(row.attempts<MAX_ATTEMPTS)await ctx.scheduler.runAfter(0,internal.emailNotifications.sendTechAlert,{deliveryId:row._id});
}});
export const retry=mutation({args:{deliveryId:v.id("techAlertDeliveries")},handler:async(ctx,args)=>{
  await requireHeadAdmin(ctx);
  const row=await ctx.db.get(args.deliveryId);
  if(!row || row.status!=='failed')throw new ConvexError('Only failed alerts can be retried.');
  await ctx.db.patch(row._id,{status:'pending',attempts:0,error:undefined,leaseToken:undefined,leaseExpiresAt:undefined,updatedAt:Date.now()});
  await ctx.scheduler.runAfter(0,internal.emailNotifications.sendTechAlert,args);
}});
