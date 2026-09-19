"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/ui";

export function RequestBooking() {
  const [token, setToken] = useState<string | null>(null);
  const [sequence, setSequence] = useState("");
  const [scope, setScope] = useState<"occurrence" | "following">("occurrence");
  const [kind, setKind] = useState<"change" | "cancel">("change");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const read = () => setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
    read(); window.addEventListener("hashchange", read);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); window.removeEventListener("hashchange", read); };
  }, []);
  const data = useQuery(api.bookingRequests.view, token ? { token } : "skip");
  const submit = useMutation(api.bookingRequests.submit);
  const selected = data?.meetings.find(row => String(row.sequence) === sequence);
  const affected = selected ? data!.meetings.filter(row => scope === "occurrence" ? row.sequence === selected.sequence : row.startAt >= selected.startAt) : [];
  const pending = data?.requests.some(row => row.status === "pending");
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!data || !token || !selected || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await submit({ token, sequence: selected.sequence, scope, kind, message, version: data.version });
      setNotice("Your request has been sent. Your booking stays unchanged until an administrator processes it.");
      setMessage("");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to submit. Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="page requester-page"><h1>Manage your booking</h1>
    {token === null || (token && data === undefined) ? <p role="status">Loading your booking…</p> : !token || !data ?
      <p>This link is unavailable. The booking may have been cancelled or its contact details changed. Please contact the booking administrator.</p> : <>
      <p>Request changes or cancellation at least two hours before the selected meeting starts. Times are shown in {data.timezone}.</p>
      <form className="panel requester-form" onSubmit={send}>
        <label>Meeting<select required value={sequence} onChange={e => { setSequence(e.target.value); setNotice(""); }}>
          <option value="">Choose a meeting</option>
          {data.meetings.map(row => <option key={row.sequence} value={row.sequence} disabled={now > row.deadline}>
            {formatDateTime(row.startAt, data.timezone)} · {row.title}{now > row.deadline ? " — requests closed" : ""}
          </option>)}
        </select></label>
        {selected && <p>{selected.title}<br/>{selected.room}<br/>{formatDateTime(selected.startAt,data.timezone)} – {formatDateTime(selected.endAt,data.timezone)}<br/>Request by {formatDateTime(selected.deadline,data.timezone)}</p>}
        <label>Apply to<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
          <option value="occurrence">This event only</option>
          {data.meetings.length > 1 && <option value="following">This event and following events</option>}
        </select></label>
        {affected.length > 1 && <details><summary>{affected.length} meetings included</summary><ul>{affected.map(row => <li key={row.sequence}>{formatDateTime(row.startAt,data.timezone)} · {row.title} · {row.room}</li>)}</ul></details>}
        <label>Request<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
          <option value="change">Change booking</option><option value="cancel">Cancel booking</option>
        </select></label>
        <label>{kind === "change" ? "What would you like to change?" : "Reason (optional)"}
          <textarea rows={5} maxLength={4000} minLength={kind === "change" ? 5 : undefined} required={kind === "change"} value={message} onChange={e => setMessage(e.target.value)} placeholder={kind === "change" ? "Describe the new date, start/end time, room or other changes." : ""}/>
        </label>
        {pending && <p role="status">A request for this booking is awaiting review.</p>}
        {selected && now > selected.deadline && <p role="alert">The two-hour deadline has passed. Contact the booking administrator.</p>}
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        <button className="button" disabled={busy || pending || !selected || now > selected.deadline}>{busy ? "Sending…" : kind === "cancel" ? "Request cancellation" : "Request changes"}</button>
      </form>
      {data.requests.length > 0 && <section aria-label="Your requests"><h2>Your requests</h2>{data.requests.map((row,i) => <article className="panel" key={i}>
        <strong>{row.kind === "cancel" ? "Cancellation" : "Change request"} · {row.status}</strong><p>{row.message}</p>{row.response && <p>{row.response}</p>}
      </article>)}</section>}
    </>}
  </main>;
}
