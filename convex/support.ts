import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { effectiveCapabilities, normalizeUser, requireCapability, userBySubject } from "./lib/auth";
import { canManageSupportThread, MAX_SUPPORT_ATTACHMENTS, MAX_SUPPORT_IMAGE_BYTES, SUPPORT_IMAGE_TYPES, supportAttachmentName, supportText, validRequestId } from "./lib/supportRules";

type Actor = Awaited<ReturnType<typeof requireCapability>>;
const severity = v.union(v.literal("low"),v.literal("medium"),v.literal("high"),v.literal("critical"));
const announcementType = v.union(v.literal("feature"),v.literal("change"),v.literal("bug_known"),v.literal("bug_fixed"));
const isDeveloper = (actor: Actor) => effectiveCapabilities(actor).includes("support.develop");
const now = () => Date.now();

async function queueNotifications(ctx: MutationCtx, message: Doc<"supportMessages">, thread: Doc<"supportThreads">, developer: boolean, broadcast: boolean) {
  const targets = new Map<string, {email: string; recipientKind:"technical"|"admin"; recipientSubject?:string}>();
  if (!developer) {
    const recipients = await ctx.db.query("techSupportEmails").withIndex("by_active",q=>q.eq("active",true)).take(20);
    for (const recipient of recipients) targets.set(recipient.email,{email:recipient.email,recipientKind:"technical"});
  } else {
    // Announcements notify all active booking administrators. Replies notify
    // the administrators who have participated in this conversation.
    const candidates = broadcast
      ? (await ctx.db.query("users").withIndex("by_status",q=>q.eq("status","active")).collect()).map(normalizeUser)
      : (await Promise.all((await ctx.db.query("supportParticipants").withIndex("by_thread",q=>q.eq("threadId",thread._id)).collect()).map(p=>userBySubject(ctx,p.userSubject)))).filter((u): u is NonNullable<typeof u> => u !== null);
    for (const user of candidates) {
      if (user.clerkUserId !== message.authorId && effectiveCapabilities(user).includes("support.view") && user.role !== "tech_support") {
        targets.set(user.email,{email:user.email,recipientKind:"admin",recipientSubject:user.clerkUserId});
      }
    }
  }
  for (const target of targets.values()) {
    const deliveryId = await ctx.db.insert("supportDeliveries",{...target,messageId:message._id,status:"pending",attempts:0,createdAt:now(),updatedAt:now()});
    await ctx.scheduler.runAfter(0,internal.emailNotifications.sendSupportMessage,{deliveryId});
  }
}
async function saveMessage(ctx: MutationCtx, actor: Actor, thread: Doc<"supportThreads">, body: string, attachmentIds: Id<"supportAttachments">[], requestId: string, system = false, createdAt = now(), broadcast = false) {
  const developer = actor.role === "tech_support" || broadcast;
  const unique = [...new Set(attachmentIds)];
  if (unique.length !== attachmentIds.length || unique.length > MAX_SUPPORT_ATTACHMENTS) throw new ConvexError("Attach up to five different pictures.");
  body = supportText(body,8000,unique.length===0);
  for (const id of unique) {
    const file = await ctx.db.get(id);
    if (!file || file.owner !== actor.clerkUserId || file.messageId || file.expiresAt <= now()) throw new ConvexError("An attachment expired, was already sent or does not belong to you. Upload it again.");
  }
  const participant = await ctx.db.query("supportParticipants").withIndex("by_thread_user",q=>q.eq("threadId",thread._id).eq("userSubject",actor.clerkUserId)).unique();
  if (!participant) await ctx.db.insert("supportParticipants",{threadId:thread._id,userSubject:actor.clerkUserId});
  const messageId = await ctx.db.insert("supportMessages",{threadId:thread._id,authorId:actor.clerkUserId,authorName:actor.displayName,authorKind:developer?"developer":"admin",body,attachmentIds:unique,requestId,system,createdAt});
  for (const id of unique) await ctx.db.patch(id,{messageId});
  const message = (await ctx.db.get(messageId))!;
  await queueNotifications(ctx,message,thread,developer,broadcast);
  return messageId;
}
async function existingRequest(ctx: MutationCtx, subject: string, requestId: string) {
  validRequestId(requestId);
  return ctx.db.query("supportMessages").withIndex("by_author_request",q=>q.eq("authorId",subject).eq("requestId",requestId)).unique();
}
export const list = query({args:{kind:v.union(v.literal("report"),v.literal("announcement")),status:v.optional(v.union(v.literal("open"),v.literal("solved"))),paginationOpts:paginationOptsValidator},handler:async(ctx,args)=>{
  await requireCapability(ctx,"support.view");
  let cursor=ctx.db.query("supportThreads").withIndex("by_kind_updated",q=>q.eq("kind",args.kind)).order("desc");
  if(args.status) cursor=cursor.filter(q=>q.eq(q.field("status"),args.status));
  return cursor.paginate(args.paginationOpts);
}});
export const get = query({args:{threadId:v.id("supportThreads")},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");
  const thread=await ctx.db.get(args.threadId);
  if(!thread)return null;
  return {...thread,canManage:canManageSupportThread(thread,actor.clerkUserId,isDeveloper(actor))};
}});
export const messages = query({args:{threadId:v.id("supportThreads"),paginationOpts:paginationOptsValidator},handler:async(ctx,args)=>{
  await requireCapability(ctx,"support.view");
  const result=await ctx.db.query("supportMessages").withIndex("by_thread_created",q=>q.eq("threadId",args.threadId)).order("desc").paginate(args.paginationOpts);
  return {...result,page:await Promise.all(result.page.map(async message=>{
    const deliveries=await ctx.db.query("supportDeliveries").withIndex("by_message",q=>q.eq("messageId",message._id)).collect();
    const emailStatus={sent:0,pending:0,failed:0,cancelled:0};
    for(const delivery of deliveries){
      if(delivery.status==="sending"||delivery.status==="pending")emailStatus.pending++;
      else emailStatus[delivery.status]++;
    }
    return {...message,emailStatus,attachments:await Promise.all(message.attachmentIds.map(async id=>{
      const file=await ctx.db.get(id);return file?{_id:file._id,name:file.name,size:file.size,contentType:file.contentType}:null;
    }))};
  }))};
}});
export const create = mutation({args:{kind:v.union(v.literal("report"),v.literal("announcement")),title:v.string(),severity,announcementType:v.optional(announcementType),body:v.string(),attachmentIds:v.array(v.id("supportAttachments")),requestId:v.string()},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,args.kind==="announcement"?"support.develop":"support.view");
  const existing=await existingRequest(ctx,actor.clerkUserId,args.requestId);
  if(existing) {
    const thread=await ctx.db.get(existing.threadId);
    if (!thread || thread.title!==supportText(args.title,160) || thread.kind!==args.kind ||
        existing.body!==supportText(args.body,8000,args.attachmentIds.length===0) ||
        JSON.stringify(existing.attachmentIds)!==JSON.stringify(args.attachmentIds)) {
      throw new ConvexError("This send request was already used for different content. Reopen the composer.");
    }
    return existing.threadId;
  }
  const title=supportText(args.title,160);
  if(args.kind==="announcement"&&!args.announcementType)throw new ConvexError("Choose an update category.");
  const createdAt=now();
  const threadId=await ctx.db.insert("supportThreads",{kind:args.kind,title,severity:args.kind==="report"?args.severity:"low",status:"open",announcementType:args.kind==="announcement"?args.announcementType:undefined,createdBy:actor.clerkUserId,authorName:actor.displayName,createdAt,updatedAt:createdAt,revision:0});
  await saveMessage(ctx,actor,(await ctx.db.get(threadId))!,args.body,args.attachmentIds,args.requestId,false,createdAt,args.kind==="announcement");
  return threadId;
}});
export const reply = mutation({args:{threadId:v.id("supportThreads"),body:v.string(),attachmentIds:v.array(v.id("supportAttachments")),requestId:v.string()},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");
  const existing=await existingRequest(ctx,actor.clerkUserId,args.requestId);
  if(existing){
    if(existing.threadId!==args.threadId || existing.system || existing.body!==supportText(args.body,8000,args.attachmentIds.length===0) || JSON.stringify(existing.attachmentIds)!==JSON.stringify(args.attachmentIds))throw new ConvexError("This request was already used for a different message.");
    return existing._id;
  }
  const thread=await ctx.db.get(args.threadId);
  if(!thread)throw new ConvexError("Conversation not found.");
  const messageId=await saveMessage(ctx,actor,thread,args.body,args.attachmentIds,args.requestId);
  // Replying reopens a solved report, keeping follow-up problems visible.
  await ctx.db.patch(thread._id,{status:"open",updatedAt:now(),revision:thread.revision+1});
  return messageId;
}});
export const update = mutation({args:{threadId:v.id("supportThreads"),expectedRevision:v.number(),status:v.union(v.literal("open"),v.literal("solved")),severity,requestId:v.string()},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");
  const existing = await existingRequest(ctx,actor.clerkUserId,args.requestId);
  if(existing){if(existing.threadId!==args.threadId||!existing.system)throw new ConvexError("Request already used.");return;}
  const thread=await ctx.db.get(args.threadId);
  if(!thread||!canManageSupportThread(thread,actor.clerkUserId,isDeveloper(actor)))throw new ConvexError("Only the reporter or a developer can change this conversation.");
  if(thread.revision!==args.expectedRevision)throw new ConvexError("This conversation changed. Review its latest status and try again.");
  if(thread.status===args.status&&thread.severity===args.severity)return;
  const body=`Status: ${thread.status} → ${args.status}. Severity: ${thread.severity} → ${args.severity}.`;
  await saveMessage(ctx,actor,thread,body,[],args.requestId,true);
  await ctx.db.patch(thread._id,{status:args.status,severity:args.severity,updatedAt:now(),revision:thread.revision+1});
}});
export const uploadViewer = internalQuery({args:{},handler:async(ctx)=>{
  const actor=await requireCapability(ctx,"support.view");return {subject:actor.clerkUserId};
}});
export const registerAttachment = internalMutation({args:{storageId:v.id("_storage"),name:v.string(),contentType:v.string(),size:v.number()},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");
  if(!SUPPORT_IMAGE_TYPES.includes(args.contentType as typeof SUPPORT_IMAGE_TYPES[number]) || args.size<1 || args.size>MAX_SUPPORT_IMAGE_BYTES)throw new ConvexError("Unsupported or oversized picture.");
  const drafts=(await ctx.db.query("supportAttachments").withIndex("by_owner_message",q=>q.eq("owner",actor.clerkUserId).eq("messageId",undefined).gt("expiresAt",now())).take(20));
  if(drafts.length>=20)throw new ConvexError("Too many unsent pictures. Remove unused attachments before uploading more.");
  const id=await ctx.db.insert("supportAttachments",{...args,name:supportAttachmentName(args.name),owner:actor.clerkUserId,createdAt:now(),expiresAt:now()+24*60*60_000});
  await ctx.scheduler.runAfter(24*60*60_000,internal.support.cleanAttachment,{attachmentId:id});return id;
}});
export const attachmentStorage = internalQuery({args:{attachmentId:v.id("supportAttachments")},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");const file=await ctx.db.get(args.attachmentId);
  if(!file||(!file.messageId&&(file.owner!==actor.clerkUserId||file.expiresAt<=now())))throw new ConvexError("Picture not available.");
  return {storageId:file.storageId,contentType:file.contentType};
}});
export const discardAttachment = mutation({args:{attachmentId:v.id("supportAttachments")},handler:async(ctx,args)=>{
  const actor=await requireCapability(ctx,"support.view");const file=await ctx.db.get(args.attachmentId);
  if(!file)return;if(file.owner!==actor.clerkUserId||file.messageId)throw new ConvexError("Only your unsent attachments can be removed.");
  await ctx.storage.delete(file.storageId);await ctx.db.delete(file._id);
}});
export const cleanAttachment = internalMutation({args:{attachmentId:v.id("supportAttachments")},handler:async(ctx,args)=>{
  const file=await ctx.db.get(args.attachmentId);if(!file||file.messageId)return;
  if(file.expiresAt>now()){await ctx.scheduler.runAfter(file.expiresAt-now(),internal.support.cleanAttachment,args);return;}
  await ctx.storage.delete(file.storageId);await ctx.db.delete(file._id);
}});

