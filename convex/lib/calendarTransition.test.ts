import { describe, expect, it } from "vitest";
import {
  needsCalendarAttemptCleanup,
  partitionCalendarCleanupCandidates,
} from "./calendarTransition";

describe("Calendar terminal-transition cleanup", () => {
  it("never treats a stored attempted event as safe to discard", () => {
    expect(
      needsCalendarAttemptCleanup({
        calendarAttemptedEvents: [
          { calendarId: "calendar-a", eventId: "possible-orphan" },
        ],
      }),
    ).toBe(true);
    expect(needsCalendarAttemptCleanup({})).toBe(false);
  });

  it("routes only clean peers to immediate auto-rejection", () => {
    const cleanPeer = {
      id: "clean",
      calendarAttemptedEvents: undefined,
    };
    const orphanCandidate = {
      id: "cleanup",
      calendarAttemptedEvents: [{ eventId: "event-1" }],
    };

    expect(
      partitionCalendarCleanupCandidates([
        cleanPeer,
        orphanCandidate,
      ]),
    ).toEqual({
      cleanupRequired: [orphanCandidate],
      safeToFinalize: [cleanPeer],
    });
  });
});
