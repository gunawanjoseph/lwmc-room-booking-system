import { describe, expect, it, vi } from "vitest";
import {
  BOOKABLE_GOOGLE_CALENDAR_VENUES,
  GOOGLE_CALENDAR_VENUES,
  GoogleCalendarClient,
  buildGoogleCalendarEventText,
  buildGoogleCalendarPrivateProperties,
  buildGoogleCalendarTitle,
  calendarTargetsForVenue,
  deterministicGoogleCalendarEventId,
  parseGoogleServiceAccount,
  parseGoogleServiceAccountBase64,
  parseGoogleCalendarVenueMap,
  resolveBookableVenueSelection,
  resolveVenueSelection,
  type GoogleCalendarEventInput,
} from "./googleCalendar";

const configuredCalendars = Object.fromEntries(
  GOOGLE_CALENDAR_VENUES.map((venue, index) => [
    venue,
    `calendar-${index + 1}@example.test`,
  ]),
);

const now = Date.parse("2026-01-01T00:00:00.000Z");
const unusedCredentials = {
  clientEmail: "roomops@example.test",
  privateKey: "not-used-because-tests-install-a-cached-token",
  tokenUri: "https://oauth2.googleapis.com/token",
};

function authenticatedClient(
  fetchImplementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  options: {
    maxAttempts?: number;
    requestTimeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): GoogleCalendarClient {
  const client = new GoogleCalendarClient({
    credentials: unusedCredentials,
    fetch: fetchImplementation,
    maxAttempts: options.maxAttempts,
    now: () => now,
    requestTimeoutMs: options.requestTimeoutMs,
    sleep: options.sleep,
  });
  Reflect.set(client, "accessToken", {
    expiresAt: now + 3_600_000,
    value: "cached-test-token",
  });
  return client;
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("Google Calendar venue configuration", () => {
  it("parses a complete venue-to-calendar map without hardcoded IDs", () => {
    const parsed = parseGoogleCalendarVenueMap(
      JSON.stringify(configuredCalendars),
    );

    expect(parsed["Board Room"]).toEqual([
      "calendar-1@example.test",
    ]);
    expect(parsed["Shema Space"]).toEqual([
      "calendar-10@example.test",
    ]);
  });

  it("accepts Center spelling aliases but detects incomplete maps", () => {
    const withAmericanSpelling: Record<string, string> = {
      ...configuredCalendars,
      "Ministry Center A":
        configuredCalendars["Ministry Centre A"],
    };
    delete withAmericanSpelling["Ministry Centre A"];

    expect(
      parseGoogleCalendarVenueMap(
        JSON.stringify(withAmericanSpelling),
      )["Ministry Centre A"],
    ).toEqual(["calendar-4@example.test"]);

    expect(() =>
      parseGoogleCalendarVenueMap(
        JSON.stringify({ "Board Room": "board@example.test" }),
      ),
    ).toThrow("GOOGLE_CALENDAR_VENUE_MAP_INCOMPLETE");
  });

  it("rejects malformed, ambiguous, and duplicate configuration", () => {
    expect(() =>
      parseGoogleCalendarVenueMap(undefined),
    ).toThrow("GOOGLE_CALENDAR_VENUE_MAP_MISSING");
    expect(() => parseGoogleCalendarVenueMap("{not-json")).toThrow(
      "GOOGLE_CALENDAR_VENUE_MAP_INVALID",
    );
    expect(() =>
      parseGoogleCalendarVenueMap(
        JSON.stringify({
          "Ministry Centre A & B": "combined@example.test",
        }),
        { requireAll: false },
      ),
    ).toThrow("GOOGLE_CALENDAR_VENUE_MAP_INVALID");
    expect(() =>
      parseGoogleCalendarVenueMap(
        JSON.stringify({
          "Board Room": "same@example.test",
          "Shema Space": "same@example.test",
        }),
        { requireAll: false },
      ),
    ).toThrow("GOOGLE_CALENDAR_VENUE_MAP_INVALID");
    expect(() =>
      parseGoogleCalendarVenueMap(
        JSON.stringify({
          "Board Room": ["one", "two", "three", "four"],
        }),
        { requireAll: false },
      ),
    ).toThrow("GOOGLE_CALENDAR_VENUE_MAP_INVALID");
  });

  it("fails closed for malformed service-account JSON and base64", () => {
    expect(() => parseGoogleServiceAccount(undefined)).toThrow(
      "GOOGLE_SERVICE_ACCOUNT_MISSING",
    );
    expect(() =>
      parseGoogleServiceAccount(
        JSON.stringify({
          client_email: "roomops@example.test",
          private_key:
            "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
          token_uri: "https://example.test/token",
        }),
      ),
    ).toThrow("GOOGLE_SERVICE_ACCOUNT_INVALID");
    expect(() =>
      parseGoogleServiceAccountBase64("%%%not-base64%%%"),
    ).toThrow("GOOGLE_SERVICE_ACCOUNT_INVALID");
    expect(() =>
      parseGoogleServiceAccountBase64(btoa("not JSON")),
    ).toThrow("GOOGLE_SERVICE_ACCOUNT_INVALID");
  });
});

describe("Google Calendar venue selection", () => {
  it("exposes only the seven venues that still accept bookings", () => {
    expect(BOOKABLE_GOOGLE_CALENDAR_VENUES).toEqual([
      "Board Room",
      "Counselling / Music Room",
      "L1 Ministry Space",
      "Ministry Centre A",
      "Ministry Centre B",
      "Ministry Centre C",
      "Shema Space",
    ]);
  });

  it("keeps retired office venues resolvable for historical cleanup but not new bookings", () => {
    for (const venue of [
      "Office L2 Main Area",
      "Church Office L2 Main Area",
      "L2 Main Area",
      "Pastor Office",
      "PIC Office",
    ]) {
      expect(resolveVenueSelection(venue).venues).toHaveLength(1);
      expect(() => resolveBookableVenueSelection(venue)).toThrow(
        "GOOGLE_CALENDAR_VENUE_NOT_BOOKABLE",
      );
    }
    expect(
      resolveBookableVenueSelection("Ministry Centre A & B"),
    ).toEqual({
      displayName: "Ministry Centre A & B",
      venues: ["Ministry Centre A", "Ministry Centre B"],
    });
  });

  it("normalizes Jotform numbering, quotes, and venue aliases", () => {
    expect(
      resolveVenueSelection(
        '2. "Church Office L1 Ministry Space"',
      ),
    ).toEqual({
      displayName: "L1 Ministry Space",
      venues: ["L1 Ministry Space"],
    });
    expect(resolveVenueSelection("Counseling / Music Room")).toEqual({
      displayName: "Counselling / Music Room",
      venues: ["Counselling / Music Room"],
    });
  });

  it("fans Ministry Center A&B out to both calendars in order", () => {
    const venueMap = parseGoogleCalendarVenueMap(
      JSON.stringify(configuredCalendars),
    );

    expect(
      calendarTargetsForVenue("Ministry Center A&B", venueMap),
    ).toEqual([
      {
        calendarId: "calendar-4@example.test",
        requestedVenue: "Ministry Centre A & B",
        venue: "Ministry Centre A",
      },
      {
        calendarId: "calendar-5@example.test",
        requestedVenue: "Ministry Centre A & B",
        venue: "Ministry Centre B",
      },
    ]);
  });

  it("fans Ministry Centre ABC out to all three concrete calendars", () => {
    const venueMap = parseGoogleCalendarVenueMap(
      JSON.stringify(configuredCalendars),
    );

    expect(
      calendarTargetsForVenue("9. Ministry Centre ABC", venueMap),
    ).toEqual([
      {
        calendarId: "calendar-4@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre A",
      },
      {
        calendarId: "calendar-5@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre B",
      },
      {
        calendarId: "calendar-6@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre C",
      },
    ]);

    expect(
      calendarTargetsForVenue("Ministry Centre A, B & C", venueMap),
    ).toEqual([
      {
        calendarId: "calendar-4@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre A",
      },
      {
        calendarId: "calendar-5@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre B",
      },
      {
        calendarId: "calendar-6@example.test",
        requestedVenue: "Ministry Centre A, B & C",
        venue: "Ministry Centre C",
      },
    ]);
  });

  it("accepts the supported ABC punctuation aliases", () => {
    for (const alias of [
      "Ministry Centre A, B, & C",
      "Ministry Centre A&B&C",
      "Ministry Center A, B & C",
    ]) {
      expect(resolveVenueSelection(alias)).toEqual({
        displayName: "Ministry Centre A, B & C",
        venues: [
          "Ministry Centre A",
          "Ministry Centre B",
          "Ministry Centre C",
        ],
      });
    }
  });
});

describe("Google Calendar event metadata", () => {
  it("builds the exact four-block description for a physical venue", () => {
    expect(
      buildGoogleCalendarEventText({
        eventName: "Disciple 1 Course",
        ministry: "Discipleship & Nurture",
        purpose: "Weekly discipleship course",
        requesterName: "George Lam",
        venue: "Ministry Centre B",
      }),
    ).toEqual({
      description: [
        "<b>Ministry:</b>",
        "Discipleship &amp; Nurture",
        "",
        "<b>Event Name or Purpose of Booking:</b>",
        "Disciple 1 Course",
        "",
        "<b>Name:</b>",
        "George Lam",
        "",
        "<b>Venue:</b>",
        "Ministry Centre B",
      ].join("<br>"),
      location: "Ministry Centre B",
      summary:
        "[Ministry Centre B] Disciple 1 Course Discipleship & Nurture",
    });
  });

  it("falls back to purpose and preserves the description blocks", () => {
    expect(
      buildGoogleCalendarEventText({
        purpose: "Leadership planning",
        requesterName: "Joseph",
        venue: "Board Room",
      }),
    ).toEqual({
      description: [
        "<b>Ministry:</b>",
        "-",
        "",
        "<b>Event Name or Purpose of Booking:</b>",
        "Leadership planning",
        "",
        "<b>Name:</b>",
        "Joseph",
        "",
        "<b>Venue:</b>",
        "Board Room",
      ].join("<br>"),
      location: "Board Room",
      summary: "[Board Room] Leadership planning",
    });
  });

  it("escapes form values before rendering rich Calendar descriptions", () => {
    const description = buildGoogleCalendarEventText({
      eventName: "<script>alert('x')</script>",
      ministry: "Care & Support",
      requesterName: 'George <Admin> "Lam"',
      venue: "Board Room",
    }).description;

    expect(description).toContain(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
    expect(description).toContain("Care &amp; Support");
    expect(description).toContain(
      "George &lt;Admin&gt; &quot;Lam&quot;",
    );
  });

  it("uses event name before purpose in the requested title format", () => {
    expect(
      buildGoogleCalendarTitle({
        eventName: "Leaders Meeting",
        ministry: "Youth Ministry",
        purpose: "Planning",
        venue: "Board Room",
      }),
    ).toBe("[Board Room] Leaders Meeting Youth Ministry");

    expect(
      buildGoogleCalendarTitle({
        ministry: "Worship Ministry",
        purpose: "Rehearsal",
        venue: "Ministry Center A & B",
      }),
    ).toBe(
      "[Ministry Centre A & B] Rehearsal Worship Ministry",
    );
  });

  it("builds deterministic private properties for reconciliation", () => {
    expect(
      buildGoogleCalendarPrivateProperties({
        bookingId: "booking_123",
        requestedVenue: "Ministry Center A&B",
        sourceSubmissionId: "submission_456",
        targetVenue: "Ministry Centre A",
      }),
    ).toEqual({
      roomopsBookingId: "booking_123",
      roomopsManaged: "true",
      roomopsRequestedVenue: "Ministry Centre A & B",
      roomopsSchemaVersion: "1",
      roomopsSubmissionId: "submission_456",
      roomopsTargetVenue: "Ministry Centre A",
    });
  });

  it("uses stable, target-specific Google event IDs", async () => {
    const input = {
      bookingId: "booking_123",
      calendarId: "calendar-a@example.test",
      venue: "Ministry Centre A" as const,
    };
    const first = await deterministicGoogleCalendarEventId(input);
    const second = await deterministicGoogleCalendarEventId(input);
    const otherCalendar =
      await deterministicGoogleCalendarEventId({
        ...input,
        calendarId: "calendar-b@example.test",
      });
    const otherVenue = await deterministicGoogleCalendarEventId({
      ...input,
      venue: "Ministry Centre B",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^roomops[0-9a-f]{48}$/);
    expect(otherCalendar).not.toBe(first);
    expect(otherVenue).not.toBe(first);
  });
});

describe("Google Calendar network behavior", () => {
  it("reads calendar metadata and effective access", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        accessRole: "writer",
        id: "board@example.test",
        summary: "Board Room",
        timeZone: "Asia/Singapore",
      }),
    );
    const client = authenticatedClient(fetchMock);

    await expect(
      client.getCalendarAccess("board@example.test"),
    ).resolves.toEqual({
      accessRole: "writer",
      calendarId: "board@example.test",
      summary: "Board Room",
      timeZone: "Asia/Singapore",
    });
  });

  it("adds a shared calendar to the service-account calendar list when needed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          accessRole: "writer",
          id: "board@example.test",
          summary: "Board Room",
        }),
      );
    const client = authenticatedClient(fetchMock);

    await expect(
      client.getCalendarAccess("board@example.test"),
    ).resolves.toMatchObject({
      accessRole: "writer",
      calendarId: "board@example.test",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/users/me/calendarList"),
      expect.objectContaining({
        body: JSON.stringify({ id: "board@example.test" }),
        method: "POST",
      }),
    );
  });

  it("matches free/busy periods only to concrete recurring occurrences", async () => {
    const calendarId = "calendar-1@example.test";
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        void _input;
        requestBodies.push(
          JSON.parse(String(_init?.body)) as Record<string, unknown>,
        );
        return jsonResponse({
          calendars: {
            [calendarId]: {
              busy: [
                // This is inside the broad first-to-last range, but it is not
                // one of the actual weekly booking occurrences.
                {
                  start: "2026-01-04T09:15:00.000Z",
                  end: "2026-01-04T09:45:00.000Z",
                },
                {
                  start: "2026-01-08T09:30:00.000Z",
                  end: "2026-01-08T10:30:00.000Z",
                },
              ],
            },
          },
        });
      },
    );
    const client = authenticatedClient(fetchMock);

    const availability = await client.checkAvailability({
      calendarIds: [calendarId],
      occurrences: [
        {
          sequence: 0,
          startAt: Date.parse("2026-01-01T09:00:00.000Z"),
          endAt: Date.parse("2026-01-01T10:00:00.000Z"),
        },
        {
          sequence: 1,
          startAt: Date.parse("2026-01-08T09:00:00.000Z"),
          endAt: Date.parse("2026-01-08T10:00:00.000Z"),
        },
      ],
      timeZone: "Asia/Singapore",
    });

    expect(availability).toEqual({
      available: false,
      conflicts: [
        {
          calendarId,
          end: "2026-01-08T10:30:00.000Z",
          occurrenceSequence: 1,
          start: "2026-01-08T09:30:00.000Z",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0].timeMin).toBe(
      "2026-01-01T09:00:00.000Z",
    );
    expect(requestBodies[0].timeMax).toBe(
      "2026-01-01T10:00:00.000Z",
    );
    expect(requestBodies[1].timeMin).toBe(
      "2026-01-08T09:00:00.000Z",
    );
    expect(requestBodies[1].timeMax).toBe(
      "2026-01-08T10:00:00.000Z",
    );
  });

  it("retries bounded 429 and 5xx responses", async () => {
    const calendarId = "calendar-1@example.test";
    const delays: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { "retry-after": "0" },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          calendars: { [calendarId]: { busy: [] } },
        }),
      );
    const client = authenticatedClient(fetchMock, {
      maxAttempts: 3,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(
      client.checkAvailability({
        calendarIds: [calendarId],
        occurrences: [
          {
            sequence: 0,
            startAt: now,
            endAt: now + 3_600_000,
          },
        ],
        timeZone: "Asia/Singapore",
      }),
    ).resolves.toEqual({ available: true, conflicts: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([0, 500]);
  });

  it("bounds a request that never settles", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const client = authenticatedClient(fetchMock, {
      maxAttempts: 1,
      requestTimeoutMs: 5,
    });

    await expect(
      client.checkAvailability({
        calendarIds: ["calendar-1@example.test"],
        occurrences: [
          {
            sequence: 0,
            startAt: now,
            endAt: now + 3_600_000,
          },
        ],
        timeZone: "Asia/Singapore",
      }),
    ).rejects.toThrow("GOOGLE_CALENDAR_REQUEST_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reconciles a deterministic create after an ambiguous retry", async () => {
    const input: GoogleCalendarEventInput = {
      bookingId: "booking_123",
      calendarId: "calendar-4@example.test",
      endAt: now + 7_200_000,
      requestedVenue: "Ministry Centre A & B",
      startAt: now + 3_600_000,
      summary: "[Ministry Centre A & B] Leaders Meeting Youth",
      timeZone: "Asia/Singapore",
      venue: "Ministry Centre A",
    };
    const eventId = await deterministicGoogleCalendarEventId({
      bookingId: input.bookingId,
      calendarId: input.calendarId,
      venue: input.venue,
    });
    const calls: Array<{
      body?: Record<string, unknown>;
      method: string;
      url: string;
    }> = [];
    const fetchMock = vi.fn(
      async (
        requestInput: string | URL | Request,
        init?: RequestInit,
      ) => {
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        calls.push({
          body,
          method,
          url: String(requestInput),
        });
        if (method === "POST") {
          return new Response(null, { status: 409 });
        }
        if (method === "GET") {
          return jsonResponse({
            extendedProperties: {
              private: {
                roomopsBookingId: input.bookingId,
                roomopsManaged: "true",
                roomopsTargetVenue: input.venue,
              },
            },
            id: eventId,
          });
        }
        return jsonResponse({
          htmlLink: "https://calendar.google.test/event",
          id: eventId,
          status: "confirmed",
        });
      },
    );
    const client = authenticatedClient(fetchMock);

    await expect(client.createEvent(input)).resolves.toEqual({
      calendarId: input.calendarId,
      eventId,
      htmlLink: "https://calendar.google.test/event",
      status: "confirmed",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "POST",
      "GET",
      "PATCH",
    ]);
    expect(calls[0].body?.id).toBe(eventId);
    expect(calls[2].body?.id).toBeUndefined();
  });

  it("recreates a missing managed event with a stable repair ID", async () => {
    const input: GoogleCalendarEventInput = {
      bookingId: "booking_123",
      calendarId: "calendar-4@example.test",
      endAt: now + 7_200_000,
      requestedVenue: "Ministry Centre A",
      startAt: now + 3_600_000,
      summary: "[Ministry Centre A] Leaders Meeting",
      timeZone: "Asia/Singapore",
      venue: "Ministry Centre A",
    };
    const calls: Array<{
      body?: Record<string, unknown>;
      method: string;
    }> = [];
    const fetchMock = vi.fn(
      async (
        _requestInput: string | URL | Request,
        init?: RequestInit,
      ) => {
        const method = init?.method ?? "GET";
        calls.push({
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : undefined,
          method,
        });
        if (method === "PATCH") {
          return new Response(null, { status: 404 });
        }
        return jsonResponse({
          id: calls.at(-1)?.body?.id,
          status: "confirmed",
        });
      },
    );
    const client = authenticatedClient(fetchMock);

    const result = await client.updateEvent(
      "missing-original",
      input,
      "repair-7",
    );
    const expectedId = await deterministicGoogleCalendarEventId({
      bookingId: input.bookingId,
      calendarId: input.calendarId,
      venue: input.venue,
      generation: "repair-7",
    });

    expect(calls.map((call) => call.method)).toEqual([
      "PATCH",
      "POST",
    ]);
    expect(calls[1].body?.id).toBe(expectedId);
    expect(result.eventId).toBe(expectedId);
  });

  it("verifies RoomOps ownership before deleting a managed event", async () => {
    const calendarId = "calendar-4@example.test";
    const eventId = "roomops-event";
    const ownedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          etag: '"owned-etag"',
          extendedProperties: {
            private: {
              roomopsBookingId: "booking_123",
              roomopsManaged: "true",
              roomopsTargetVenue: "Ministry Centre A",
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ownedClient = authenticatedClient(ownedFetch);

    await expect(
      ownedClient.deleteManagedEvent({
        bookingId: "booking_123",
        calendarId,
        eventId,
        venue: "Ministry Centre A",
      }),
    ).resolves.toBe(true);
    expect(ownedFetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "if-match": '"owned-etag"',
        }),
        method: "DELETE",
      }),
    );

    const collisionClient = authenticatedClient(
      vi.fn(async () =>
        jsonResponse({
          extendedProperties: {
            private: {
              roomopsBookingId: "someone_else",
              roomopsManaged: "true",
              roomopsTargetVenue: "Ministry Centre A",
            },
          },
        }),
      ),
    );
    await expect(
      collisionClient.deleteManagedEvent({
        bookingId: "booking_123",
        calendarId,
        eventId,
        venue: "Ministry Centre A",
      }),
    ).rejects.toThrow("GOOGLE_CALENDAR_EVENT_ID_COLLISION");
  });

  it("verifies that a managed event still exists before reporting sync success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        extendedProperties: {
          private: {
            roomopsBookingId: "booking_123",
            roomopsManaged: "true",
            roomopsTargetVenue: "Shema Space",
          },
        },
        htmlLink: "https://calendar.google.test/event",
        id: "roomops-event",
        status: "confirmed",
      }),
    );
    const client = authenticatedClient(fetchMock);

    await expect(
      client.verifyManagedEvent({
        bookingId: "booking_123",
        calendarId: "shema@example.test",
        eventId: "roomops-event",
        venue: "Shema Space",
      }),
    ).resolves.toEqual({
      calendarId: "shema@example.test",
      eventId: "roomops-event",
      htmlLink: "https://calendar.google.test/event",
      status: "confirmed",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/calendars/shema%40example.test/events/roomops-event",
      ),
      expect.objectContaining({ method: "GET" }),
    );
  });
});
