"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAction, useMutation } from "convex/react";
import {
  CalendarCheck2,
  CheckCircle2,
  Clipboard,
  Database,
  ExternalLink,
  MailCheck,
  RefreshCw,
  Send,
  ServerCog,
  Webhook,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { messageFromError } from "@/lib/ui";

type Question = {
  qid: string;
  type: string;
  name: string;
  text: string;
  order: number;
};

type InspectResult = {
  formId: string;
  apiBase: string;
  apiCallsRemaining?: number;
  questions: Question[];
};

type CalendarInspectResult = {
  calendarCount: number;
  serviceAccountEmail: string;
  venues: Array<{
    calendarCount: number;
    calendars: Array<{
      accessRole: string;
      calendarId: string;
      summary: string;
      timeZone?: string;
    }>;
    venue: string;
  }>;
};

type GmailInspectResult = {
  appBaseUrl: string;
  fromEmail: string;
  refreshTokenOperational: boolean;
  gmailSendScopeConfirmed: boolean;
  scopeWasReturned: boolean;
};

const commonFields = [
  ["requesterName", "Requester name"],
  ["requesterEmail", "Requester email"],
  ["room", "Room"],
  ["eventName", "Event name (optional)"],
  ["purpose", "Purpose (optional)"],
  ["ministry", "Ministry (optional)"],
  ["recurrence", "Repeat option (optional)"],
  ["recurrenceCount", "Number of occurrences (optional)"],
  ["recurrenceUntil", "Repeat-until date (optional)"],
] as const;

const optionalMappingFields = new Set([
  "eventName",
  "purpose",
  "ministry",
  "recurrence",
  "recurrenceCount",
  "recurrenceUntil",
  "endDate",
]);

export default function IntegrationsPage() {
  const rebuildActiveClaimsPage = useMutation(
    api.bookings.rebuildActiveClaimsPage,
  );
  const inspectForm = useAction(api.jotform.inspectForm);
  const inspectCalendar = useAction(
    api.googleCalendar.inspectConfiguration,
  );
  const inspectGmail = useAction(
    api.emailNotifications.inspectConfiguration,
  );
  const sendGmailTest = useAction(
    api.emailNotifications.sendTestEmail,
  );
  const retryFailedEmails = useAction(
    api.emailNotifications.retryFailedDeliveries,
  );
  const retrySubmission = useAction(api.jotform.retrySubmission);
  const [inspection, setInspection] = useState<InspectResult | null>(
    null,
  );
  const [calendarInspection, setCalendarInspection] =
    useState<CalendarInspectResult | null>(null);
  const [gmailInspection, setGmailInspection] =
    useState<GmailInspectResult | null>(null);
  const [gmailTestEmail, setGmailTestEmail] = useState("");
  const [gmailMessage, setGmailMessage] = useState("");
  const [mappingMode, setMappingMode] = useState<"split" | "full">(
    "split",
  );
  const [selections, setSelections] = useState<Record<string, string>>(
    {},
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [retryId, setRetryId] = useState("");
  const [retryMessage, setRetryMessage] = useState("");
  const [claimMigrationCursor, setClaimMigrationCursor] = useState<
    string | null
  >(null);
  const [claimMigrationProcessed, setClaimMigrationProcessed] =
    useState(0);
  const [claimMigrationMessage, setClaimMigrationMessage] =
    useState("");

  const mappingFields = useMemo(
    () => [
      ...commonFields,
      ...(mappingMode === "split"
        ? ([
            ["date", "Booking date"],
            ["startTime", "Start time"],
            ["endDate", "End date (optional)"],
            ["endTime", "End time"],
          ] as const)
        : ([
            ["start", "Start date and time"],
            ["end", "End date and time"],
          ] as const)),
    ],
    [mappingMode],
  );

  const generatedMap = useMemo(() => {
    const map = Object.fromEntries(
      mappingFields
        .filter(([key]) => selections[key])
        .map(([key]) => [key, selections[key]]),
    );
    return JSON.stringify(map);
  }, [mappingFields, selections]);
  const mappingIssue = useMemo(() => {
    const requiredFields = mappingFields
      .filter(([key]) => !optionalMappingFields.has(key))
      .map(([key]) => key);
    const missing = requiredFields.filter(
      (key) => !selections[key],
    );
    if (missing.length > 0) {
      return `Choose all required questions: ${missing.join(", ")}.`;
    }
    const owners = new Map<string, string>();
    for (const [key] of mappingFields) {
      const qid = selections[key];
      if (!qid) continue;
      const existing = owners.get(qid);
      if (existing) {
        return `Question ${qid} is selected for both ${existing} and ${key}. Each mapped field needs its own question.`;
      }
      owners.set(qid, key);
    }
    return "";
  }, [mappingFields, selections]);

  async function inspect() {
    setBusy("jotform");
    setError("");
    try {
      setInspection((await inspectForm({})) as InspectResult);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function inspectGoogleCalendar() {
    setBusy("calendar");
    setError("");
    setCalendarInspection(null);
    try {
      setCalendarInspection(
        (await inspectCalendar({})) as CalendarInspectResult,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function inspectGmailConfiguration() {
    setBusy("gmail-inspect");
    setError("");
    setGmailMessage("");
    setGmailInspection(null);
    try {
      setGmailInspection(
        (await inspectGmail({})) as GmailInspectResult,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function testGmail(event: React.FormEvent) {
    event.preventDefault();
    setBusy("gmail-test");
    setError("");
    setGmailMessage("");
    try {
      await sendGmailTest({ to: gmailTestEmail });
      setGmailMessage(
        `Test email sent to ${gmailTestEmail.trim().toLowerCase()}.`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function retryEmails() {
    setBusy("gmail-retry");
    setError("");
    setGmailMessage("");
    try {
      const result = (await retryFailedEmails({})) as {
        queued: number;
      };
      setGmailMessage(
        result.queued === 0
          ? "There are no failed email deliveries to retry."
          : `${result.queued} failed email ${
              result.queued === 1 ? "delivery was" : "deliveries were"
            } queued again.`,
      );
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function copyMapping() {
    if (mappingIssue) {
      setError(mappingIssue);
      return;
    }
    await navigator.clipboard.writeText(generatedMap);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  async function retry(event: React.FormEvent) {
    event.preventDefault();
    setBusy("retry");
    setRetryMessage("");
    setError("");
    try {
      const result = (await retrySubmission({
        submissionId: retryId,
      })) as { alreadyProcessed: boolean };
      setRetryMessage(
        result.alreadyProcessed
          ? "That submission was already processed."
          : "The submission was queued for processing.",
      );
      setRetryId("");
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  async function rebuildClaims() {
    setBusy("claims");
    setError("");
    setClaimMigrationMessage("");
    let cursor = claimMigrationCursor;
    let processed = 0;
    let rebuilt = 0;
    let removed = 0;
    let skipped = 0;
    try {
      for (let page = 0; page < 50; page += 1) {
        const result = await rebuildActiveClaimsPage({
          paginationOpts: {
            numItems: 25,
            cursor,
          },
        });
        processed += result.processed;
        rebuilt += result.rebuilt;
        removed += result.removed;
        skipped += result.skipped.length;
        cursor = result.continueCursor;
        if (result.isDone) {
          setClaimMigrationCursor(null);
          setClaimMigrationProcessed(
            (current) => current + processed,
          );
          setClaimMigrationMessage(
            `Finished. Rebuilt ${rebuilt} active bookings, cleaned ${removed} inactive bookings, and skipped ${skipped}.`,
          );
          return;
        }
      }
      setClaimMigrationCursor(cursor);
      setClaimMigrationProcessed(
        (current) => current + processed,
      );
      setClaimMigrationMessage(
        `Processed ${processed} more bookings (${skipped} skipped). Click Continue to process the next batch.`,
      );
    } catch (caught) {
      setClaimMigrationCursor(cursor);
      setError(messageFromError(caught));
    } finally {
      setBusy("");
    }
  }

  const siteUrl = (
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
    "https://YOUR-DEPLOYMENT.convex.site"
  ).replace(/\/+$/, "");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">HEAD ADMINISTRATOR ONLY</span>
          <h1>Integrations</h1>
          <p>
            Inspect the Jotform intake and confirm how submissions flow
            directly into the Convex booking database.
          </p>
        </div>
      </header>

      {error && <div className="form-error page-error">{error}</div>}

      <section className="integration-grid">
        <article className="panel integration-card">
          <div className="integration-heading">
            <span className="integration-icon">
              <Webhook size={21} />
            </span>
            <div>
              <span className="panel-kicker">INTAKE</span>
              <h2>Jotform</h2>
            </div>
          </div>
          <dl className="configuration-list">
            <div>
              <dt>Form</dt>
              <dd>
                <a
                  href="https://form.jotform.com/261740998492068"
                  target="_blank"
                  rel="noreferrer"
                >
                  261740998492068 <ExternalLink size={13} />
                </a>
              </dd>
            </div>
            <div>
              <dt>Webhook path</dt>
              <dd>
                <code>{siteUrl}/webhooks/jotform?secret=••••</code>
              </dd>
            </div>
          </dl>
          <button
            className="button button-secondary button-full"
            onClick={() => void inspect()}
            disabled={busy === "jotform"}
          >
            <ServerCog size={16} />
            {busy === "jotform"
              ? "Reading form metadata…"
              : "Inspect configured form"}
          </button>
          {inspection && (
            <div className="connection-success">
              <CheckCircle2 size={17} />
              <span>
                Connected through {inspection.apiBase}
                {inspection.apiCallsRemaining !== undefined &&
                  ` · ${inspection.apiCallsRemaining} API calls left`}
              </span>
            </div>
          )}
          <p className="integration-footnote">
            Non-core answers such as Remarks are stored as bounded text,
            keyed by Jotform question ID, and appear as dynamic columns.
          </p>
        </article>

        <article className="panel integration-card">
          <div className="integration-heading">
            <span className="integration-icon">
              <Database size={21} />
            </span>
            <div>
              <span className="panel-kicker">DATA STORE</span>
              <h2>Convex booking data</h2>
            </div>
          </div>
          <p className="muted-copy">
            The server retrieves each Jotform submission and saves it in
            Convex. The booking-data table reads Convex directly and has
            no Google Sheet or header dependency.
          </p>
          <dl className="status-list">
            <div>
              <dt>Canonical store</dt>
              <dd>
                <span className="config-ok">Convex</span>
              </dd>
            </div>
            <div>
              <dt>Additional fields</dt>
              <dd>Automatic qid-keyed columns</dd>
            </div>
            <div>
              <dt>Workbook export</dt>
              <dd>Available to every table viewer</dd>
            </div>
            <div>
              <dt>Table editors</dt>
              <dd>Head Administrator · Data Editor · Booking Manager</dd>
            </div>
          </dl>
          <Link
            className="button button-secondary button-full"
            href="/sheet"
          >
            <Database size={16} />
            Open booking data
          </Link>
          <p className="integration-footnote">
            Table edits cover requester details, event name, purpose,
            ministry, and non-core responses. Room, time, status, and
            approval stay in Bookings.
          </p>
        </article>

        <article className="panel integration-card">
          <div className="integration-heading">
            <span className="integration-icon google-icon">
              <CalendarCheck2 size={21} />
            </span>
            <div>
              <span className="panel-kicker">AVAILABILITY & EVENTS</span>
              <h2>Google Calendar</h2>
            </div>
          </div>
          <p className="muted-copy">
            RoomOps checks every physical venue calendar at intake and
            again at approval. Approval is complete only after the
            managed event is created.
          </p>
          <dl className="status-list">
            <div>
              <dt>Title format</dt>
              <dd>[Venue] Event or purpose Ministry</dd>
            </div>
            <div>
              <dt>Combined rooms</dt>
              <dd>A &amp; B creates one event on each calendar</dd>
            </div>
            <div>
              <dt>Recurring series</dt>
              <dd>Daily, weekly, ordinal weekday, or same date</dd>
            </div>
          </dl>
          <button
            className="button button-secondary button-full"
            onClick={() => void inspectGoogleCalendar()}
            disabled={busy === "calendar"}
          >
            <CalendarCheck2 size={16} />
            {busy === "calendar"
              ? "Checking calendar access…"
              : "Test all venue calendars"}
          </button>
          {calendarInspection && (
            <>
              <div className="connection-success">
                <CheckCircle2 size={17} />
                <span>
                  Read/write access confirmed as{" "}
                  {calendarInspection.serviceAccountEmail} ·{" "}
                  {calendarInspection.calendarCount} calendars across{" "}
                  {calendarInspection.venues.length} venues
                </span>
              </div>
              <details className="calendar-venue-details">
                <summary>View calendar names and write access</summary>
                <ul>
                  {calendarInspection.venues.map((venue) => (
                    <li key={venue.venue}>
                      <span>{venue.venue}</span>
                      <strong
                        title={venue.calendars
                          .map(
                            (calendar) =>
                              `${calendar.summary}: ${calendar.calendarId}`,
                          )
                          .join("\n")}
                      >
                        {venue.calendars
                          .map(
                            (calendar) =>
                              `${calendar.summary} · ${calendar.accessRole}`,
                          )
                          .join(", ")}
                      </strong>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <p className="integration-footnote">
            Configure the service-account key and venue-to-calendar-ID
            map in the same Convex deployment used by this app. Compare
            each returned Google calendar name with the RoomOps venue.
          </p>
        </article>

        <article className="panel integration-card">
          <div className="integration-heading">
            <span className="integration-icon google-icon">
              <MailCheck size={21} />
            </span>
            <div>
              <span className="panel-kicker">
                NOTIFICATIONS &amp; EMAIL APPROVAL
              </span>
              <h2>Gmail</h2>
            </div>
          </div>
          <p className="muted-copy">
            RoomOps sends requester updates and private approval links
            through one authorized Gmail mailbox. Failed deliveries retry
            independently without duplicating the other recipients.
          </p>
          <button
            className="button button-secondary button-full"
            onClick={() => void inspectGmailConfiguration()}
            disabled={busy === "gmail-inspect"}
          >
            <MailCheck size={16} />
            {busy === "gmail-inspect"
              ? "Checking Gmail credentials…"
              : "Check Gmail connection"}
          </button>
          {gmailInspection && (
            <>
              <div className="connection-success">
                <CheckCircle2 size={17} />
                <span>
                  Refresh token accepted · sending as{" "}
                  {gmailInspection.fromEmail}
                </span>
              </div>
              <dl className="status-list">
                <div>
                  <dt>Approval links</dt>
                  <dd>{gmailInspection.appBaseUrl}</dd>
                </div>
                <div>
                  <dt>gmail.send scope</dt>
                  <dd>
                    {gmailInspection.gmailSendScopeConfirmed
                      ? gmailInspection.scopeWasReturned
                        ? "Confirmed"
                        : "Token accepted; verify with a test email"
                      : "Missing"}
                  </dd>
                </div>
              </dl>
            </>
          )}
          <form onSubmit={testGmail} className="field">
            <span>Send a test email</span>
            <input
              type="email"
              required
              value={gmailTestEmail}
              onChange={(event) =>
                setGmailTestEmail(event.target.value)
              }
              placeholder="admin@example.com"
            />
            <button
              className="button button-primary button-full"
              disabled={busy === "gmail-test"}
            >
              <Send size={16} />
              {busy === "gmail-test"
                ? "Sending test…"
                : "Send Gmail test"}
            </button>
          </form>
          <button
            className="button button-secondary button-full"
            type="button"
            onClick={() => void retryEmails()}
            disabled={busy === "gmail-retry"}
          >
            <RefreshCw size={16} />
            {busy === "gmail-retry"
              ? "Queueing failed emails…"
              : "Retry failed email deliveries"}
          </button>
          {gmailMessage && (
            <div className="connection-success">
              <CheckCircle2 size={17} />
              <span>{gmailMessage}</span>
            </div>
          )}
          <p className="integration-footnote">
            Configure Gmail variables in Convex for this deployment.
            Approval links expire after 14 days and stop working when an
            approver is deactivated.
          </p>
        </article>
      </section>

      {inspection && (
        <section className="panel mapping-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">FIELD MAPPING</span>
              <h2>Build JOTFORM_FIELD_MAP_JSON</h2>
              <p>
                Map only the core fields used for conflict checks.
                Non-core answers need no mapping and become dynamic
                qid-keyed table columns.
              </p>
            </div>
            <label className="compact-field">
              <span>Timing fields</span>
              <select
                value={mappingMode}
                onChange={(event) => {
                  setError("");
                  setMappingMode(
                    event.target.value as "split" | "full",
                  );
                }}
              >
                <option value="split">Date + separate times</option>
                <option value="full">Two date-time fields</option>
              </select>
            </label>
          </div>
          <div className="mapping-grid">
            {mappingFields.map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <select
                  value={selections[key] ?? ""}
                  required={!optionalMappingFields.has(key)}
                  onChange={(event) => {
                    setError("");
                    setSelections((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }));
                  }}
                >
                  <option value="">Choose a Jotform question</option>
                  {inspection.questions.map((question) => (
                    <option key={question.qid} value={question.qid}>
                      {question.qid} ·{" "}
                      {question.text || question.name || question.type}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="code-copy">
            <code>{generatedMap}</code>
            <button
              className="button button-secondary button-small"
              onClick={() => void copyMapping()}
              disabled={Boolean(mappingIssue)}
            >
              {copied ? (
                <CheckCircle2 size={15} />
              ) : (
                <Clipboard size={15} />
              )}
              {copied ? "Copied" : "Copy JSON"}
            </button>
          </div>
          {mappingIssue && (
            <p className="integration-footnote">{mappingIssue}</p>
          )}
          <p className="integration-footnote">
            If a mapped core question is deleted and recreated, Jotform
            assigns a new question ID. Inspect the form again and update
            the mapping before accepting new submissions.
          </p>
        </section>
      )}

      <section className="panel retry-panel">
        <div>
          <span className="panel-kicker">RECOVERY</span>
          <h2>Retry a failed Jotform submission</h2>
          <p>
            Use the submission ID shown in the system log. Successful
            and duplicate submissions remain idempotent.
          </p>
        </div>
        <form onSubmit={retry}>
          <input
            required
            value={retryId}
            onChange={(event) => setRetryId(event.target.value)}
            placeholder="Jotform submission ID"
          />
          <button
            className="button button-secondary"
            disabled={busy === "retry"}
          >
            <RefreshCw size={15} />
            {busy === "retry" ? "Queuing…" : "Retry"}
          </button>
        </form>
        {retryMessage && (
          <div className="connection-success">{retryMessage}</div>
        )}
      </section>

      <section className="panel retry-panel">
        <div>
          <span className="panel-kicker">ONE-TIME UPGRADE</span>
          <h2>Normalize reservation claims</h2>
          <p>
            Run this once after deploying the Calendar integration. It
            rewrites existing pending and approved reservations against
            their physical venue calendars, including Ministry Centre
            A&amp;B and ABC.
          </p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => void rebuildClaims()}
          disabled={busy === "claims"}
        >
          <Database size={15} />
          {busy === "claims"
            ? "Rebuilding…"
            : claimMigrationCursor
              ? "Continue"
              : "Rebuild active claims"}
        </button>
        {claimMigrationProcessed > 0 && (
          <small>
            {claimMigrationProcessed} booking records processed in this
            session.
          </small>
        )}
        {claimMigrationMessage && (
          <div className="connection-success">
            {claimMigrationMessage}
          </div>
        )}
      </section>
    </div>
  );
}
