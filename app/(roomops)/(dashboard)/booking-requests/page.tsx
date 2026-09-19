"use client";
import { useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { formatDateTime, messageFromError } from "@/lib/ui";
import { BookingChangeComparison, requestStatusLabel, type MeetingSummary, type ProposedEdit } from "@/components/booking-change-comparison";
type Request = FunctionReturnType<typeof api.bookingRequests.list>["page"][number];
function RequestCard({ request }: { request: Request }) {
  const resolve = useMutation(api.bookingRequests.resolve);
  const retry = useMutation(api.bookingRequests.retry);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const meetings = JSON.parse(request.snapshot) as MeetingSummary[];
  const proposal = request.proposal ? JSON.parse(request.proposal) as ProposedEdit : null;
  async function finish(outcome: "completed" | "declined" | "retry") {
    if (busy) return; setBusy(true); setError("");
    try {
      if (outcome === "retry") await retry({ requestId: request._id });
      else await resolve({ requestId: request._id, outcome, response });
    } catch (err) { setError(messageFromError(err)); }
    finally { setBusy(false); }
  }
  return <article className="panel requester-form">
    <div className="request-history-heading"><span className="request-status">{requestStatusLabel(request.status, request.kind)}</span><time>{formatDateTime(request.createdAt, request.timezone)}</time></div>
    <h2>{meetings[0]?.title ?? "Booking request"}</h2>
    <p>{request.requesterName} · {request.requesterEmail}</p>
    {proposal && meetings[0] ? <BookingChangeComparison before={meetings[0]} after={proposal} timezone={request.timezone}/> : <p>{request.message || "Cancellation"}</p>}
    <details><summary>{request.scope === "following" ? "This event and following events" : "This event only"} · {meetings.length} meeting{meetings.length === 1 ? "" : "s"}</summary><ul>{meetings.map(row => <li key={row.sequence}>{row.title} · {row.room}<br/>{formatDateTime(row.startAt, request.timezone)} – {formatDateTime(row.endAt, request.timezone)}</li>)}</ul></details>
    {proposal && request.message && <p className="request-description">{request.message}</p>}
    {request.status === "pending" ? <>
      {!proposal && <p>This older request has no structured changes. Ask the requester to submit it again using their management link.</p>}
      <label>Response (optional)<textarea rows={2} maxLength={4000} value={response} onChange={e => setResponse(e.target.value)}/></label>
      <div className="request-actions"><button className="button" disabled={busy || !proposal || request.kind !== "change"} onClick={() => void finish("completed")}>{busy ? "Processing…" : "Approve changes"}</button><button className="button button-secondary" disabled={busy} onClick={() => void finish("declined")}>Reject</button></div>
    </> : <>{request.response && <p>{request.response}</p>}{request.status === "failed" && <button className="button" disabled={busy} onClick={() => void finish("retry")}>Retry synchronization</button>}</>}
    {error && <p className="request-error" role="alert">{error}</p>}
  </article>;
}
export default function BookingRequestsPage() {
  const [status, setStatus] = useState<"pending" | "checking" | "applying" | "completed" | "declined" | "failed">("pending");
  const results = usePaginatedQuery(api.bookingRequests.list, { status }, { initialNumItems: 20 });
  return <main className="page edit-requests-page"><header className="page-header"><div><h1>Edit Requests</h1><p>Review changes and track requester cancellations.</p></div><label>Status<select value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="pending">Awaiting approval</option><option value="checking">Checking availability</option><option value="applying">Synchronizing</option><option value="completed">Completed</option><option value="declined">Not approved</option><option value="failed">Needs attention</option></select></label></header>
    {results.status === "LoadingFirstPage" ? <p role="status">Loading requests…</p> : !results.results.length ? <div className="panel requester-form"><p>No requests here.</p></div> : results.results.map(row => <RequestCard key={row._id} request={row}/>)}
    {results.status === "CanLoadMore" && <button className="button button-secondary" onClick={() => results.loadMore(20)}>Load more</button>}
  </main>;
}
