"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { messageFromError } from "@/lib/ui";

export function TechSupportSettings() {
  const data = useQuery(api.techSupport.list);
  const save = useMutation(api.techSupport.save);
  const retry = useMutation(api.techSupport.retry);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function update(address: string, active: boolean) {
    setBusy(true); setError(""); setNotice("");
    try { await save({email:address,active}); setEmail(""); setNotice(active ? "Support alerts enabled for this address." : "Support alerts disabled for this address."); }
    catch (caught) {setError(messageFromError(caught));}
    finally {setBusy(false);}
  }
  return <section className="panel integration-card">
    <span className="panel-kicker">TECHNICAL SUPPORT</span><h2>Incident alert emails</h2>
    <p>Warnings, errors and suspicious or failed operations are emailed to these recipients as soon as the log is saved. Uses the configured Gmail sender. Only the Head Administrator can manage this list.</p>
    <form onSubmit={event=>{event.preventDefault();void update(email,true);}} className="form-grid">
      <label className="field"><span>Support email address</span><input required type="email" maxLength={254} value={email} disabled={busy} onChange={event=>setEmail(event.target.value)} placeholder="support@example.com"/></label>
      <button className="button button-primary" disabled={busy || !data}>Enable alerts</button>
    </form>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    <div className="support-list">{!data ? <p>Loading support settings…</p> : !data.recipients.length ? <p>No recipients yet. Add an address to start sending alerts for new logs.</p> : data.recipients.map(recipient=><div className="support-recipient" key={recipient._id}><span><strong>{recipient.email}</strong><small> · {recipient.active?"Enabled":"Disabled"}</small></span><button type="button" className="button button-secondary button-small" disabled={busy} onClick={()=>update(recipient.email,!recipient.active)}>{recipient.active?"Disable":"Enable"}</button></div>)}</div>
    <h3>Recent alert deliveries</h3><p>Delivery is queued immediately; Gmail or network failures may delay it. Failed alerts can be retried here. Disabling a recipient cancels queued sends when the worker checks it; a message already in flight may still arrive.</p>
    <div className="support-list">{data?.deliveries.map(delivery=><div className="support-recipient" key={delivery._id}><span>{delivery.email}<br/><small>{new Date(delivery.createdAt).toLocaleString()} · {delivery.status} · {delivery.attempts} attempt(s)</small>{delivery.error && <p>{delivery.error}</p>}</span>{delivery.status==="failed" && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await retry({deliveryId:delivery._id});}catch(caught){setError(messageFromError(caught));}finally{setBusy(false);}}}>Retry</button>}</div>)}{data && !data.deliveries.length && <p>No alerts have been queued yet.</p>}</div>
  </section>;
}
