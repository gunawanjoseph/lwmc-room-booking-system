import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { submitterMeetings } from "./submitterBookings";
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
  const noticeId=await ctx.db.insert("bookingNotices",{
    bookingReference:before.jotformSubmissionId,recipientEmail:(after?.requesterEmail??before.requesterEmail).trim().toLowerCase(),
    kind,scope,detailChanges:changes.join("\n"),beforeJson:JSON.stringify(beforeRows),afterJson:JSON.stringify(afterRows),
    calendarPending:!!after && (after.calendarSyncStatus==="creating"||after.calendarSyncStatus==="failed"),
    status:"pending",attempts:0,createdAt:Date.now(),updatedAt:Date.now(),
  });
  await ctx.scheduler.runAfter(0,internal.emailNotifications.sendBookingNotice,{noticeId});
  return noticeId;
}
