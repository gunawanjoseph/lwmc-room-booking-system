import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditLog } from "./auditLog";
import { internal } from "../_generated/api";
import { adminReservationProposal, updateCanonicalResponseValues } from "../bookings";
import { requestMeetings, requestScope, checkRequestWindow, editableRequestFields } from "./requesterRules";
import { normalizeRoomKey } from "./bookingRules";
import { filterMeetings, sortMeetings, submitterMeetings } from "./submitterBookings";

export type RequestEdit = { room: string; startAt: number; endAt: number; eventName: string; purpose: string; ministry: string; responses?: Array<{ qid: string; value: string }> };
export const requestVersion = (booking: Doc<"bookings">) => JSON.stringify({ revision: booking.revision ?? 0, meetings: requestMeetings(booking) });
export function requestCandidate(booking: Doc<"bookings">, sequence: number, scope: "occurrence" | "following", edit?: RequestEdit) {
  const selected = requestScope(booking, sequence, scope);
  checkRequestWindow(selected, Date.now());
  if (!edit) {
    const ids = new Set(selected.map(item => item.sequence));
    const occurrences = (booking.occurrences ?? [{ sequence: 0, startAt: booking.startAt, endAt: booking.endAt }]).filter(item => !ids.has(item.sequence));
    return canonicalCandidate({ ...booking, occurrences, recurrenceCount: occurrences.length,
      recurrenceHasEndDate: scope === "following" ? true : booking.recurrenceHasEndDate,
      recurrenceUntilAt: scope === "following" ? occurrences.at(-1)?.startAt : booking.recurrenceUntilAt,
      startAt: occurrences[0]?.startAt ?? booking.startAt, endAt: occurrences[0]?.endAt ?? booking.endAt });
  }
  if (!edit.eventName.trim() || edit.eventName.length > 300 || edit.purpose.length > 2000 || edit.ministry.length > 160) throw Error("Enter a title and keep the details within the field limits.");
  const proposal = adminReservationProposal(booking, {
    ...edit, requesterName: booking.requesterName, requesterEmail: booking.requesterEmail,
    editScope: scope, occurrenceSequence: sequence,
    recurrenceFrequency: booking.recurrenceFrequency ?? "none", recurrenceHasEndDate: booking.recurrenceHasEndDate ?? false,
    recurrenceUntilAt: booking.recurrenceUntilAt,
  });
  const fields = editableRequestFields(booking);
  if ((edit.responses?.length ?? 0) > 40 || new Set(edit.responses?.map(row => row.qid)).size !== (edit.responses?.length ?? 0)) throw Error("Too many or repeated additional fields.");
  for (const answer of edit.responses ?? []) {
    const field = fields.find(row => row.qid === answer.qid);
    if (!field || answer.value.length > 4000) throw Error("An additional booking field is invalid. Refresh and try again.");
    if (field.type === "control_number" && answer.value && !Number.isFinite(Number(answer.value))) throw Error(`Enter a valid number for ${field.label}.`);
    if (field.type === "control_email" && answer.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer.value)) throw Error(`Enter a valid email for ${field.label}.`);
  }
  const affected = new Set(selected.map(row => row.sequence));
  if (edit.responses) proposal.occurrences = proposal.occurrences.map(row => affected.has(row.sequence) ? { ...row, details: { ...row.details, responses: edit.responses!.map(answer => ({ qid: answer.qid, value: answer.value.trim() })) } } : row);
  const candidate = canonicalCandidate({ ...booking, ...proposal, recurrenceCount: proposal.occurrences.length });
  const selectedIds = new Set(selected.map(item => item.sequence));
  checkRequestWindow(requestMeetings(candidate).filter(item => selectedIds.has(item.sequence)), Date.now());
  if (JSON.stringify(requestMeetings(candidate)) === JSON.stringify(requestMeetings(booking))) throw Error("Change at least one booking detail before submitting.");
  return candidate;
}

function canonicalCandidate(candidate: Doc<"bookings">): Doc<"bookings"> {
  const single = candidate.occurrences?.length === 1 ? candidate.occurrences[0] : undefined;
  if (single) {
    candidate = { ...candidate, room: single.room ?? candidate.room, roomKey: normalizeRoomKey(single.room ?? candidate.room),
      resolvedVenues: single.resolvedVenues ?? candidate.resolvedVenues,
      eventName: single.details?.eventName ?? candidate.eventName, purpose: single.details?.purpose ?? candidate.purpose,
      ministry: single.details?.ministry ?? candidate.ministry,
      formResponses: candidate.formResponses?.map(field => {
        const override = single.details?.responses?.find(row => row.qid === field.qid);
        return override ? { ...field, value: override.value } : field;
      }) };
  }
  return { ...candidate, formResponses: updateCanonicalResponseValues(candidate.formResponses, {
    requesterName: candidate.requesterName, requesterEmail: candidate.requesterEmail,
    eventName: candidate.eventName, purpose: candidate.purpose, ministry: candidate.ministry,
    recurrence: { frequency: candidate.recurrenceFrequency ?? "none", hasEndDate: candidate.recurrenceHasEndDate ?? false,
      count: candidate.occurrences?.length ?? 1, untilAt: candidate.recurrenceUntilAt, timezone: candidate.timezone },
  }) };
}

