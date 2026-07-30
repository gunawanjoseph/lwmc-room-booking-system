import { describe, expect, it } from "vitest";
import {
  availabilityFollowupKind,
  bookingEmailDependencyGate,
  canRevokeTokenForTerminalNotification,
  conflictAlertEpisodeKey,
  emailDependencyGate,
  encodeGmailMime,
  initialBookingEmailDelay,
  isCurrentConflictAlertPair,
  isCurrentStandaloneCalendarConflict,
  isRetryableGmailStatus,
  normalizeEmailAddress,
  requiresRequesterReceipt,
  urgentConflictDeliveryRecoveryMode,
  type BookingEmailKind,
  type ConflictAlertBookingState,
} from "./gmailMessage";

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("Gmail message safety", () => {
  it("normalizes valid addresses and rejects header injection", () => {
    expect(normalizeEmailAddress("  Person@Example.COM ")).toBe(
      "person@example.com",
    );
    expect(() =>
      normalizeEmailAddress(
        "requester@example.com\r\nBcc: attacker@example.com",
      ),
    ).toThrow("EMAIL_ADDRESS_INVALID");
    expect(() => normalizeEmailAddress("not-an-email")).toThrow(
      "EMAIL_ADDRESS_INVALID",
    );
  });

  it("encodes Unicode MIME content and a deterministic message ID", () => {
    const raw = encodeGmailMime({
      boundary: "roomops_test_boundary",
      from: "sender@example.com",
      to: "approver@example.com",
      subject: "Booking approved – Ministry Centre",
      messageKey: "delivery_123",
      text: "Approved for José.",
      html: "<p>Approved for José.</p>",
    });
    const message = decodeRaw(raw);

    expect(message).toContain("From: sender@example.com");
    expect(message).toContain("To: approver@example.com");
    expect(message).toContain(
      "Message-ID: <roomops-delivery_123@example.com>",
    );
    expect(message).toContain("Subject: =?UTF-8?B?");
    expect(message).toContain("Content-Transfer-Encoding: 8bit");
    expect(message).toContain("Approved for José.");
  });

  it("does not allow a subject to create another MIME header", () => {
    const message = decodeRaw(
      encodeGmailMime({
        boundary: "roomops_test_boundary",
        from: "sender@example.com",
        to: "approver@example.com",
        subject: "Booking\r\nBcc: attacker@example.com",
        messageKey: "delivery_456",
        text: "Test",
        html: "<p>Test</p>",
      }),
    );

    expect(message).toContain(
      "Subject: Booking Bcc: attacker@example.com",
    );
    expect(message).not.toContain(
      "\r\nBcc: attacker@example.com\r\n",
    );
  });

  it("retries only temporary Gmail HTTP failures", () => {
    expect(isRetryableGmailStatus(401)).toBe(true);
    expect(isRetryableGmailStatus(408)).toBe(true);
    expect(isRetryableGmailStatus(429)).toBe(true);
    expect(isRetryableGmailStatus(500)).toBe(true);
    expect(isRetryableGmailStatus(503)).toBe(true);
    expect(isRetryableGmailStatus(400)).toBe(false);
    expect(isRetryableGmailStatus(403)).toBe(false);
  });

  it("queues the requester receipt before every follow-up email", () => {
    expect(
      initialBookingEmailDelay("requester_submission_received"),
    ).toBe(0);
    expect(
      initialBookingEmailDelay("requester_unavailable"),
    ).toBeGreaterThan(0);
    expect(
      initialBookingEmailDelay("approver_request"),
    ).toBeGreaterThan(0);
  });

  it("withholds intake follow-ups until availability completes", () => {
    expect(
      availabilityFollowupKind({
        availabilityCheckPending: true,
        status: "pending",
      }),
    ).toBeNull();
    expect(
      availabilityFollowupKind({
        availabilityCheckPending: false,
        status: "pending",
      }),
    ).toBe("approver_request");
    expect(
      availabilityFollowupKind({
        availabilityCheckPending: false,
        status: "unavailable",
      }),
    ).toBe("requester_unavailable");
  });

  it("preserves the live token claim until the decision action completes", () => {
    const now = Date.now();
    expect(
      canRevokeTokenForTerminalNotification(
        {
          claimToken: "active-claim",
          claimExpiresAt: now + 60_000,
        },
        now,
      ),
    ).toBe(false);
    expect(
      canRevokeTokenForTerminalNotification(
        {
          claimToken: "expired-claim",
          claimExpiresAt: now - 1,
        },
        now,
      ),
    ).toBe(true);
    expect(
      canRevokeTokenForTerminalNotification(
        { usedAt: now },
        now,
      ),
    ).toBe(false);
  });

  it("requires a sent receipt before a follow-up may dispatch", () => {
    expect(emailDependencyGate("sent")).toBe("ready");
    expect(emailDependencyGate("pending")).toBe("wait");
    expect(emailDependencyGate("sending")).toBe("wait");
    expect(emailDependencyGate("failed")).toBe("block");
    expect(emailDependencyGate("cancelled")).toBe("block");
    expect(emailDependencyGate("blocked")).toBe("block");
    expect(emailDependencyGate(undefined)).toBe("block");
  });

  it("lets receipts and urgent conflict alerts dispatch immediately", () => {
    const kinds: BookingEmailKind[] = [
      "requester_submission_received",
      "requester_unavailable",
      "approver_request",
      "requester_approved",
      "requester_rejected",
      "approver_conflict_urgent",
    ];

    expect(kinds.filter((kind) => !requiresRequesterReceipt(kind))).toEqual([
      "requester_submission_received",
      "approver_conflict_urgent",
    ]);
  });

  it.each<BookingEmailKind>([
    "requester_unavailable",
    "approver_request",
    "requester_approved",
    "requester_rejected",
  ])("gates %s on the same booking's sent receipt", (kind) => {
    const receipt = {
      bookingId: "booking-1",
      kind: "requester_submission_received" as const,
      status: "sent" as const,
    };

    expect(
      bookingEmailDependencyGate(kind, "booking-1", receipt),
    ).toBe("ready");
    expect(
      bookingEmailDependencyGate(kind, "booking-2", receipt),
    ).toBe("block");
    expect(
      bookingEmailDependencyGate(kind, "booking-1", {
        ...receipt,
        kind: "requester_approved",
      }),
    ).toBe("block");
    expect(
      bookingEmailDependencyGate(kind, "booking-1", {
        ...receipt,
        status: "failed",
      }),
    ).toBe("block");
    expect(
      bookingEmailDependencyGate(kind, "booking-1", null),
    ).toBe("block");
  });

  it("does not delay an urgent admin conflict alert behind the requester receipt", () => {
    expect(
      bookingEmailDependencyGate(
        "approver_conflict_urgent",
        "booking-1",
        null,
      ),
    ).toBe("ready");
    expect(
      bookingEmailDependencyGate(
        "approver_conflict_urgent",
        "booking-1",
        {
          bookingId: "booking-1",
          kind: "requester_submission_received",
          status: "failed",
        },
      ),
    ).toBe("ready");
  });

  it("revives only nonterminal urgent conflict deliveries from the old dependency gate", () => {
    expect(
      urgentConflictDeliveryRecoveryMode("pending", true),
    ).toBe("requeue");
    expect(
      urgentConflictDeliveryRecoveryMode("blocked", true),
    ).toBe("requeue");
    expect(
      urgentConflictDeliveryRecoveryMode("sending", true),
    ).toBe("clear_dependency");
    expect(
      urgentConflictDeliveryRecoveryMode("sending", false),
    ).toBe("none");
    expect(
      urgentConflictDeliveryRecoveryMode("pending", false),
    ).toBe("none");
    expect(
      urgentConflictDeliveryRecoveryMode("blocked", false),
    ).toBe("none");
    for (const status of [
      "sent",
      "failed",
      "cancelled",
    ] as const) {
      expect(
        urgentConflictDeliveryRecoveryMode(status, true),
      ).toBe("none");
    }
  });

  it("accepts only live reciprocal pending conflict warnings", () => {
    const primary: ConflictAlertBookingState = {
      id: "booking-1",
      status: "pending",
      conflictWarningBookingIds: ["booking-2"],
    };
    const related: ConflictAlertBookingState = {
      id: "booking-2",
      status: "pending",
      conflictWarningBookingIds: ["booking-1"],
    };

    expect(
      isCurrentConflictAlertPair(primary, related, 1_000),
    ).toBe(true);
    expect(
      isCurrentConflictAlertPair(
        primary,
        { ...related, conflictWarningBookingIds: [] },
        1_000,
      ),
    ).toBe(false);
  });

  it("accepts both orientations of a current decided conflict", () => {
    const approved: ConflictAlertBookingState = {
      id: "approved",
      status: "approved",
    };
    const unavailable: ConflictAlertBookingState = {
      id: "unavailable",
      status: "unavailable",
      conflictBookingId: "approved",
    };

    expect(
      isCurrentConflictAlertPair(unavailable, approved, 1_000),
    ).toBe(true);
    expect(
      isCurrentConflictAlertPair(approved, unavailable, 1_000),
    ).toBe(true);
  });

  it("rejects obsolete, staged, and deleting conflict pairs", () => {
    const primary: ConflictAlertBookingState = {
      id: "booking-1",
      status: "pending",
      conflictWarningBookingIds: ["booking-2"],
    };
    const related: ConflictAlertBookingState = {
      id: "booking-2",
      status: "pending",
      conflictWarningBookingIds: ["booking-1"],
    };

    expect(
      isCurrentConflictAlertPair(
        primary,
        { ...related, status: "rejected" },
        1_000,
      ),
    ).toBe(false);
    expect(
      isCurrentConflictAlertPair(
        { ...primary, availabilityCheckPending: true },
        related,
        1_000,
      ),
    ).toBe(false);
    expect(
      isCurrentConflictAlertPair(
        primary,
        {
          ...related,
          deletionToken: "delete",
          deletionLeaseExpiresAt: 1_001,
        },
        1_000,
      ),
    ).toBe(false);
    expect(
      isCurrentConflictAlertPair(
        primary,
        {
          ...related,
          deletionToken: "expired",
          deletionLeaseExpiresAt: 1_000,
        },
        1_000,
      ),
    ).toBe(true);
  });

  it("recognizes a live Google-only Calendar conflict", () => {
    const conflict: ConflictAlertBookingState = {
      id: "booking-1",
      status: "unavailable",
      calendarAvailabilityStatus: "conflict",
    };

    expect(
      isCurrentStandaloneCalendarConflict(conflict, 1_000),
    ).toBe(true);
    expect(
      isCurrentStandaloneCalendarConflict(
        { ...conflict, status: "approved" },
        1_000,
      ),
    ).toBe(true);
    expect(
      isCurrentStandaloneCalendarConflict(
        { ...conflict, conflictBookingId: "booking-2" },
        1_000,
      ),
    ).toBe(false);
    expect(
      isCurrentStandaloneCalendarConflict(
        {
          ...conflict,
          deletionToken: "delete",
          deletionLeaseExpiresAt: 2_000,
        },
        1_000,
      ),
    ).toBe(false);
  });

  it("keeps conflict-delivery retries in one persisted episode idempotent", () => {
    const pendingConflict: ConflictAlertBookingState = {
      id: "booking-1",
      status: "pending",
      revision: 7,
      conflictWarningBookingIds: ["booking-2", "booking-3"],
    };

    expect(
      conflictAlertEpisodeKey(pendingConflict, [
        "booking-3",
        "booking-2",
        "booking-2",
      ]),
    ).toBe(
      conflictAlertEpisodeKey(pendingConflict, [
        "booking-2",
        "booking-3",
      ]),
    );
  });

  it("distinguishes later RoomOps and Calendar conflict episodes", () => {
    const pendingConflict: ConflictAlertBookingState = {
      id: "booking-1",
      status: "pending",
      revision: 7,
    };
    expect(
      conflictAlertEpisodeKey(pendingConflict, ["booking-2"]),
    ).not.toBe(
      conflictAlertEpisodeKey(
        { ...pendingConflict, revision: 8 },
        ["booking-2"],
      ),
    );

    const calendarConflict: ConflictAlertBookingState = {
      id: "booking-1",
      status: "approved",
      revision: 8,
      calendarAvailabilityStatus: "conflict",
      calendarSyncAttempts: 2,
    };
    expect(
      conflictAlertEpisodeKey(calendarConflict, []),
    ).not.toBe(
      conflictAlertEpisodeKey(
        { ...calendarConflict, calendarSyncAttempts: 3 },
        [],
      ),
    );
    expect(
      conflictAlertEpisodeKey(calendarConflict, []),
    ).not.toBe(
      conflictAlertEpisodeKey(
        { ...calendarConflict, status: "unavailable" },
        [],
      ),
    );
  });
});
