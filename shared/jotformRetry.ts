// Offsets from the first attempt in each automatic/manual processing run.
export const JOTFORM_ATTEMPT_OFFSETS_MS = [0, 1, 6, 15, 30, 60].map(minutes => minutes * 60_000);
export const JOTFORM_ATTENTION_AFTER_MS = 15 * 60_000;

export function nextJotformRetryAt(startedAt: number, attempts: number, now: number): number | undefined {
  const offset = JOTFORM_ATTEMPT_OFFSETS_MS[attempts];
  return offset === undefined ? undefined : Math.max(now, startedAt + offset);
}

export type JotformProcessingStatus = {
  state: "received" | "processing" | "processed" | "failed";
  attempts: number;
  nextRetryAt?: number;
  attentionNotifiedAt?: number;
  recoveredAt?: number;
};

export function jotformProcessingLabel(status: JotformProcessingStatus): string {
  if (status.state === "processed") return status.recoveredAt !== undefined ? "Recovered after retry" : "Processed";
  if (status.state === "failed" && status.nextRetryAt === undefined) return "Needs attention";
  if (status.attentionNotifiedAt !== undefined) return "Delayed · needs attention";
  if (status.nextRetryAt !== undefined) return "Retrying automatically";
  return status.state === "processing" ? "Processing" : "Queued";
}
