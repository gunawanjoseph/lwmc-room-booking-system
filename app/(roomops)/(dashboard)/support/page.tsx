"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { messageFromError } from "@/lib/ui";
import { MAX_SUPPORT_IMAGE_BYTES, SUPPORT_IMAGE_TYPES } from "@/convex/lib/supportRules";
import "./support.css";

type Severity = "low" | "medium" | "high" | "critical";
type Category = "feature" | "change" | "bug_known" | "bug_fixed";
type DraftFile = { id: Id<"supportAttachments">; name: string };
function imageEndpoint() {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL || process.env.NEXT_PUBLIC_CONVEX_URL?.replace(/\.convex\.cloud$/, ".convex.site");
  if (!site) throw new Error("Support image endpoint is not configured.");
  return `${site.replace(/\/$/, "")}/support/image`;
}
function PrivateImage({ id, name }: { id: Id<"supportAttachments">; name: string }) {
  const { getToken } = useAuth();
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setError(false);
    void (async () => {
      try {
        const token = await getToken({ template: "convex" });
        if (!token) throw new Error("Sign in again.");
        const response = await fetch(`${imageEndpoint()}?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok) throw new Error("Picture unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, getToken, attempt]);
  if (error) return <button className="button button-secondary" onClick={() => setAttempt(attempt + 1)}>Reload {name}</button>;
  return url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name}`}>
    {/* Blob URLs are authenticated downloads and cannot use the Next image optimizer. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={url} alt={name} className="support-image" />
  </a> : <span role="status">Loading {name}…</span>;
}
function Composer({ onSend, label, children, draftKey = "", onBusy, compact = false }: {
  onSend: (body: string, files: Id<"supportAttachments">[], requestId: string) => Promise<void>;
  label: string; children?: React.ReactNode; draftKey?: string; onBusy?: (busy: boolean) => void; compact?: boolean;
}) {
  const { getToken } = useAuth();
  const discard = useMutation(api.support.discardAttachment);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const lock = useRef(false);
  const previousDraftKey = useRef(draftKey);
  useEffect(() => { if (previousDraftKey.current !== draftKey) { requestId.current = null; previousDraftKey.current = draftKey; } }, [draftKey]);
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  async function upload(selected: File[]) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (files.length + selected.length > 5) throw new Error("Attach at most five pictures per message.");
      for (const file of selected) {
        if (!SUPPORT_IMAGE_TYPES.includes(file.type as typeof SUPPORT_IMAGE_TYPES[number]) || file.size > MAX_SUPPORT_IMAGE_BYTES) throw new Error("Use PNG, JPEG, WebP or GIF pictures up to 5 MB each.");
      }
      const token = await getToken({ template: "convex" });
      if (!token) throw new Error("Please sign in again.");
      for (const file of selected) {
        const response = await fetch(imageEndpoint(), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) }, body: file });
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as { attachmentId: Id<"supportAttachments"> };
        setFiles(current => [...current, { id: result.attachmentId, name: file.name }]);
      }
    } catch (caught) { setError(messageFromError(caught)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <form className="support-composer" onSubmit={async event => {
    event.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try { await onSend(body, files.map(file => file.id), requestId.current); setBody(""); setFiles([]); requestId.current = null; }
    catch (caught) { setError(messageFromError(caught)); }
    finally { lock.current = false; setBusy(false); }
  }}>
    <fieldset disabled={busy}>{children}
      <label className="field"><span>Message</span><textarea rows={compact ? 3 : 5} maxLength={8000} required={!files.length} value={body} onChange={event => { setBody(event.target.value); requestId.current = null; }} placeholder={compact ? "Write a reply…" : "What happened? What did you expect? How can we reproduce it?"} /></label>
      <label className="field support-upload"><span>Attach pictures <small>Up to 5 · 5 MB each</small></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; requestId.current = null; void upload(selected); }} /></label>
      {files.map(file => <div key={file.id} className="support-file"><span>{file.name}</span><button type="button" className="button button-secondary button-small" onClick={async () => {
        if (lock.current) return; lock.current = true; setBusy(true); setError("");
        try { await discard({ attachmentId: file.id }); setFiles(current => current.filter(item => item.id !== file.id)); requestId.current = null; }
        catch (caught) { setError(messageFromError(caught)); } finally { lock.current = false; setBusy(false); }
      }}>Remove</button></div>)}
      <button className="button button-primary support-send" disabled={busy || (!body.trim() && !files.length)}>{busy ? "Please wait…" : label}</button>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <small>Replies happen here in Support. Email notifications link back to the conversation.</small>
  </form>;
}
function Conversation({ id, developer }: { id: Id<"supportThreads">; developer: boolean }) {
  const thread = useQuery(api.support.get, { threadId: id });
  const messages = usePaginatedQuery(api.support.messages, { threadId: id }, { initialNumItems: 30 });
  const reply = useMutation(api.support.reply);
  const update = useMutation(api.support.update);
  const retry = useMutation(api.support.retryNotifications);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (thread === undefined) return <p role="status">Loading conversation…</p>;
  if (!thread) return <p>Conversation not found.</p>;
  async function change(status: "open" | "solved", severity: Severity) {
    if (!thread || busy) return; setBusy(true); setError("");
    try { await update({ threadId: id, expectedRevision: thread.revision, status, severity, requestId: crypto.randomUUID() }); }
    catch (caught) { setError(messageFromError(caught)); } finally { setBusy(false); }
  }
  return <section className="panel support-conversation">
    <div className="support-conversation-heading"><span className="panel-kicker">{thread.kind === "report" ? "BUG REPORT" : "DEVELOPER UPDATE"}</span>
    <h2>{thread.title}</h2><p className="support-meta">{thread.authorName} · {new Date(thread.createdAt).toLocaleString()}</p></div>
    <div className="support-toolbar"><span className={`support-tag support-${thread.severity}`}>{thread.severity}</span><span className="support-tag">{thread.status}</span>
      {thread.announcementType && <span className="support-tag">{thread.announcementType.replaceAll("_", " ")}</span>}
      {thread.canManage && <><label className="support-severity-control">Severity <select aria-label="Conversation severity" disabled={busy} value={thread.severity} onChange={event => void change(thread.status, event.target.value as Severity)}>{["low", "medium", "high", "critical"].map(value => <option key={value}>{value}</option>)}</select></label><button className="button button-secondary" disabled={busy} onClick={() => void change(thread.status === "open" ? "solved" : "open", thread.severity)}>{thread.status === "open" ? "Mark solved" : "Reopen"}</button></>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {messages.status === "CanLoadMore" && <button className="button button-secondary" onClick={() => messages.loadMore(30)}>Load older messages</button>}
    {messages.status === "LoadingFirstPage" && <p role="status">Loading messages…</p>}
    <div className="support-messages">{[...messages.results].reverse().map(message => <article className={`support-message ${message.system ? "support-system" : ""}`} key={message._id}>
      <header><strong>{message.authorName}</strong><span>{message.authorKind === "developer" ? "Developer" : "Administrator"} · {new Date(message.createdAt).toLocaleString()}</span></header>
      <p className="support-body">{message.body}</p>
      <div className="support-images">{message.attachments.map(file => file && <PrivateImage key={file._id} id={file._id} name={file.name} />)}</div>
      <small>Email: {message.emailStatus.sent} sent · {message.emailStatus.pending} queued · {message.emailStatus.failed} failed{message.emailStatus.cancelled > 0 && ` · ${message.emailStatus.cancelled} cancelled`}</small>
      {developer && message.emailStatus.failed > 0 && <button className="button button-secondary button-small" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await retry({ messageId: message._id }); } catch (caught) { setError(messageFromError(caught)); } finally { setBusy(false); } }}>Retry email</button>}
    </article>)}</div>
    <div className="support-reply"><h3>Reply</h3>{thread.status === "solved" && <p>Sending a reply reopens this conversation.</p>}
    <Composer compact label="Send reply" onSend={async (body, attachmentIds, requestId) => { await reply({ threadId: id, body, attachmentIds, requestId }); }} /></div>
  </section>;
}
function Workspace() {
  const profile = useQuery(api.users.me);
  const configuration = useQuery(api.support.configuration);
  const create = useMutation(api.support.create);
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("thread");
  const [kind, setKind] = useState<"report" | "announcement">("report");
  const [filter, setFilter] = useState<"open" | "solved" | "all">("open");
  const [composingBusy, setComposingBusy] = useState(false);
  const [compose, setCompose] = useState<"report" | "announcement" | null>(null);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [category, setCategory] = useState<Category>("change");
  const list = usePaginatedQuery(api.support.list, { kind, status: kind === "report" && filter !== "all" ? filter : undefined }, { initialNumItems: 25 });
  const developer = profile?.capabilities.includes("support.develop") ?? false;
  const canPublish = profile?.role === "developer" && profile.capabilities.includes("support.publish");
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected || compose) detailRef.current?.focus({ preventScroll: true }); }, [selected, compose]);
  return <div className="support-workspace">
    <header className="support-page-header"><div><span className="panel-kicker">ROOMOPS</span><h1>Support & updates</h1><p>Report a problem, follow the conversation, and see what’s new.</p></div>
      <div className="support-toolbar"><button className="button button-primary" disabled={composingBusy || !!compose} onClick={() => { setCompose("report"); setTitle(""); }}>Report a bug</button>{canPublish && <button className="button button-secondary" disabled={composingBusy || !!compose} onClick={() => { setCompose("announcement"); setTitle(""); }}>Publish an update</button>}</div>
    </header><p className="support-privacy">Conversations and pictures are shared with active administrators and the developer.</p>
      {configuration && !configuration.hasRecipients && <p role="status" className="form-error">DEVELOPER_EMAIL is missing or invalid in Convex. Reports are saved here, but developer email notifications are disabled until deployment configuration is corrected.</p>}
    <div className={`support-columns ${selected || compose ? "support-detail-open" : ""}`}><aside className="panel support-sidebar"><div className="support-tabs" aria-label="Conversation type"><button className="button button-secondary" aria-pressed={kind === "report"} disabled={!!compose} onClick={() => setKind("report")}>Bug reports</button><button className="button button-secondary" aria-pressed={kind === "announcement"} disabled={!!compose} onClick={() => setKind("announcement")}>Updates</button></div>
      {kind === "report" && <label className="field"><span>Status</span><select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="open">Open</option><option value="solved">Solved</option><option value="all">All</option></select></label>}
      <div className="support-thread-list">{list.results.map(thread => <button className={`support-thread ${selected === thread._id ? "selected" : ""}`} key={thread._id} aria-current={selected === thread._id ? "true" : undefined} disabled={!!compose || composingBusy} onClick={() => router.push(`/support?thread=${thread._id}`)}><strong>{thread.title}</strong><span>{thread.kind === "report" ? `${thread.severity} · ${thread.status}` : thread.announcementType?.replaceAll("_", " ")}</span><small>{thread.authorName} · {new Date(thread.updatedAt).toLocaleDateString()}</small></button>)}</div>
      {list.status === "LoadingFirstPage" ? <p role="status">Loading…</p> : !list.results.length && <p>No conversations in this view.</p>}
      {list.status === "CanLoadMore" && <button className="button button-secondary" onClick={() => list.loadMore(25)}>Load more</button>}
    </aside><div className="support-detail" ref={detailRef} tabIndex={-1}><button className="button button-secondary support-back" disabled={composingBusy} onClick={() => { setCompose(null); router.push("/support"); }}>← Back to conversations</button>{compose && (compose === "report" || canPublish) ? <section className="panel support-draft"><h2>{compose === "report" ? "New bug report" : "New developer update"}</h2><Composer key={compose} draftKey={JSON.stringify([title, severity, category])} onBusy={setComposingBusy} label={compose === "report" ? "Submit report" : "Publish update"} onSend={async (body, attachmentIds, requestId) => {
      const id = await create({ kind: compose, title, severity, announcementType: compose === "announcement" ? category : undefined, body, attachmentIds, requestId });
      setKind(compose); setCompose(null); setComposingBusy(false); router.push(`/support?thread=${id}`);
    }}>
      <label className="field"><span>Title</span><input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      {compose === "report" ? <label className="field"><span>Severity</span><select value={severity} onChange={event => setSeverity(event.target.value as Severity)}><option value="low">Low — minor inconvenience</option><option value="medium">Medium — function impaired</option><option value="high">High — work blocked</option><option value="critical">Critical — widespread outage</option></select></label> : <label className="field"><span>Category</span><select value={category} onChange={event => setCategory(event.target.value as Category)}><option value="feature">New feature</option><option value="change">Change</option><option value="bug_known">Known bug</option><option value="bug_fixed">Bug fixed</option></select></label>}
    </Composer><div className="support-draft-footer"><button className="button button-secondary" disabled={composingBusy} onClick={() => setCompose(null)}>Close draft</button><small> Unsent pictures expire after 24 hours.</small></div></section> : selected && /^[a-z0-9]{20,64}$/.test(selected) ? <Conversation key={selected} id={selected as Id<"supportThreads">} developer={developer} /> : <section className="panel support-empty"><span className="panel-kicker">YOUR SUPPORT WORKSPACE</span><h2>Select a conversation</h2><p>Choose a report or update from the list, or report a new problem.</p></section>}</div></div>
  </div>;
}
export default function SupportPage() { return <Suspense fallback={<p>Loading Support…</p>}><Workspace /></Suspense>; }
