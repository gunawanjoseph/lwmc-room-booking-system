import type { Id } from "../_generated/dataModel";

export type EmailDecisionCredential = {
  claimExpiresAt?: number;
  claimToken?: string;
  expiresAt: number;
  revokedAt?: number;
  usedAt?: number;
};

export type EmailDecisionCredentialState =
  | "actionable"
  | "invalid"
  | "terminal";

export type EmailDecisionBooking = {
  _id: Id<"bookings">;
  requesterName: string;
  requesterEmail: string;
  room: string;
  startAt: number;
  endAt: number;
  timezone: string;
  eventName?: string;
  purpose?: string;
  ministry?: string;
  recurrenceFrequency?:
    | "none"
    | "daily"
    | "weekly_same_day"
    | "biweekly_same_day"
    | "monthly_same_day"
    | "monthly_same_date";
  recurrenceCount?: number;
  recurrenceUntilAt?: number;
  occurrences?: Array<{
    sequence: number;
    startAt: number;
    endAt: number;
  }>;
  conflictWarningBookingIds?: Id<"bookings">[];
  availabilityCheckPending?: boolean;
  status: "pending" | "approved" | "rejected" | "unavailable";
};

export type PublicEmailDecisionView =
  | { state: "invalid" }
  | { state: "terminal" }
  | {
      state: "actionable";
      claimed: boolean;
      booking: {
        _id: Id<"bookings">;
        requesterName: string;
        requesterEmail: string;
        room: string;
        startAt: number;
        endAt: number;
        timezone: string;
        eventName?: string;
        purpose?: string;
        ministry?: string;
        recurrenceFrequency:
          | "none"
          | "daily"
          | "weekly_same_day"
          | "biweekly_same_day"
          | "monthly_same_day"
          | "monthly_same_date";
        recurrenceCount: number;
        recurrenceUntilAt?: number;
        occurrences: Array<{
          sequence: number;
          startAt: number;
          endAt: number;
        }>;
        conflictWarningCount: number;
      };
    };

/**
 * Classifies the bearer credential before any booking record is loaded.
 * Invalid credentials deliberately share one public state so an attacker
 * cannot distinguish expiration, revocation, or approver deactivation.
 */
export function emailDecisionCredentialState(
  credential: EmailDecisionCredential,
  input: { approverActive: boolean; now: number },
): EmailDecisionCredentialState {
  if (
    credential.expiresAt <= input.now ||
    credential.revokedAt !== undefined ||
    !input.approverActive
  ) {
    return "invalid";
  }
  if (credential.usedAt !== undefined) return "terminal";
  return "actionable";
}

export function emailDecisionBookingState(
  booking:
    | Pick<
        EmailDecisionBooking,
        "availabilityCheckPending" | "status"
      >
    | null
    | undefined,
): EmailDecisionCredentialState {
  if (!booking) return "invalid";
  if (booking.availabilityCheckPending === true) return "invalid";
  return booking.status === "pending" ? "actionable" : "terminal";
}

/**
 * Builds the only response that may contain booking/requester information.
 * Callers must first establish an actionable credential and a pending booking.
 */
export function actionableEmailDecisionView(
  credential: EmailDecisionCredential,
  booking: EmailDecisionBooking,
  now: number,
): Extract<PublicEmailDecisionView, { state: "actionable" }> {
  const occurrences =
    booking.occurrences ?? [
      {
        sequence: 0,
        startAt: booking.startAt,
        endAt: booking.endAt,
      },
    ];
  return {
    state: "actionable",
    claimed:
      credential.claimToken !== undefined &&
      (credential.claimExpiresAt ?? 0) > now,
    booking: {
      _id: booking._id,
      requesterName: booking.requesterName,
      requesterEmail: booking.requesterEmail,
      room: booking.room,
      startAt: booking.startAt,
      endAt: booking.endAt,
      timezone: booking.timezone,
      eventName: booking.eventName,
      purpose: booking.purpose,
      ministry: booking.ministry,
      recurrenceFrequency: booking.recurrenceFrequency ?? "none",
      recurrenceCount:
        booking.recurrenceCount ?? occurrences.length,
      recurrenceUntilAt: booking.recurrenceUntilAt,
      occurrences,
      conflictWarningCount:
        booking.conflictWarningBookingIds?.length ?? 0,
    },
  };
}
