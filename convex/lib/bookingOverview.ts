export type ConflictOverviewBooking = {
  _id: string;
  status: "pending" | "approved" | "rejected" | "unavailable" | "cancelled";
  conflictBookingId?: string;
  conflictWarningBookingIds?: readonly string[];
  calendarAvailabilityStatus?: "unchecked" | "available" | "conflict";
};

export type ConflictOverview = {
  detectedConflictRequests: number;
  pendingConflictRequests: number;
  pendingConflictPairs: number;
  unavailableConflictRequests: number;
};

/**
 * Counts requests, rather than warning edges, so reciprocal pending warnings
 * and an unavailable request's local/Calendar markers cannot double count the
 * same booking.
 */
export function calculateConflictOverview(
  bookings: readonly ConflictOverviewBooking[],
): ConflictOverview {
  const detectedRequestIds = new Set<string>();
  const pendingConflictRequestIds = new Set<string>();
  const unavailableConflictRequestIds = new Set<string>();
  const pendingIds = new Set(
    bookings
      .filter((booking) => booking.status === "pending")
      .map((booking) => booking._id),
  );
  const pairs = new Set<string>();

  for (const booking of bookings) {
    if (
      booking.status === "pending" &&
      (booking.conflictWarningBookingIds?.length ?? 0) > 0
    ) {
      pendingConflictRequestIds.add(booking._id);
      detectedRequestIds.add(booking._id);
      for (const peerId of booking.conflictWarningBookingIds ?? []) {
        if (peerId === booking._id || !pendingIds.has(peerId)) continue;
        pairs.add([booking._id, peerId].sort().join(":"));
      }
    }

    if (
      booking.status === "unavailable" &&
      (booking.calendarAvailabilityStatus === "conflict" ||
        booking.conflictBookingId !== undefined)
    ) {
      unavailableConflictRequestIds.add(booking._id);
      detectedRequestIds.add(booking._id);
    }
  }

  return {
    detectedConflictRequests: detectedRequestIds.size,
    pendingConflictRequests: pendingConflictRequestIds.size,
    pendingConflictPairs: pairs.size,
    unavailableConflictRequests: unavailableConflictRequestIds.size,
  };
}
