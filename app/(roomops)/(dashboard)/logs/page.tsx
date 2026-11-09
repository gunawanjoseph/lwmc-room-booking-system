"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Search,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { formatDateTime } from "@/lib/ui";
import { jotformProcessingLabel, type JotformProcessingStatus } from "@/shared/jotformRetry";

type AuditLog = {
  _id: string;
  level: "info" | "warning" | "error";
  category: string;
  action: string;
  actorType: "user" | "system";
  actorId?: string;
  entityType?: string;
  entityId?: string;
  message: string;
  detailsJson?: string;
  createdAt: number;
  jotformProcessing?: JotformProcessingStatus;
};

const levelIcons = {
  info: Info,
  warning: AlertCircle,
  error: AlertCircle,
};

export default function LogsPage() {
  const logs = useQuery(api.logs.list, { limit: 200 }) as
    | AuditLog[]
    | undefined;
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");

  const categories = useMemo(
    () => [...new Set((logs ?? []).map((log) => log.category))].sort(),
    [logs],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en");
    return (logs ?? []).filter(
      (log) =>
        (category === "all" || log.category === category) &&
        (!needle ||
          [log.action, log.message, log.entityId ?? ""].some((value) =>
            value.toLocaleLowerCase("en").includes(needle),
          )),
    );
  }, [logs, category, query]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">OBSERVABILITY</span>
          <h1>System logs</h1>
          <p>
            Inspect Jotform processing, conflict decisions, permissioned
            data changes, and workbook exports.
          </p>
        </div>
      </header>

      <section className="toolbar panel">
        <label className="search-field">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions, messages, or entity IDs"
          />
        </label>
        <select
          className="filter-select"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {categories.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </section>

      <section className="panel log-panel">
        {!logs ? (
          <div className="table-message">Loading system logs…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <CheckCircle2 size={28} />
            <h2>No matching log entries</h2>
            <p>Try a different category or search phrase.</p>
          </div>
        ) : (
          <div className="log-list">
            {filtered.map((log) => {
              const processing = log.jotformProcessing;
              const recovered = processing?.state === "processed";
              const attention = processing && !recovered && (processing.attentionNotifiedAt !== undefined
                || (processing.state === "failed" && processing.nextRetryAt === undefined));
              const currentLevel = processing ? attention ? (processing.state === "failed" && processing.nextRetryAt === undefined ? "error" : "warning") : "info" : log.level;
              const Icon = recovered ? CheckCircle2 : levelIcons[currentLevel];
              return (
                <article className="log-row" key={log._id}>
                  <span className={`log-icon ${recovered ? "log-success" : `log-${currentLevel}`}`}>
                    <Icon size={16} />
                  </span>
                  <div className="log-main">
                    <div className="log-title-line">
                      <strong>{log.message}</strong>
                      <span>{formatDateTime(log.createdAt)}</span>
                    </div>
                    <div className="log-meta">
                      <span>{log.category.replaceAll("_", " ")}</span>
                      <code>{log.action}</code>
                      {log.entityId && (
                        <span>
                          {log.entityType}: {log.entityId}
                        </span>
                      )}
                    </div>
                    {processing && <div className="log-processing-status">
                      <span className={`status-badge ${recovered ? "status-approved" : attention ? "status-pending" : "log-info"}`}>{jotformProcessingLabel(processing)}</span>
                      {processing.nextRetryAt !== undefined && processing.state !== "processed" && <span>Submission delayed. Retrying automatically at {formatDateTime(processing.nextRetryAt)}.</span>}
                      {processing.state === "failed" && processing.nextRetryAt === undefined && <span>Check the integration, then use Retry a failed Jotform submission in Admin → Integrations.</span>}
                      {processing.recoveredAt !== undefined && recovered && <span>Processed successfully at {formatDateTime(processing.recoveredAt)}. Earlier entries are retained as history.</span>}
                    </div>}
                    {log.detailsJson && (
                      <details>
                        <summary>Technical details</summary>
                        <pre>{log.detailsJson}</pre>
                      </details>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
