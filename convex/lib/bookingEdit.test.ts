import { describe, expect, it } from "vitest";
import {
  applyOccurrenceEdit,
  conflictIdsAcknowledged,
  partitionManagedEventsForFutureReplacement,
} from "./bookingEdit";

describe("admin booking edits", () => {
  it("edits and reorders one occurrence without changing its peers", () => {
    expect(
      applyOccurrenceEdit(
        [
          { sequence: 0, startAt: 100, endAt: 200 },
          { sequence: 1, startAt: 300, endAt: 400 },
        ],
        1,
        {
          startAt: 50,
          endAt: 75,
          room: "Board Room",
          defaultRoom: "Pastor Office",
          resolvedVenues: ["Board Room"],
        },
      ),
    ).toEqual([
      {
        sequence: 0,
        startAt: 50,
        endAt: 75,
        room: "Board Room",
        resolvedVenues: ["Board Room"],
      },
      { sequence: 1, startAt: 100, endAt: 200 },
    ]);
  });

  it("requires the acknowledgement to match the current conflict set", () => {
    expect(conflictIdsAcknowledged(["b", "a"], ["a", "b", "b"])).toBe(
      true,
    );
    expect(conflictIdsAcknowledged(["a", "b"], ["a"])).toBe(false);
    expect(conflictIdsAcknowledged(["a"], ["a", "b"])).toBe(false);
  });

  it("keeps past occurrence events and replaces future or legacy events", () => {
    const events = [
      {
        calendarId: "calendar",
        eventId: "past",
        targetVenue: "Board Room",
        startAt: 99,
      },
      {
        calendarId: "calendar",
        eventId: "future",
        targetVenue: "Board Room",
        startAt: 101,
      },
      {
        calendarId: "calendar",
        eventId: "legacy-series",
        targetVenue: "Board Room",
      },
    ];
    expect(partitionManagedEventsForFutureReplacement(events, 100)).toEqual({
      keep: [events[0]],
      replace: [events[1], events[2]],
    });
  });
});
