"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { formatDateTime } from "@/lib/ui";
import type { requestMeetings } from "@/convex/lib/requesterRules";
function RequestCard({ request }: { request: Doc<"bookingRequests"> }) {
  const resolve = useMutation(api.bookingRequests.resolve);
  const [response,setResponse] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const meetings = JSON.parse(request.snapshot) as ReturnType<typeof requestMeetings>;
  async function finish(outcome: "completed" | "declined") {
    setBusy(true); setError("");
    try { await resolve({ requestId: request._id, outcome, response }); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to review request."); }
    finally { setBusy(false); }
  }
  return <article className="panel requester-form">
    <h2>{request.kind === "cancel" ? "Cancellation" : "Change request"}: {meetings[0]?.title}</h2>
    <p>{request.requesterName} · {request.requesterEmail}<br/>{request.scope === "following" ? "This event and following events" : "This event only"}</p>
    <p style={{whiteSpace:"pre-wrap"}}>{request.message}</p>
    <details><summary>{meetings.length} requested meeting{meetings.length === 1 ? "" : "s"}</summary><ul>{meetings.map(row => <li key={row.sequence}>{row.title} · {row.room}<br/>{formatDateTime(row.startAt, request.timezone)} – {formatDateTime(row.endAt,request.timezone)}</li>)}</ul></details>
    {request.status === "pending" ? <>
      <p>Apply the requested scope through the booking’s existing edit/delete controls. Wait for Google Calendar to sync, then record the outcome here.</p>
      <Link className="button button-secondary" href={`/bookings?booking=${encodeURIComponent(String(request.bookingId))}`}>Open booking</Link>
      <label>Response to requestor<textarea rows={3} maxLength={4000} value={response} onChange={e=>setResponse(e.target.value)}/></label>
      <div className="my-bookings-controls"><button className="button" disabled={busy || !response.trim()} onClick={()=>void finish("completed")}>Mark completed</button><button className="button button-secondary" disabled={busy || !response.trim()} onClick={()=>void finish("declined")}>Decline request</button></div>
      {error && <p role="alert">{error}</p>}
    </> : <p>{request.status}: {request.response}</p>}
  </article>;
}
export default function BookingRequestsPage() {
  const [status,setStatus] = useState<"pending" | "completed" | "declined">("pending");
  const results = usePaginatedQuery(api.bookingRequests.list,{status},{initialNumItems:20});
  return <main className="page"><h1>Booking requests</h1><label>Status <select value={status} onChange={e=>setStatus(e.target.value as typeof status)}><option value="pending">Awaiting review</option><option value="completed">Completed</option><option value="declined">Declined</option></select></label>
    {results.status === "LoadingFirstPage" ? <p role="status">Loading requests…</p> : !results.results.length ? <p>No requests.</p> : results.results.map(row=><RequestCard key={row._id} request={row}/>)}
    {results.status === "CanLoadMore" && <button className="button button-secondary" onClick={()=>results.loadMore(20)}>Load more</button>}
  </main>;
}