export async function outstandingSnapshot(ctx: MutationCtx, email: string) {
  const capturedAt = Date.now();
  const timezone = process.env.BOOKING_TIME_ZONE || "Asia/Singapore";
  const owned = await ctx.db.query("bookings").withIndex("by_requester_email", q => q.eq("requesterEmail", email.trim().toLowerCase())).collect();
  return JSON.stringify({ capturedAt, timezone, rows: sortMeetings(filterMeetings(owned.flatMap(submitterMeetings), "outstanding", capturedAt, timezone), "booking", "asc") });
}

// Uses the existing leased/retrying booking-notice outbox. Each lifecycle transition
// and its notifications are committed together; retries cannot enqueue duplicates.
export async function requestNotices(ctx: MutationCtx, request: Doc<"bookingRequests">, stage: "pending" | "unavailable" | "completed" | "declined") {
  const before = JSON.parse(request.original!) as Doc<"bookings">;
  const candidate = JSON.parse(request.candidate!) as Doc<"bookings">;
  const selected = new Set((JSON.parse(request.snapshot) as ReturnType<typeof requestMeetings>).map(item => item.sequence));
  const pick = (booking: Doc<"bookings">) => submitterMeetings(booking).filter(row => selected.has(Number(row.key.split(":").at(-1))));
  const cancellation = request.kind === "cancel";
  const subject = stage === "pending" ? "Booking Change Request Received" : stage === "unavailable" ? "Booking Change Request Unavailable" : stage === "declined" ? "Booking Changes Not Approved" : cancellation ? "Booking Cancellation Confirmation" : "Booking Changes Approved";
  const text = stage === "pending" ? "Your changes are awaiting approval. Your original booking remains unchanged." : stage === "completed" ? cancellation ? "The selected meetings have been cancelled and their Calendar events removed." : "Your booking and Google Calendar have been updated." : "Your original booking remains unchanged.";
  const originalMeeting = requestMeetings(before).find(row => row.sequence === request.sequence)!;
  const newMeeting = requestMeetings(candidate).find(row => row.sequence === request.sequence);
  const time = (value: number) => new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: request.timezone }).format(value);
  const differences = newMeeting ? [
    ["Title", originalMeeting.title, newMeeting.title], ["Room", originalMeeting.room, newMeeting.room],
    ["Starts", time(originalMeeting.startAt), time(newMeeting.startAt)], ["Ends", time(originalMeeting.endAt), time(newMeeting.endAt)],
    ["Ministry", originalMeeting.ministry, newMeeting.ministry], ["Purpose", originalMeeting.purpose, newMeeting.purpose],
    ...originalMeeting.fields.map(field => [field.label, field.value, newMeeting.fields.find(row => row.qid === field.qid)?.value ?? field.value]),
  ].filter(([, oldValue, newValue]) => oldValue !== newValue).map(([label, oldValue, newValue]) => `${label}: ${oldValue || "(empty)"} → ${newValue || "(empty)"}`).join("\n") : "";
  const outstandingJson = await outstandingSnapshot(ctx, request.requesterEmail);
  const recipients = [{ email: request.requesterEmail, admin: false }];
  if (stage === "pending" || stage === "completed" || (stage === "unavailable" && request.resolvedBy)) {
    const approvers = await ctx.db.query("approverEmails").withIndex("by_active", q => q.eq("active", true)).collect();
    if (!approvers.length && stage === "pending") await writeAuditLog(ctx, { level: "error", category: "system", action: "request_approvers_missing", actorType: "system", message: "An edit request is pending but no approver notification emails are configured.", createdAt: Date.now() });
    recipients.push(...[...new Set(approvers.map(row => row.email.trim().toLowerCase()))].map(email => ({ email, admin: true })));
  }
  for (const recipient of recipients) {
    const noticeId = await ctx.db.insert("bookingNotices", {
      bookingReference: before.jotformSubmissionId, recipientEmail: recipient.email,
      kind: cancellation ? "deleted" : "edited", scope: request.scope,
      beforeJson: JSON.stringify(pick(before).map(row => cancellation && stage === "completed" ? { ...row, status: "cancelled" } : row)), afterJson: JSON.stringify(cancellation ? [] : pick(candidate)),
      detailChanges: `Requester: ${request.requesterName}\nScope: ${request.scope === "following" ? "This event and following events" : "This event only"}\n${differences}\n${request.message}\n${request.response ?? ""}`,
      outstandingJson, calendarPending: false, requestSubject: recipient.admin && stage === "pending" ? "Booking Change Request Requires Approval" : subject,
      requestText: text, approverNotice: recipient.admin, status: "pending", attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.emailNotifications.sendBookingNotice, { noticeId });
  }
}
