"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { DateTime } from "luxon";
import { CalendarDays, Clock3, MapPin, ArrowLeft, CheckCircle2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { formatDateTime, messageFromError } from "@/lib/ui";
import { Brand } from "@/components/brand";
import { BookingChangeComparison, requestStatusLabel, type ProposedEdit } from "@/components/booking-change-comparison";

import { isPhoneField, normalizePhone, phoneForEdit, phoneInput, PHONE_ERROR, PHONE_INPUT_PATTERN, PHONE_PLACEHOLDER, recurrenceLabel, recurrenceDescription, OTHER_MINISTRY, ministrySelection } from "@/shared/requestFields";
type Step = "summary" | "edit" | "review" | "cancel";
export function RequestBooking() {
  const [token, setToken] = useState<string | null>(null);
  const [sequence, setSequence] = useState("");
  const [scope, setScope] = useState<"occurrence" | "following">("occurrence");
  const [step, setStep] = useState<Step>("summary");
  const [draft, setDraft] = useState({ room: "", eventName: "", purpose: "", ministry: "", otherMinistry: "", start: "", end: "" });
  const [responses, setResponses] = useState<Array<{ qid: string; value: string }>>([]);
  const [pendingVersion, setPendingVersion] = useState<{key?:string;revision?:number}>({});
  const [editVersion, setEditVersion] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const operationKey = useRef("");
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      setToken(params.get("token") ?? ""); setStep("summary"); setSequence(params.get("meeting") ?? "");
    };
    read(); window.addEventListener("hashchange", read);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); window.removeEventListener("hashchange", read); };
  }, []);
  const data = useQuery(api.bookingRequests.view, token ? { token } : "skip");
  const submit = useMutation(api.bookingRequests.submit);
  const selected = data?.meetings.find(row => String(row.sequence) === sequence)
    ?? data?.meetings.find(row => row.deadline >= now) ?? data?.meetings[0];
  const affected = selected ? data!.meetings.filter(row => scope === "occurrence" ? row.sequence === selected.sequence : row.startAt >= selected.startAt) : [];
  const pending = data?.requests.find(row => row.status === "pending");
  const processing = data?.busy || data?.requests.some(row => ["checking", "applying", "failed"].includes(row.status));
  const closed = !selected || now >= selected.deadline;
  const stale = step !== "summary" && editVersion !== data?.version;
  function go(next: Step) { setStep(next); setError(""); requestAnimationFrame(() => heading.current?.focus()); }
  function begin(next: "edit" | "cancel") {
    if (!selected || !data) return;
    const editing = next === "edit" ? pending : undefined;
    const meeting = editing ? data.meetings.find(row => row.sequence === editing.sequence) ?? selected : selected;
    const saved = editing?.proposed ? JSON.parse(editing.proposed) as ProposedEdit : undefined;
    setPendingVersion(editing ? {key:editing.requestKey, revision:editing.requestRevision} : {});
    setSequence(String(meeting.sequence));
    setResponses(meeting.fields.map(field => ({ qid: field.qid, value: isPhoneField(field) ? phoneForEdit(saved?.responses?.find(row => row.qid === field.qid)?.value ?? field.value) : saved?.responses?.find(row => row.qid === field.qid)?.value ?? field.value })));
    setDraft({ room: saved?.room ?? meeting.room, eventName: saved?.eventName ?? meeting.title, purpose: saved?.purpose ?? meeting.purpose, ...ministrySelection(saved?.ministry ?? meeting.ministry), ...(saved?.ministry === OTHER_MINISTRY ? {otherMinistry:saved.otherMinistry ?? ""} : {}),
      start: DateTime.fromMillis(saved?.startAt ?? meeting.startAt, { zone: data.timezone }).toFormat("yyyy-MM-dd'T'HH:mm"),
      end: DateTime.fromMillis(saved?.endAt ?? meeting.endAt, { zone: data.timezone }).toFormat("yyyy-MM-dd'T'HH:mm") });
    setEditVersion(data.version); setScope(editing?.scope ?? "occurrence"); setMessage(editing?.message ?? ""); setNotice(""); operationKey.current = crypto.randomUUID(); go(next);
  }
  function proposal(at = now): ProposedEdit {
    const startAt = DateTime.fromISO(draft.start, { zone: data!.timezone }).toMillis();
    const endAt = DateTime.fromISO(draft.end, { zone: data!.timezone }).toMillis();
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw Error("Choose an end time after the start time.");
    if (startAt - at <= 2 * 60 * 60_000) throw Error("Choose a start time at least two hours from now.");
    if (!data!.ministries.includes(draft.ministry)) throw Error("Select a ministry from the list before continuing.");
    if (draft.ministry === OTHER_MINISTRY && (!draft.otherMinistry.trim() || draft.otherMinistry.trim().length > 120)) throw Error("Specify your ministry using 1 to 120 characters.");
    for (const field of selected?.fields ?? []) if (isPhoneField(field)) normalizePhone(responses.find(row => row.qid === field.qid)?.value ?? "");
    return { room: draft.room, eventName: draft.eventName.trim(), purpose: draft.purpose.trim(), ministry: draft.ministry.trim(), otherMinistry: draft.ministry === OTHER_MINISTRY ? draft.otherMinistry.trim() : undefined, startAt, endAt, responses };
  }
  function review(event: React.FormEvent) { event.preventDefault(); try { proposal(); go("review"); } catch (err) { setError(messageFromError(err)); } }
  async function send(kind: "change" | "cancel") {
    if (!data || !token || !selected || sending.current || stale) return;
    sending.current = true; setBusy(true); setError("");
    try {
      await submit({ token, sequence: selected.sequence, scope, kind, message, version: editVersion,
        expectedRequestKey: kind === "change" ? pendingVersion.key : undefined, expectedRequestRevision: kind === "change" ? pendingVersion.revision : undefined,
        edit: kind === "change" ? proposal(Date.now()) : undefined, confirmed: kind === "cancel", operationKey: operationKey.current });
      setNotice(kind === "cancel" ? "Cancellation is being processed. This page will confirm when it is complete." : "Checking your requested changes. Your original booking remains active until approval.");
      go("summary");
    } catch (err) { setError(messageFromError(err)); }
    finally { sending.current = false; setBusy(false); }
  }
  let proposed: ProposedEdit | null = null;
  if (step === "review" && data) { try { proposed = proposal(); } catch { /* Expiring drafts disable submission below. */ } }
  const scopeControl = data && data.meetings.length > 1 && <fieldset className="request-scope"><legend>Apply to</legend>
    {(["occurrence", "following"] as const).map(value => <label key={value}><input type="radio" name="scope" value={value} checked={scope === value} onChange={() => setScope(value)} disabled={busy}/>{value === "occurrence" ? "This event only" : "This event and following events"}</label>)}
    {affected.length > 1 && <details><summary>{affected.length} meetings</summary><ul>{affected.map(row => <li key={row.sequence}>{formatDateTime(row.startAt, data.timezone)} · {row.title}</li>)}</ul></details>}
  </fieldset>;
  return <main className="page requester-page"><div className="request-brand"><Brand/></div>
    <header className="request-page-header"><h1 ref={heading} tabIndex={-1}>{step === "edit" ? "Request changes" : step === "review" ? "Review your changes" : step === "cancel" ? "Cancel this booking?" : "Manage your booking"}</h1>
      <p>{data ? `Times shown in ${data.timezone}.` : "View and manage your approved meetings."}</p></header>
    {token === null || (token && data === undefined) ? <div className="panel requester-form" role="status">Loading your booking…</div> : !token || !data ?
      <div className="panel requester-form"><p>This link is unavailable. Contact the booking administrator for help.</p></div> : <>
      {notice && processing && <p className="request-notice" role="status">{notice}</p>}
      {error && <p className="request-error" role="alert">{error}</p>}
      {stale && <p className="request-error" role="alert">This booking has changed. <button type="button" className="text-link" onClick={() => go("summary")}>Review the latest booking</button> before continuing.</p>}
      {step === "summary" ? <>
        {selected ? <section className="panel requester-form" aria-label="Approved booking">
          {data.meetings.length > 1 && <label>Meeting<select value={selected.sequence} onChange={e => { setSequence(e.target.value); setNotice(""); }}>
            {data.meetings.map(row => <option key={row.sequence} value={row.sequence}>{formatDateTime(row.startAt, data.timezone)} · {row.title}</option>)}
          </select></label>}
          <div><span className="request-status">Approved booking</span><h2 className="request-title">{selected.title}</h2></div>
          <div className="request-summary"><p><MapPin size={18} aria-hidden="true"/>{selected.room}</p><p><CalendarDays size={18} aria-hidden="true"/>{formatDateTime(selected.startAt, data.timezone)}</p><p><Clock3 size={18} aria-hidden="true"/>Ends {formatDateTime(selected.endAt, data.timezone)}</p></div>
          {(selected.ministry || selected.purpose) && <p className="request-description">{[selected.ministry, selected.purpose].filter(Boolean).join(" · ")}</p>}
          <p className="request-muted">{closed ? "Changes and cancellations are only available up to 2 hours before the booking starts." : `Changes and cancellations close ${formatDateTime(selected.deadline, data.timezone)}.`}</p>
          {pending && <p className="request-notice">An edit request is awaiting approval. You can update it or cancel the booking.</p>}
          {processing && <p className="request-notice" role="status">An operation is being processed. Check its status below.</p>}
          <p className="request-muted">Edit requests used: {data.editCount} / 3{data.editCount >= 3 ? ". The edit limit has been reached. Eligible cancellations are still available." : ". Each update to a pending request counts toward this limit."}</p>
          <div className="request-actions"><button className="button" disabled={closed || processing || data.editCount >= 3} onClick={() => begin("edit")}>{pending ? "Update pending request" : "Request changes"}</button><button className="button button-secondary request-danger-text" disabled={closed || processing} onClick={() => begin("cancel")}>Cancel booking</button></div>
        </section> : <section className="panel requester-form"><CheckCircle2 aria-hidden="true"/><h2>Booking cancelled</h2><p>This booking is cancelled. No further changes can be made.</p>{data.cancellationReason && <p>{data.cancellationReason}</p>}</section>}
      </> : step === "edit" ? <form className="panel requester-form" onSubmit={review}>
        {scopeControl}
        <label>Event title<input required maxLength={300} value={draft.eventName} onChange={e => setDraft({ ...draft, eventName: e.target.value })}/></label>
        <label>Room<select value={draft.room} onChange={e => setDraft({ ...draft, room: e.target.value })}>{data.rooms.map(room => <option key={room}>{room}</option>)}</select></label>
        {scope === "following" && selected && <p className="request-muted"><strong>{recurrenceLabel(data.recurrenceFrequency)} frequency stays unchanged.</strong><br/>Current: {recurrenceDescription(selected.startAt,data.recurrenceFrequency,data.timezone)}{draft.start && DateTime.fromISO(draft.start,{zone:data.timezone}).isValid && <><br/>Requested: {recurrenceDescription(DateTime.fromISO(draft.start,{zone:data.timezone}).toMillis(),data.recurrenceFrequency,data.timezone)}</>}</p>}
        <div className="request-field-grid"><label>Starts<input type="datetime-local" required value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })}/></label><label>Ends<input type="datetime-local" required value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })}/></label></div>
        <label>Ministry<select required value={data.ministries.includes(draft.ministry) ? draft.ministry : ""} onChange={e => setDraft({ ...draft, ministry: e.target.value })}><option value="" disabled>Select a ministry</option>{data.ministries.map(value => <option key={value}>{value}</option>)}</select></label>
        {draft.ministry === OTHER_MINISTRY && <label>Specify ministry<input required maxLength={120} value={draft.otherMinistry} placeholder="Enter your ministry" onChange={e => setDraft({...draft,otherMinistry:e.target.value})}/></label>}
        {!data.ministries.length && <p role="alert">Ministry options are not available yet. Please contact the administrator.</p>}
        {draft.ministry && !data.ministries.includes(draft.ministry) && <p className="request-muted">The previous ministry is no longer listed. Please select a current ministry.</p>}
        <label>Purpose<textarea rows={3} maxLength={2000} value={draft.purpose} onChange={e => setDraft({ ...draft, purpose: e.target.value })}/></label>
        {selected?.fields.map(field => <label key={field.qid}>{field.label}<input onInvalid={e => { if (isPhoneField(field)) e.currentTarget.setCustomValidity(PHONE_ERROR); }} onInput={e => e.currentTarget.setCustomValidity("")} required={isPhoneField(field)} placeholder={isPhoneField(field) ? PHONE_PLACEHOLDER : undefined} pattern={isPhoneField(field) ? PHONE_INPUT_PATTERN : undefined} inputMode={isPhoneField(field) ? "tel" : undefined} type={field.type === "control_number" ? "number" : field.type === "control_email" ? "email" : field.type === "control_phone" ? "tel" : "text"} step={field.type === "control_number" ? "any" : undefined} maxLength={4000} value={responses.find(row => row.qid === field.qid)?.value ?? ""} onChange={e => setResponses(responses.map(row => row.qid === field.qid ? { ...row, value: isPhoneField(field) ? phoneInput(e.target.value) : e.target.value } : row))}/></label>)}
        <label>Note to the approver (optional)<textarea rows={2} maxLength={4000} value={message} onChange={e => setMessage(e.target.value)}/></label>
        {scope === "following" && <p className="request-muted">{recurrenceLabel(data.recurrenceFrequency)} frequency stays unchanged. Changing the date re-anchors the remaining meetings to the new day, keeping the same number of meetings. Earlier meetings are kept. The room, times and details apply to all selected meetings.</p>}
        <div className="request-actions"><button type="button" className="button button-secondary" onClick={() => go("summary")}><ArrowLeft size={16}/>Back</button><button className="button" disabled={stale || closed}>Review changes</button></div>
      </form> : step === "review" ? <section className="panel requester-form" aria-label="Review changes">
        {selected && proposed ? <BookingChangeComparison before={selected} after={proposed} timezone={data.timezone}/> : <p role="alert">The proposed start is now within two hours. Go back and choose a later time.</p>}
        <p>{affected.length} meeting{affected.length === 1 ? "" : "s"} affected. Your original booking stays active while these changes await approval.</p>
        <div className="request-actions"><button className="button button-secondary" disabled={busy} onClick={() => go("edit")}>Back</button><button className="button" disabled={busy || stale || closed || !proposed} onClick={() => void send("change")}>{busy ? "Submitting…" : "Submit changes"}</button></div>
      </section> : <section className="panel requester-form request-cancel" aria-label="Confirm cancellation">
        {selected && <div><h2>{selected.title}</h2><p>{selected.room}</p><p>{formatDateTime(selected.startAt, data.timezone)} – {formatDateTime(selected.endAt, data.timezone)}</p></div>}
        {scopeControl}<p>This will cancel {affected.length === 1 ? "this meeting" : `these ${affected.length} meetings`} and release the room. No administrator approval is needed.</p>
        <label>Reason (optional)<textarea rows={3} maxLength={4000} value={message} disabled={busy} onChange={e => setMessage(e.target.value)}/></label>
        <div className="request-actions"><button className="button button-secondary" disabled={busy} onClick={() => go("summary")}>Keep booking</button><button className="button request-danger" disabled={busy || stale || closed} onClick={() => void send("cancel")}>{busy ? "Cancelling…" : "Confirm cancellation"}</button></div>
      </section>}
      {data.requests.length > 0 && <section className="request-history" aria-label="Request history"><h2>Activity</h2>{data.requests.map((row, i) => <article className="panel requester-form" key={row.createdAt + ":" + i}>
        <div className="request-history-heading"><strong>{requestStatusLabel(row.status, row.kind)}</strong><time dateTime={new Date(row.createdAt).toISOString()}>{formatDateTime(row.createdAt, data.timezone)}</time></div>
        {row.message && <p>{row.message}</p>}{row.response && <p role={row.status === "failed" ? "alert" : "status"}>{row.response}</p>}
        {row.status === "completed" && row.kind === "cancel" && <details><summary>Cancelled meetings</summary><ul>{(JSON.parse(row.before) as Array<{title:string;room:string;startAt:number;endAt:number}>).map((meeting, j) => <li key={j}>{meeting.title} · {meeting.room}<br/>{formatDateTime(meeting.startAt, data.timezone)} – {formatDateTime(meeting.endAt, data.timezone)}</li>)}</ul></details>}
      </article>)}</section>}
    </>}
  </main>;
}
