import type { EditableOccurrence } from "./bookingEdit";

export type RecurrenceScope = "occurrence" | "following" | "series";
export type OccurrenceDetails = {
  responses?: Array<{ qid: string; value: string }>;
  eventName?: string;
  purpose?: string;
  ministry?: string;
};
export type ScopedOccurrence = EditableOccurrence & { details?: OccurrenceDetails };

export function scopedSequences(
  occurrences: readonly ScopedOccurrence[],
  scope: RecurrenceScope,
  selectedSequence?: number,
): Set<number> {
  if (scope === "series") return new Set(occurrences.map((item) => item.sequence));
  const selected = occurrences.find((item) => item.sequence === selectedSequence);
  if (!selected) throw new Error("Select a meeting from the current booking.");
  return new Set(occurrences.filter((item) => scope === "occurrence"
    ? item.sequence === selected.sequence
    : item.startAt >= selected.startAt).map((item) => item.sequence));
}

/** Apply a relative time shift to the selected tail; preceding exceptions survive. */
export function editScopedOccurrences(
  occurrences: readonly ScopedOccurrence[],
  scope: "occurrence" | "following",
  sequence: number,
  edit: { startAt: number; endAt: number; room: string; resolvedVenues: string[]; details: OccurrenceDetails },
): ScopedOccurrence[] {
  if (!Number.isFinite(edit.startAt) || !Number.isFinite(edit.endAt) || edit.endAt <= edit.startAt) {
    throw new Error("Choose a valid start and end time.");
  }
  const selected = occurrences.find((item) => item.sequence === sequence);
  const selectedIds = scopedSequences(occurrences, scope, sequence);
  const shift = edit.startAt - selected!.startAt;
  const duration = edit.endAt - edit.startAt;
  return occurrences.map((item) => selectedIds.has(item.sequence) ? {
    ...item,
    startAt: item.startAt + shift,
    endAt: item.startAt + shift + duration,
    room: edit.room,
    resolvedVenues: [...edit.resolvedVenues],
    details: { ...item.details, ...edit.details },
  } : { ...item }).sort((a, b) => a.startAt - b.startAt);
}
