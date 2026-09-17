"use client";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { messageFromError } from "@/lib/ui";

export function DeveloperSettings() {
  const data = useQuery(api.techSupport.list);
  const retry = useMutation(api.techSupport.retry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="panel integration-card">
    <span className="panel-kicker">DEVELOPER</span><h2>Developer notifications</h2>
    <p>Bug reports and suspicious or failed operations are emailed to the single Developer address configured in Convex. This identity cannot be changed through the app.</p>
    <p>{data ? (data.developerEmail ?? "DEVELOPER_EMAIL is missing or invalid; developer notifications are disabled.") : "Loading developer configuration…"}</p>
    <small>Deployment setting: DEVELOPER_EMAIL. The Head Administrator cannot assign, change or remove the Developer account.</small>
    {error && <div className="form-error" role="alert">{error}</div>}
    <h3>Recent alert deliveries</h3><p>Delivery is queued immediately; Gmail or network failures may delay it. Failed alerts can be retried here. Changing DEVELOPER_EMAIL cancels sends to the old address when the worker checks it; a message already in flight may still arrive.</p>
    <div className="support-list">{data?.deliveries.map(delivery=><div className="support-recipient" key={delivery._id}><span>{delivery.email}<br/><small>{new Date(delivery.createdAt).toLocaleString()} · {delivery.status} · {delivery.attempts} attempt(s)</small>{delivery.error && <p>{delivery.error}</p>}</span>{delivery.status==="failed" && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await retry({deliveryId:delivery._id});}catch(caught){setError(messageFromError(caught));}finally{setBusy(false);}}}>Retry</button>}</div>)}{data && !data.deliveries.length && <p>No alerts have been queued yet.</p>}</div>
  </section>;
}
