export type BookingConflictSnapshot = {
  id: string;
  revision: number;
  updatedAt: number;
  calendarAvailabilityStatus?: "unchecked" | "available" | "conflict";
  calendarConflictSummary?: string;
  calendarSyncStatus?:
    "disabled" | "not_created" | "creating" | "synced" | "failed" | "conflict";
  conflictWarningBookingIds?: readonly string[];
};

export type BookingConflictTransition =
  | {
      key: string;
      kind: "calendar";
    }
  | {
      addedPendingConflictBookingIds: string[];
      addedPendingConflictCount: number;
      key: string;
      kind: "pending";
    };

export function isBookingCalendarProcessing(value: {
  calendarSyncStatus?: string;
}): boolean {
  return value.calendarSyncStatus === "creating";
}

export function claimPendingConflictEdges(
  bookingId: string,
  conflictBookingIds: readonly string[],
  claimedEdges: Set<string>,
): string[] {
  const unclaimedBookingIds: string[] = [];
  for (const conflictBookingId of conflictBookingIds) {
    const edgeKey = JSON.stringify(
      [bookingId, conflictBookingId].sort(),
    );
    if (claimedEdges.has(edgeKey)) continue;
    claimedEdges.add(edgeKey);
    unclaimedBookingIds.push(conflictBookingId);
  }
  return unclaimedBookingIds;
}

/**
 * Returns only a newly-observed conflict. Callers should prime their first
 * snapshot without displaying these results so existing conflicts do not
 * become stale notifications after a page load.
 */
export function detectBookingConflictTransition(
  previous: BookingConflictSnapshot | undefined,
  current: BookingConflictSnapshot,
): BookingConflictTransition | null {
  const currentCalendarConflict =
    current.calendarAvailabilityStatus === "conflict" &&
    current.calendarSyncStatus !== "creating";
  const previousCalendarConflict =
    previous?.calendarAvailabilityStatus === "conflict" &&
    previous.calendarSyncStatus !== "creating";
  const calendarConflictChanged =
    currentCalendarConflict &&
    (!previousCalendarConflict ||
      previous?.calendarConflictSummary !== current.calendarConflictSummary);

  if (calendarConflictChanged) {
    return {
      key: [
        current.id,
        "calendar",
        current.revision,
        current.updatedAt,
        current.calendarConflictSummary ?? "",
      ].join(":"),
      kind: "calendar",
    };
  }

  const previousWarnings = new Set(previous?.conflictWarningBookingIds ?? []);
  const currentWarnings = [
    ...new Set(current.conflictWarningBookingIds ?? []),
  ].sort();
  const addedPendingConflictBookingIds = currentWarnings.filter(
    (bookingId) => !previousWarnings.has(bookingId),
  );
  if (addedPendingConflictBookingIds.length === 0) return null;

  return {
    addedPendingConflictBookingIds,
    addedPendingConflictCount:
      addedPendingConflictBookingIds.length,
    key: [
      current.id,
      "pending",
      current.revision,
      currentWarnings.join(","),
    ].join(":"),
    kind: "pending",
  };
}
