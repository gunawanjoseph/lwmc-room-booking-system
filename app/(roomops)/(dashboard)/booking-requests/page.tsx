"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatDateTime, messageFromError } from "@/lib/ui";
import { exitOverlay, fromKeyboard } from "@/lib/motion";
import { BookingChangeComparison, requestStatusLabel, type MeetingSummary, type ProposedEdit } from "@/components/booking-change-comparison";
import { Search } from "lucide-react";
import { recurrenceLabel, recurrenceDescription } from "@/shared/requestFields";
import { StatusBadge } from "@/components/status-badge";
type Request = FunctionReturnType<typeof api.bookingRequests.list>["page"][number];
function RequestCard({ request }: { request: Request }) {
  const resolve = useMutation(api.bookingRequests.resolve);
  const retry = useMutation(api.bookingRequests.retry);
  const [response, setResponse] = useState("");
  const [notice, setNotice] = useState("");
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const meetings = JSON.parse(request.snapshot) as MeetingSummary[];
  const proposal = request.proposal ? JSON.parse(request.proposal) as ProposedEdit : null;
  async function finish(outcome: "completed" | "declined" | "retry") {
    if (busy) return; setBusy(true); setError("");
    try {
      if (outcome === "retry") await retry({ requestId: request._id, expectedRequestRevision: request.requestRevision });
      else {
        const result = await resolve({ requestId: request._id, expectedRequestRevision: request.requestRevision, outcome, response });
        setNotice(result?.message ?? (outcome === "declined" ? "Request rejected. The requester will receive your response." : "Approval is processing. Calendar synchronization must finish before the change is complete."));
      }
      setFinished(true);
    } catch (err) { setError(messageFromError(err)); }
    finally { setBusy(false); }
  }
  return <article className="panel requester-form">
    <div className="request-history-heading"><StatusBadge status={request.status === "completed" ? "approved" : request.status === "declined" || request.status === "failed" ? "unavailable" : "pending"} label={requestStatusLabel(request.status,request.kind)}/><time>{formatDateTime(request.createdAt, request.timezone)}</time></div>
    <h2>{meetings[0]?.title ?? "Booking request"}</h2>
    <p>{request.requesterName} · {request.requesterEmail}</p>
    {proposal && meetings[0] ? <BookingChangeComparison before={meetings[0]} after={proposal} timezone={request.timezone}/> : <p>{request.message || "Cancellation"}</p>}
    {request.scope === "following" && proposal && meetings[0] && <p className="request-notice"><strong>{recurrenceLabel(request.recurrenceFrequency)} frequency stays unchanged.</strong><br/>Current: {recurrenceDescription(meetings[0].startAt,request.recurrenceFrequency,request.timezone)} · {formatDateTime(meetings[0].startAt, request.timezone)}<br/>Requested: {recurrenceDescription(proposal.startAt,request.recurrenceFrequency,request.timezone)} · {formatDateTime(proposal.startAt, request.timezone)}<br/>The remaining {meetings.length} meetings follow the new start day.</p>}
    <details><summary>{request.scope === "following" ? "This event and following events" : "This event only"} · {meetings.length} meeting{meetings.length === 1 ? "" : "s"}</summary><ul>{meetings.map(row => <li key={row.sequence}>{row.title} · {row.room}<br/>{formatDateTime(row.startAt, request.timezone)} – {formatDateTime(row.endAt, request.timezone)}</li>)}</ul></details>
    {proposal && request.message && <p className="request-description">{request.message}</p>}
    {request.status === "pending" && !finished ? <>
      {!proposal && <p>This older request has no structured changes. Ask the requester to submit it again using their management link.</p>}
      <label>Reason / comment (optional)<textarea rows={2} maxLength={4000} value={response} onChange={e => setResponse(e.target.value)}/></label>
      <div className="request-actions"><button className="button" disabled={busy || finished || !proposal || request.kind !== "change"} onClick={() => void finish("completed")}>{busy ? "Processing…" : "Approve changes"}</button><button className="button button-secondary" disabled={busy} onClick={() => void finish("declined")}>Reject</button></div>
    </> : <>{request.response && <p>{request.response}</p>}{request.status === "failed" && <button className="button" disabled={busy} onClick={() => void finish("retry")}>Retry synchronization</button>}</>}
    {notice && <p className="request-notice" role="status">{notice}</p>}
    {error && <p className="request-error" role="alert">{error}</p>}
  </article>;
}
export default function BookingRequestsPage() {
  const [status, setStatus] = useState<"all" | "pending" | "checking" | "applying" | "completed" | "declined" | "failed">("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Request | null>(null);
  const results = usePaginatedQuery(api.bookingRequests.list, { status }, { initialNumItems: 20 });
  // Search continues through all pages, including historical requests.
  useEffect(() => { if (search.trim() && results.status === "CanLoadMore") results.loadMore(50); }, [search, results.status, results.loadMore]);
  const term = search.trim().toLocaleLowerCase();
  const rows = results.results.filter(row => [row.requesterName,row.requesterEmail,row.snapshot,row.proposal,row.message,row.status,requestStatusLabel(row.status,row.kind)].join(" ").toLocaleLowerCase().includes(term));
  return <main className="page edit-requests-page"><header className="page-header"><div><span className="eyebrow">BOOKING OPERATIONS</span><h1>Edit Requests</h1><p>Review changes and track requester cancellations.</p></div></header>
    <section className="panel edit-request-filters" aria-label="Filter edit requests"><label className="edit-request-search"><Search size={20} aria-hidden="true"/><input aria-label="Search edit requests" placeholder="Search requester, ministry, room or booking" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Request status" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">All statuses</option><option value="pending">Awaiting approval</option><option value="checking">Checking availability</option><option value="applying">Synchronizing</option><option value="completed">Completed</option><option value="declined">Not approved</option><option value="failed">Needs attention</option></select></section>
    <section className="panel edit-request-list" aria-busy={results.status === "LoadingFirstPage" || results.status === "LoadingMore"}>
      {results.status === "LoadingFirstPage" ? <p role="status">Loading requests…</p> : rows.map(row => { const meeting = (JSON.parse(row.snapshot) as MeetingSummary[])[0]; return <article className="edit-request-row" key={row._id}><div><strong>{row.requesterName}</strong><small>{row.requesterEmail}</small><small>{formatDateTime(row.createdAt,row.timezone)}</small></div><div><strong>{meeting?.title ?? "Booking"}</strong><small>{meeting?.room} · {meeting?.ministry}</small><small>{meeting && formatDateTime(meeting.startAt,row.timezone)}</small></div><div><StatusBadge status={row.status === "completed" ? "approved" : row.status === "declined" || row.status === "failed" ? "unavailable" : "pending"} label={requestStatusLabel(row.status,row.kind)}/></div><button className="button button-secondary" onClick={() => setSelected(row)}>Review</button></article>; })}
      {!rows.length && results.status === "Exhausted" && <p>No requests match these filters.</p>}
      {search && results.status !== "Exhausted" && results.status !== "LoadingFirstPage" && <p role="status">Searching requests…</p>}
    </section>
    {results.status === "CanLoadMore" && !search && <button className="button button-secondary" onClick={() => results.loadMore(20)}>Load more</button>}
    {selected && <RequestReview request={selected} close={() => setSelected(null)}/>}
  </main>;
}
function RequestReview({request,close}:{request:Request;close:()=>void}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  return <dialog open className="request-review-dialog" ref={node => { dialog.current = node; if (node && !node.matches(":modal")) { node.close(); node.showModal(); } }} onCancel={close} aria-label="Review booking request"><button className="button button-secondary" onClick={event => fromKeyboard(event) ? close() : exitOverlay(dialog.current, close)}>Close</button><RequestCard request={request}/></dialog>;
}
