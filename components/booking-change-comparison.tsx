import { formatDateTime } from "@/lib/ui";
import type { requestMeetings } from "@/convex/lib/requesterRules";
export type MeetingSummary = ReturnType<typeof requestMeetings>[number];
export type ProposedEdit = { room: string; startAt: number; endAt: number; eventName: string; purpose: string; ministry: string; responses?: Array<{ qid: string; value: string }> };
export function BookingChangeComparison({ before, after, timezone }: { before: MeetingSummary; after: ProposedEdit; timezone: string }) {
  const fields = [
    ["Event", before.title, after.eventName], ["Room", before.room, after.room],
    ["Starts", formatDateTime(before.startAt, timezone), formatDateTime(after.startAt, timezone)],
    ["Ends", formatDateTime(before.endAt, timezone), formatDateTime(after.endAt, timezone)],
    ["Ministry", before.ministry || "—", after.ministry || "—"], ["Purpose", before.purpose || "—", after.purpose || "—"],
    ...(before.fields ?? []).filter(field => !/duration/i.test(field.label)).map(field => [field.label, field.value || "—", (after.responses?.find(row => row.qid === field.qid)?.value ?? field.value) || "—"]),
  ];
  return <dl className="request-comparison">{fields.map(([label, old, next]) => <div key={label} className={old !== next ? "is-changed" : ""}>
    <dt>{label}{old !== next && <span className="request-changed-label">Changed</span>}</dt>
    <dd>{old !== next ? <><span className="request-before"><span className="sr-only">Current: </span>{old}</span><span><span className="sr-only">Requested: </span>{next}</span></> : <span>{next}</span>}</dd>
  </div>)}</dl>;
}
export function requestStatusLabel(status: string, kind: string) {
  return ({ checking: "Checking availability", pending: "Awaiting approval", applying: kind === "cancel" ? "Cancelling" : "Updating Calendar", completed: kind === "cancel" ? "Cancelled" : "Changes approved", declined: "Not approved", failed: "Needs attention" } as Record<string, string>)[status] ?? status;
}
