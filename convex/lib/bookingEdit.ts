export type EditableOccurrence = {
  sequence: number;
  startAt: number;
  endAt: number;
  room?: string;
  resolvedVenues?: string[];
};

export type ManagedEventForEdit = {
  calendarId: string;
  eventId: string;
  targetVenue: string;
  startAt?: number;
};

/**
 * Applies an exception to one concrete occurrence without changing the
 * recurrence rule that generated the rest of the series.
 */
export function applyOccurrenceEdit(
  occurrences: readonly EditableOccurrence[],
  occurrenceSequence: number,
  edit: {
    startAt: number;
    endAt: number;
    room: string;
    defaultRoom: string;
    resolvedVenues: string[];
  },
): EditableOccurrence[] {
  if (
    !Number.isInteger(occurrenceSequence) ||
    !Number.isFinite(edit.startAt) ||
    !Number.isFinite(edit.endAt) ||
    edit.endAt <= edit.startAt
  ) {
    throw new Error("BOOKING_OCCURRENCE_EDIT_INVALID");
  }
  const target = occurrences.find(
    (occurrence) => occurrence.sequence === occurrenceSequence,
  );
  if (!target) {
    throw new Error("BOOKING_OCCURRENCE_NOT_FOUND");
  }

  return occurrences
    .map((occurrence) =>
      occurrence.sequence === occurrenceSequence
        ? {
            ...occurrence,
            startAt: edit.startAt,
            endAt: edit.endAt,
            room:
              edit.room === edit.defaultRoom ? undefined : edit.room,
            resolvedVenues: [...edit.resolvedVenues],
          }
        : { ...occurrence },
    )
    .sort(
      (first, second) =>
        first.startAt - second.startAt || first.endAt - second.endAt,
    )
    .map((occurrence, sequence) => ({ ...occurrence, sequence }));
}

export function conflictIdsAcknowledged(
  actualIds: readonly string[],
  acknowledgedIds: readonly string[],
): boolean {
  const actual = [...new Set(actualIds)].sort();
  const acknowledged = [...new Set(acknowledgedIds)].sort();
  return (
    actual.length === acknowledged.length &&
    actual.every((id, index) => id === acknowledged[index])
  );
}

/**
 * Legacy recurring parents do not have startAt metadata, so they must be
 * replaced as a whole. New occurrence events retain past history and only
 * replace events that have not ended.
 */
export function partitionManagedEventsForFutureReplacement<
  Event extends ManagedEventForEdit,
>(
  events: readonly Event[],
  now: number,
): { keep: Event[]; replace: Event[] } {
  const keep: Event[] = [];
  const replace: Event[] = [];
  for (const event of events) {
    if (event.startAt !== undefined && event.startAt < now) {
      keep.push(event);
    } else {
      replace.push(event);
    }
  }
  return { keep, replace };
}
