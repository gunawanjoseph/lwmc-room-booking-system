export type ManagedCalendarEventReference = {
  calendarId: string;
  eventId: string;
  htmlLink?: string;
  targetVenue: string;
  occurrenceSequence?: number;
  startAt?: number;
  endAt?: number;
};

type BookingDeletionLease = {
  deletionToken?: string;
  deletionLeaseExpiresAt?: number;
};

type EmailDeliveryLease = {
  status: string;
  leaseExpiresAt?: number;
};

export function bookingDeletionInProgress(
  booking: BookingDeletionLease,
  now: number,
): boolean {
  return Boolean(
    booking.deletionToken &&
      (booking.deletionLeaseExpiresAt ?? 0) > now,
  );
}

export function hasActiveEmailDeliveryLease(
  deliveries: readonly EmailDeliveryLease[],
  now: number,
): boolean {
  return deliveries.some(
    (delivery) =>
      delivery.status === "sending" &&
      (delivery.leaseExpiresAt ?? 0) > now,
  );
}

/**
 * Calendar creation can leave the same deterministic event reference in both
 * the completed and attempted arrays. Cleanup should visit each Google event
 * exactly once while preserving the most complete stored reference.
 */
export function managedCalendarEventsForDeletion(
  calendarEvents:
    | readonly ManagedCalendarEventReference[]
    | undefined,
  calendarAttemptedEvents:
    | readonly ManagedCalendarEventReference[]
    | undefined,
): ManagedCalendarEventReference[] {
  return mergeManagedCalendarEvents(
    calendarEvents,
    calendarAttemptedEvents,
  );
}

export function mergeManagedCalendarEvents(
  ...eventGroups: Array<
    readonly ManagedCalendarEventReference[] | undefined
  >
): ManagedCalendarEventReference[] {
  const unique = new Map<string, ManagedCalendarEventReference>();
  for (const event of eventGroups.flatMap((events) => events ?? [])) {
    const key = `${event.calendarId}\u0000${event.eventId}`;
    unique.set(key, { ...unique.get(key), ...event });
  }
  return [...unique.values()];
}

/**
 * Reconciliation may create a deterministic replacement for a missing stored
 * event. Once the final stored references are known, only attempted events
 * that were not selected need orphan cleanup.
 */
export function managedCalendarEventsExcluding(
  candidates:
    | readonly ManagedCalendarEventReference[]
    | undefined,
  retained:
    | readonly ManagedCalendarEventReference[]
    | undefined,
): ManagedCalendarEventReference[] {
  const retainedKeys = new Set(
    (retained ?? []).map(
      (event) => `${event.calendarId}\u0000${event.eventId}`,
    ),
  );
  return mergeManagedCalendarEvents(candidates).filter(
    (event) =>
      !retainedKeys.has(`${event.calendarId}\u0000${event.eventId}`),
  );
}
