import { describe, expect, it } from "vitest";
import {
  availabilityFollowupKind,
  bookingEmailDependencyGate,
  canRevokeTokenForTerminalNotification,
  emailDependencyGate,
  encodeGmailMime,
  initialBookingEmailDelay,
  isRetryableGmailStatus,
  normalizeEmailAddress,
  requiresRequesterReceipt,
  type BookingEmailKind,
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

  it("classifies every booking email except the receipt as a follow-up", () => {
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
    ]);
  });

  it.each<BookingEmailKind>([
    "requester_unavailable",
    "approver_request",
    "requester_approved",
    "requester_rejected",
    "approver_conflict_urgent",
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
});
