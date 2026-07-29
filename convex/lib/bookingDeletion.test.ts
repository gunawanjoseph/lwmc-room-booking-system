import { describe, expect, it } from "vitest";
import {
  bookingDeletionInProgress,
  hasActiveEmailDeliveryLease,
  managedCalendarEventsExcluding,
  managedCalendarEventsForDeletion,
  mergeManagedCalendarEvents,
} from "./bookingDeletion";

describe("booking deletion helpers", () => {
  it("treats only an unexpired token lease as active", () => {
    expect(
      bookingDeletionInProgress(
        {
          deletionToken: "delete-token",
          deletionLeaseExpiresAt: 2_000,
        },
        1_999,
      ),
    ).toBe(true);
    expect(
      bookingDeletionInProgress(
        {
          deletionToken: "delete-token",
          deletionLeaseExpiresAt: 2_000,
        },
        2_000,
      ),
    ).toBe(false);
    expect(bookingDeletionInProgress({}, 1_000)).toBe(false);
  });

  it("blocks deletion only while an email worker owns a live send lease", () => {
    expect(
      hasActiveEmailDeliveryLease(
        [
          { status: "pending" },
          { status: "sending", leaseExpiresAt: 2_000 },
        ],
        1_999,
      ),
    ).toBe(true);
    expect(
      hasActiveEmailDeliveryLease(
        [{ status: "sending", leaseExpiresAt: 2_000 }],
        2_000,
      ),
    ).toBe(false);
    expect(
      hasActiveEmailDeliveryLease(
        [{ status: "sent", leaseExpiresAt: 3_000 }],
        2_000,
      ),
    ).toBe(false);
  });

  it("deduplicates completed and attempted Calendar references", () => {
    expect(
      managedCalendarEventsForDeletion(
        [
          {
            calendarId: "a@example.com",
            eventId: "event-a",
            targetVenue: "Ministry Centre A",
          },
        ],
        [
          {
            calendarId: "a@example.com",
            eventId: "event-a",
            targetVenue: "Ministry Centre A",
          },
          {
            calendarId: "b@example.com",
            eventId: "event-b",
            targetVenue: "Ministry Centre B",
          },
        ],
      ),
    ).toEqual([
      {
        calendarId: "a@example.com",
        eventId: "event-a",
        targetVenue: "Ministry Centre A",
      },
      {
        calendarId: "b@example.com",
        eventId: "event-b",
        targetVenue: "Ministry Centre B",
      },
    ]);
  });

  it("retains deterministic reconciliation candidates for deletion after a failed worker", () => {
    const stored = {
      calendarId: "a@example.com",
      eventId: "missing-original",
      targetVenue: "Ministry Centre A",
    };
    const replacement = {
      calendarId: "a@example.com",
      eventId: "deterministic-repair",
      targetVenue: "Ministry Centre A",
    };
    const attempted = mergeManagedCalendarEvents(
      undefined,
      [replacement],
      [replacement],
    );

    expect(attempted).toEqual([replacement]);
    expect(
      managedCalendarEventsForDeletion([stored], attempted),
    ).toEqual([stored, replacement]);
  });

  it("cleans only reconciliation candidates that were not selected as stored refs", () => {
    const replacementA = {
      calendarId: "a@example.com",
      eventId: "repair-a",
      targetVenue: "Ministry Centre A",
    };
    const replacementB = {
      calendarId: "b@example.com",
      eventId: "repair-b",
      targetVenue: "Ministry Centre B",
    };

    expect(
      managedCalendarEventsExcluding(
        [replacementA, replacementB, replacementA],
        [replacementA],
      ),
    ).toEqual([replacementB]);
  });
});
