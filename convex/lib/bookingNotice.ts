import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { filterMeetings, sortMeetings, submitterMeetings } from "./submitterBookings";
import { scopedSequences } from "./recurrenceScope";
export async function queueBookingNotice(ctx: MutationCtx, before: Doc<"bookings">, after: Doc<"bookings"> | null, kind: "edited"|"deleted", scope: "series"|"occurrence"|"following" = "series", sequence?:number) {
  const selected=scopedSequences(before.occurrences??[{sequence:0,startAt:before.startAt,endAt:before.endAt}],scope,sequence);
  const beforeRows=submitterMeetings(before).filter(row=>selected.has(Number(row.key.split(":").at(-1))));
  const afterRows=after?submitterMeetings(after).filter(row=>scope==="series"||selected.has(Number(row.key.split(":").at(-1)))):[];
  const changes: string[]=[];
  if (after) {
    for (const field of ["requesterName","requesterEmail","eventName","purpose","ministry"] as const) {
      if(before[field]!==after[field]) changes.push(`${field}: ${before[field]??"(empty)"} → ${after[field]??"(empty)"}`);
    }
    for (const occurrence of after.occurrences??[]) {
      if(!selected.has(occurrence.sequence)) continue;
      const previous=before.occurrences?.find(item=>item.sequence===occurrence.sequence);
      for (const field of ["eventName","purpose","ministry"] as const) {
        const oldValue=previous?.details?.[field]??before[field];
        const newValue=occurrence.details?.[field]??after[field];
        if(oldValue!==newValue)changes.push(`Meeting ${occurrence.sequence+1} ${field}: ${oldValue??"(empty)"} → ${newValue??"(empty)"}`);
      }
    }
    for(const response of after.formResponses??[]) {
      if(response.canonicalField)continue;
      const oldValue=before.formResponses?.find(item=>item.qid===response.qid)?.value;
      if(oldValue!==response.value)changes.push(`${response.label}: ${oldValue??"(empty)"} → ${response.value}`);
    }
  }
  // Read and persist the entire recipient view in the same transaction as the change.
  // Explicit replacement also handles full deletion, whose database delete follows this call.
  const capturedAt=Date.now();
  const timezone=process.env.BOOKING_TIME_ZONE||"Asia/Singapore";
  const recipientEmail=(after?.requesterEmail??before.requesterEmail).trim().toLowerCase();
  const owned=await ctx.db.query("bookings").withIndex("by_requester_email",q=>q.eq("requesterEmail",recipientEmail)).collect();
  const current=owned.filter(row=>row._id!==before._id);
  if(after)current.push(after);
  const outstandingJson=JSON.stringify({capturedAt,timezone,rows:sortMeetings(filterMeetings(current.flatMap(submitterMeetings),"outstanding",capturedAt,timezone),"booking","asc")});
  const noticeId=await ctx.db.insert("bookingNotices",{
    bookingReference:before.jotformSubmissionId,recipientEmail:(after?.requesterEmail??before.requesterEmail).trim().toLowerCase(),
    kind,scope,outstandingJson,detailChanges:changes.join("\n"),beforeJson:JSON.stringify(beforeRows),afterJson:JSON.stringify(afterRows),
    calendarPending:!!after && (after.calendarSyncStatus==="creating"||after.calendarSyncStatus==="failed"),
    status:"pending",attempts:0,createdAt:Date.now(),updatedAt:Date.now(),
  });
  await ctx.scheduler.runAfter(0,internal.emailNotifications.sendBookingNotice,{noticeId});
  return noticeId;
}