export const configuration = query({args:{},handler:async ctx=>{
  await requireCapability(ctx,"support.view");
  return {hasRecipients:(await ctx.db.query("techSupportEmails").withIndex("by_active",q=>q.eq("active",true)).take(1)).length>0};
}});

const DELIVERY_LEASE_MS = 31 * 60_000;
const DELIVERY_ATTEMPTS = 5;
export const claimDelivery = internalMutation({
  args:{deliveryId:v.id("supportDeliveries"),token:v.string()},
  handler:async(ctx,args):Promise<{email:string;thread:Doc<"supportThreads">;message:Doc<"supportMessages">}|null>=>{
    const delivery=await ctx.db.get(args.deliveryId);
    if(!delivery||["sent","failed","cancelled"].includes(delivery.status)||(delivery.leaseExpiresAt??0)>now())return null;
    const message=await ctx.db.get(delivery.messageId);
    const thread=message?await ctx.db.get(message.threadId):null;
    let allowed=false;
    if(delivery.recipientKind==="technical"){
      allowed=(await ctx.db.query("techSupportEmails").withIndex("by_email",q=>q.eq("email",delivery.email)).unique())?.active===true;
    } else if(delivery.recipientSubject){
      const user=await userBySubject(ctx,delivery.recipientSubject);
      allowed=Boolean(user&&user.email===delivery.email&&effectiveCapabilities(user).includes("support.view")&&user.role!=="tech_support");
    }
    if(!allowed||!message||!thread){await ctx.db.patch(delivery._id,{status:"cancelled",updatedAt:now()});return null;}
    if(delivery.attempts>=DELIVERY_ATTEMPTS){await ctx.db.patch(delivery._id,{status:"failed",updatedAt:now()});return null;}
    await ctx.db.patch(delivery._id,{status:"sending",attempts:delivery.attempts+1,token:args.token,leaseExpiresAt:now()+DELIVERY_LEASE_MS,updatedAt:now()});
    await ctx.scheduler.runAfter(DELIVERY_LEASE_MS,internal.support.recoverDelivery,args);
    return {email:delivery.email,message,thread};
  },
});
export const finishDelivery=internalMutation({args:{deliveryId:v.id("supportDeliveries"),token:v.string(),error:v.optional(v.string())},handler:async(ctx,args)=>{
  const delivery=await ctx.db.get(args.deliveryId);if(!delivery||delivery.token!==args.token)return;
  const retry=Boolean(args.error)&&delivery.attempts<DELIVERY_ATTEMPTS;
  await ctx.db.patch(delivery._id,{status:args.error?(retry?"pending":"failed"):"sent",error:args.error?"Email delivery failed. Check Gmail configuration and retry.":undefined,token:undefined,leaseExpiresAt:undefined,updatedAt:now()});
  if(retry)await ctx.scheduler.runAfter(60_000*2**(delivery.attempts-1),internal.emailNotifications.sendSupportMessage,{deliveryId:delivery._id});
}});
export const recoverDelivery=internalMutation({args:{deliveryId:v.id("supportDeliveries"),token:v.string()},handler:async(ctx,args)=>{
  const delivery=await ctx.db.get(args.deliveryId);if(!delivery||delivery.token!==args.token)return;
  if((delivery.leaseExpiresAt??0)>now()){await ctx.scheduler.runAfter(delivery.leaseExpiresAt!-now()+1000,internal.support.recoverDelivery,args);return;}
  const retry=delivery.attempts<DELIVERY_ATTEMPTS;
  await ctx.db.patch(delivery._id,{status:retry?"pending":"failed",token:undefined,leaseExpiresAt:undefined,error:"Worker timed out; email may have been accepted.",updatedAt:now()});
  if(retry)await ctx.scheduler.runAfter(0,internal.emailNotifications.sendSupportMessage,{deliveryId:delivery._id});
}});
export const retryNotifications=mutation({args:{messageId:v.id("supportMessages")},handler:async(ctx,args)=>{
  await requireCapability(ctx,"support.develop");
  const deliveries=await ctx.db.query("supportDeliveries").withIndex("by_message",q=>q.eq("messageId",args.messageId)).collect();
  for(const delivery of deliveries.filter(row=>row.status==="failed")){
    await ctx.db.patch(delivery._id,{status:"pending",attempts:0,error:undefined,token:undefined,leaseExpiresAt:undefined,updatedAt:now()});
    await ctx.scheduler.runAfter(0,internal.emailNotifications.sendSupportMessage,{deliveryId:delivery._id});
  }
}});
