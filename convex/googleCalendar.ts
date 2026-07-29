import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireActionCapability,
  requireActionHeadAdmin,
} from "./lib/actionAuth";
import {
  GOOGLE_CALENDAR_VENUES,
  buildGoogleCalendarEventText,
  calendarTargetsForVenue,
  deterministicGoogleCalendarEventId,
  googleCalendarRuntimeFromEnv,
  type GoogleCalendarAvailability,
  type GoogleCalendarEventInput,
  type GoogleCalendarEventRef,
  type GoogleCalendarOccurrence,
  type GoogleCalendarRuntime,
  type GoogleCalendarVenue,
  type VenueCalendarTarget,
} from "./lib/googleCalendar";
import {
  assertRecurrenceOccurrencesHaveStableUtcOffset,
  buildGoogleRecurrenceRule,
  type RecurrenceFrequency,
} from "./lib/recurrence";
import {
  managedCalendarEventsExcluding,
  type ManagedCalendarEventReference,
} from "./lib/bookingDeletion";

type Booking = Doc<"bookings">;
type CalendarApprovalStart =
  | { started: true; booking: Booking }
  | {
      started: false;
      reason: "approved_conflict" | "approval_in_progress";
      conflictBookingId: Id<"bookings">;
    }
  | {
      started: false;
      reason: "approved_conflict_cleanup_required";
      conflictBookingId: Id<"bookings">;
      booking: Booking;
    };

function calendarError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function requiredRuntime(): GoogleCalendarRuntime {
  const runtime = googleCalendarRuntimeFromEnv(process.env);
  if (!runtime) {
    calendarError(
      "GOOGLE_CALENDAR_NOT_ENABLED",
      "Google Calendar is not enabled in this Convex deployment.",
    );
  }
  return runtime;
}

function occurrencesForBooking(
  booking: Booking,
): GoogleCalendarOccurrence[] {
  return (
    booking.occurrences ?? [
      {
        sequence: 0,
        startAt: booking.startAt,
        endAt: booking.endAt,
      },
    ]
  ).map((occurrence, index) => ({
    sequence: Number.isInteger(occurrence.sequence)
      ? occurrence.sequence
      : index,
    startAt: occurrence.startAt,
    endAt: occurrence.endAt,
  }));
}

function recurrenceForBooking(
  booking: Booking,
  occurrences: readonly GoogleCalendarOccurrence[],
): readonly string[] | undefined {
  const frequency =
    (booking.recurrenceFrequency as RecurrenceFrequency | undefined) ??
    "none";
  if (frequency !== "none" && occurrences.length > 1) {
    assertRecurrenceOccurrencesHaveStableUtcOffset(
      occurrences,
      booking.timezone,
    );
  }
  const rule = buildGoogleRecurrenceRule({
    frequency,
    occurrenceCount: occurrences.length,
    startAt: booking.startAt,
    timezone: booking.timezone,
  });
  return rule ? [rule] : undefined;
}

function eventInput(
  booking: Booking,
  target: VenueCalendarTarget,
  occurrences: readonly GoogleCalendarOccurrence[],
): GoogleCalendarEventInput {
  const eventText = buildGoogleCalendarEventText({
    eventName: booking.eventName,
    ministry: booking.ministry,
    purpose: booking.purpose,
    requesterName: booking.requesterName,
    venue: target.venue,
  });
  return {
    bookingId: String(booking._id),
    calendarId: target.calendarId,
    venue: target.venue,
    requestedVenue: booking.room,
    summary: eventText.summary,
    startAt: booking.startAt,
    endAt: booking.endAt,
    timeZone: booking.timezone,
    description: eventText.description,
    location: eventText.location,
    sourceSubmissionId: booking.jotformSubmissionId,
    recurrence: recurrenceForBooking(booking, occurrences),
  };
}

function errorMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : "UNKNOWN_CALENDAR_ERROR")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 1_000)
  );
}

function conflictSummary(
  targets: readonly VenueCalendarTarget[],
  conflicts: ReadonlyArray<{
    calendarId: string;
    occurrenceSequence: number;
    start: string;
    end: string;
  }>,
): string {
  const venueByCalendar = new Map(
    targets.map((target) => [target.calendarId, target.venue]),
  );
  return conflicts
    .slice(0, 5)
    .map((conflict) => {
      const venue =
        venueByCalendar.get(conflict.calendarId) ?? "Requested venue";
      return `${venue}, occurrence ${conflict.occurrenceSequence + 1}: ${conflict.start}–${conflict.end}`;
    })
    .join("; ");
}

function isGoogleCalendarVenue(
  value: string,
): value is GoogleCalendarVenue {
  return (GOOGLE_CALENDAR_VENUES as readonly string[]).includes(value);
}

async function cleanupManagedEvents(
  runtime: GoogleCalendarRuntime,
  bookingId: string,
  events: readonly {
    calendarId: string;
    eventId: string;
    targetVenue: string;
  }[],
): Promise<void> {
  const seen = new Set<string>();
  for (const event of [...events].reverse()) {
    if (!isGoogleCalendarVenue(event.targetVenue)) {
      throw new Error(
        "GOOGLE_CALENDAR_VENUE_UNKNOWN:Stored cleanup venue is invalid.",
      );
    }
    const key = `${event.calendarId}\u0000${event.eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await runtime.client.deleteManagedEvent({
      bookingId,
      calendarId: event.calendarId,
      eventId: event.eventId,
      venue: event.targetVenue,
    });
  }
}

export const inspectConfiguration = action({
  args: {},
  handler: async (ctx) => {
    await requireActionHeadAdmin(ctx);
    const runtime = requiredRuntime();
    const calendarIds = [
      ...new Set(
        GOOGLE_CALENDAR_VENUES.flatMap(
          (venue) => runtime.venueMap[venue],
        ),
      ),
    ];
    const now = Date.now();
    await runtime.client.checkAvailability({
      calendarIds,
      occurrences: [
        {
          sequence: 0,
          startAt: now,
          endAt: now + 1_000,
        },
      ],
      timeZone:
        process.env.BOOKING_TIME_ZONE?.trim() || "Asia/Singapore",
    });
    const accessByCalendar = new Map<
      string,
      Awaited<
        ReturnType<typeof runtime.client.getCalendarAccess>
      >
    >();
    const configuredIdByResolvedId = new Map<string, string>();
    for (const calendarId of calendarIds) {
      const access =
        await runtime.client.getCalendarAccess(calendarId);
      if (
        access.accessRole !== "writer" &&
        access.accessRole !== "owner"
      ) {
        calendarError(
          "GOOGLE_CALENDAR_WRITE_ACCESS_REQUIRED",
          `The service account has ${access.accessRole || "unknown"} access to "${access.summary || calendarId}". Share it with Make changes to events.`,
        );
      }
      const existingConfiguredId = configuredIdByResolvedId.get(
        access.calendarId,
      );
      if (
        existingConfiguredId &&
        existingConfiguredId !== calendarId
      ) {
        calendarError(
          "GOOGLE_CALENDAR_RESOLVED_ID_DUPLICATE",
          `"${existingConfiguredId}" and "${calendarId}" resolve to the same Google calendar. Configure each physical calendar exactly once by its real Calendar ID.`,
        );
      }
      configuredIdByResolvedId.set(access.calendarId, calendarId);
      accessByCalendar.set(calendarId, access);
    }
    return {
      calendarCount: calendarIds.length,
      serviceAccountEmail: runtime.credentials.clientEmail,
      venues: GOOGLE_CALENDAR_VENUES.map((venue) => ({
        calendarCount: runtime.venueMap[venue].length,
        calendars: runtime.venueMap[venue].map((calendarId) => {
          const access = accessByCalendar.get(calendarId);
          return {
            accessRole: access?.accessRole ?? "unknown",
            calendarId,
            summary: access?.summary ?? "Unknown calendar",
            timeZone: access?.timeZone,
          };
        }),
        venue,
      })),
    };
  },
});

export const deleteBooking = action({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const user = await requireActionCapability(ctx, "table.edit");
    const deletionToken = crypto.randomUUID();
    let started = false;
    try {
      const deletion = (await ctx.runMutation(
        internal.bookings.beginBookingDeletion,
        {
          bookingId: args.bookingId,
          expectedRevision: args.expectedRevision,
          actorId: user.clerkUserId,
          deletionToken,
        },
      )) as
        | {
            booking: Booking;
            events: Array<{
              calendarId: string;
              eventId: string;
              targetVenue: string;
            }>;
          }
        | null;
      if (!deletion) return { deleted: false };
      started = true;

      if (deletion.events.length > 0) {
        await cleanupManagedEvents(
          requiredRuntime(),
          String(deletion.booking._id),
          deletion.events,
        );
      }
      return (await ctx.runMutation(
        internal.bookings.completeBookingDeletion,
        {
          bookingId: deletion.booking._id,
          actorId: user.clerkUserId,
          deletionToken,
        },
      )) as { deleted: boolean };
    } catch (error) {
      if (!started) throw error;
      if (started) {
        // A Convex mutation response can be lost after its transaction
        // commits. A missing row is authoritative evidence that cleanup and
        // deletion completed; never turn that success into a false failure.
        try {
          const current = (await ctx.runQuery(
            internal.bookings.getInternal,
            { bookingId: args.bookingId },
          )) as Booking | null;
          if (!current) return { deleted: true };
          await ctx.runMutation(
            internal.bookings.failBookingDeletion,
            {
              bookingId: args.bookingId,
              actorId: user.clerkUserId,
              deletionToken,
              errorMessage: errorMessage(error),
            },
          );
        } catch {
          // The durable 31-minute lease recovery remains the final safety net
          // if Convex is temporarily unavailable while recording the error.
        }
      }
      calendarError(
        "BOOKING_DELETE_FAILED",
        `The booking was kept because RoomOps could not safely remove all managed Calendar events. Retry deletion. ${errorMessage(error)}`,
      );
    }
  },
});

export const decide = action({
  args: {
    bookingId: v.id("bookings"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    note: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let actorId: string;
    let emailClaim:
      | {
          token: string;
          claimToken: string;
        }
      | undefined;
    if (args.token?.trim()) {
      const token = args.token.trim();
      const claimToken = crypto.randomUUID();
      const claimed = (await ctx.runMutation(
        internal.approvers.beginDecisionToken,
        {
          token,
          bookingId: args.bookingId,
          decision: args.decision,
          note: args.note,
          claimToken,
        },
      )) as { bookingId: string; approverEmail: string };
      actorId = `email:${claimed.approverEmail}`;
      emailClaim = { token, claimToken };
    } else {
      const user = await requireActionCapability(
        ctx,
        "bookings.approve",
      );
      actorId = user.clerkUserId;
    }
    const finishEmailDecision = async () => {
      if (!emailClaim) return;
      await ctx.runMutation(
        internal.approvers.completeDecisionToken,
        {
          token: emailClaim.token,
          claimToken: emailClaim.claimToken,
          decision: args.decision,
          note: args.note,
        },
      );
    };
    const releaseEmailDecision = async () => {
      if (!emailClaim) return;
      await ctx.runMutation(
        internal.approvers.releaseDecisionToken,
        {
          token: emailClaim.token,
          claimToken: emailClaim.claimToken,
        },
      );
    };
    const finish = async <T,>(result: T): Promise<T> => {
      await finishEmailDecision();
      return result;
    };
    try {
    if (args.decision === "reject") {
      const booking = (await ctx.runQuery(
        internal.bookings.getInternal,
        { bookingId: args.bookingId },
      )) as Booking | null;
      if (!booking) {
        calendarError(
          "BOOKING_NOT_FOUND",
          "The booking no longer exists.",
        );
      }
      if ((booking.calendarAttemptedEvents?.length ?? 0) > 0) {
        const runtime = requiredRuntime();
        const syncToken = crypto.randomUUID();
        try {
          const start = (await ctx.runMutation(
            internal.bookings.beginCalendarApproval,
            {
              bookingId: booking._id,
              actorId,
              syncToken,
              purpose: "cleanup",
              emailDecisionClaim: emailClaim,
            },
          )) as CalendarApprovalStart;
          if (!start.started) {
            calendarError(
              "CALENDAR_CLEANUP_LOCK_FAILED",
              "The incomplete Calendar attempt could not be locked for cleanup.",
            );
          }
          const lockedBooking = start.booking;
          await cleanupManagedEvents(
            runtime,
            String(lockedBooking._id),
            lockedBooking.calendarAttemptedEvents ?? [],
          );
          await ctx.runMutation(
            internal.bookings.rejectPendingAfterCalendarCleanup,
            {
              bookingId: lockedBooking._id,
              actorId,
              note: args.note,
              syncToken,
              emailDecisionClaim: emailClaim,
            },
          );
        } catch (error) {
          const current = (await ctx.runQuery(
            internal.bookings.getInternal,
            { bookingId: booking._id },
          )) as Booking | null;
          if (current?.status === "rejected") {
            return await finish({ status: "rejected" as const });
          }
          await ctx.runMutation(
            internal.bookings.failCalendarApproval,
            {
              bookingId: booking._id,
              syncToken,
              errorMessage: errorMessage(error),
            },
          );
          calendarError(
            "GOOGLE_CALENDAR_ORPHAN_CLEANUP_FAILED",
            `The request was not rejected because its incomplete Calendar attempt could not be cleaned safely. ${errorMessage(error)}`,
          );
        }
        return await finish({ status: "rejected" as const });
      }
      await ctx.runMutation(internal.bookings.rejectPending, {
        bookingId: args.bookingId,
        actorId,
        note: args.note,
        emailDecisionClaim: emailClaim,
      });
      return await finish({ status: "rejected" as const });
    }

    const runtime = requiredRuntime();
    const syncToken = crypto.randomUUID();
    const start = (await ctx.runMutation(
      internal.bookings.beginCalendarApproval,
      {
        bookingId: args.bookingId,
        actorId,
        syncToken,
        purpose: "approve",
        emailDecisionClaim: emailClaim,
      },
    )) as CalendarApprovalStart;
    if (!start.started) {
      if (start.reason === "approved_conflict") {
        return await finish({ status: "unavailable" as const });
      }
      if (
        start.reason ===
        "approved_conflict_cleanup_required"
      ) {
        try {
          await cleanupManagedEvents(
            runtime,
            String(start.booking._id),
            start.booking.calendarAttemptedEvents ?? [],
          );
          await ctx.runMutation(
            internal.bookings
              .markApprovedConflictAfterCalendarCleanup,
            {
              bookingId: start.booking._id,
              conflictBookingId: start.conflictBookingId,
              actorId,
              syncToken,
              note: args.note,
              emailDecisionClaim: emailClaim,
            },
          );
        } catch (error) {
          const current = (await ctx.runQuery(
            internal.bookings.getInternal,
            { bookingId: args.bookingId },
          )) as Booking | null;
          if (current?.status === "unavailable") {
            return await finish({
              status: "unavailable" as const,
            });
          }
          await ctx.runMutation(
            internal.bookings.failCalendarApproval,
            {
              bookingId: args.bookingId,
              syncToken,
              errorMessage: errorMessage(error),
            },
          );
          calendarError(
            "GOOGLE_CALENDAR_ORPHAN_CLEANUP_FAILED",
            `The request remains pending because its incomplete Calendar attempt could not be cleaned safely. ${errorMessage(error)}`,
          );
        }
        return await finish({ status: "unavailable" as const });
      }
      calendarError(
        "PENDING_APPROVAL_CONFLICT",
        "Another overlapping request is currently being approved. Wait for it to finish before deciding this request.",
      );
    }
    const booking = start.booking;
    const occurrences = occurrencesForBooking(booking);
    let targets: VenueCalendarTarget[];
    try {
      targets = calendarTargetsForVenue(
        booking.room,
        runtime.venueMap,
      );
    } catch (error) {
      const message = errorMessage(error);
      await ctx.runMutation(internal.bookings.failCalendarApproval, {
        bookingId: booking._id,
        syncToken,
        errorMessage: message,
      });
      calendarError(
        "GOOGLE_CALENDAR_VENUE_RESOLUTION_FAILED",
        `The booking venue could not be mapped to a Google Calendar. The booking remains pending. ${message}`,
      );
    }

    const attemptedEvents = await Promise.all(
      targets.map(async (target) => ({
        calendarId: target.calendarId,
        eventId: await deterministicGoogleCalendarEventId({
          bookingId: String(booking._id),
          calendarId: target.calendarId,
          venue: target.venue,
        }),
        targetVenue: target.venue,
      })),
    );

    // A previous action may have been terminated after Google committed an
    // event but before Convex received its response. Deterministic IDs let a
    // new lease remove those known-orphan candidates before checking free/busy.
    try {
      await cleanupManagedEvents(
        runtime,
        String(booking._id),
        [
          ...(booking.calendarAttemptedEvents ?? []),
          ...attemptedEvents,
        ],
      );
      await ctx.runMutation(
        internal.bookings.recordCalendarAttemptTargets,
        {
          bookingId: booking._id,
          syncToken,
          events: attemptedEvents,
        },
      );
    } catch (error) {
      const message = errorMessage(error);
      await ctx.runMutation(internal.bookings.failCalendarApproval, {
        bookingId: booking._id,
        syncToken,
        errorMessage: message,
      });
      calendarError(
        "GOOGLE_CALENDAR_ORPHAN_CLEANUP_FAILED",
        `RoomOps could not clear an earlier incomplete Calendar attempt. The booking remains pending. ${message}`,
      );
    }

    let availability: GoogleCalendarAvailability;
    try {
      availability = await runtime.client.checkAvailability({
        calendarIds: targets.map((target) => target.calendarId),
        occurrences,
        timeZone: booking.timezone,
      });
    } catch (error) {
      const message = errorMessage(error);
      await ctx.runMutation(internal.bookings.failCalendarApproval, {
        bookingId: booking._id,
        syncToken,
        errorMessage: message,
      });
      calendarError(
        "GOOGLE_CALENDAR_CHECK_FAILED",
        `Google Calendar could not be checked. The booking remains pending. ${message}`,
      );
    }
    if (!availability.available) {
      const summary = conflictSummary(
        targets,
        availability.conflicts,
      );
      await ctx.runMutation(internal.bookings.markCalendarConflict, {
        bookingId: booking._id,
        actorId,
        syncToken,
        note: args.note,
        conflictSummary: summary,
        emailDecisionClaim: emailClaim,
      });
      return await finish({ status: "unavailable" as const });
    }

    const created: GoogleCalendarEventRef[] = [];
    try {
      for (const target of targets) {
        created.push(
          await runtime.client.createEvent(
            eventInput(booking, target, occurrences),
          ),
        );
      }
    } catch (error) {
      const cleanupErrors: string[] = [];
      try {
        await cleanupManagedEvents(
          runtime,
          String(booking._id),
          attemptedEvents,
        );
      } catch (cleanupError) {
        cleanupErrors.push(errorMessage(cleanupError));
      }
      const message = [
        errorMessage(error),
        cleanupErrors.length
          ? `Cleanup also failed: ${cleanupErrors.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      await ctx.runMutation(internal.bookings.failCalendarApproval, {
        bookingId: booking._id,
        syncToken,
        errorMessage: message,
      });
      calendarError(
        "GOOGLE_CALENDAR_CREATE_FAILED",
        `The Google Calendar event could not be created. The booking remains pending. ${message}`,
      );
    }

    const completedEvents = created.map((event, index) => ({
      calendarId: event.calendarId,
      eventId: event.eventId,
      htmlLink: event.htmlLink,
      targetVenue: targets[index].venue,
    }));
    try {
      await ctx.runMutation(
        internal.bookings.completeCalendarApproval,
        {
          bookingId: booking._id,
          actorId,
          syncToken,
          note: args.note,
          events: completedEvents,
          emailDecisionClaim: emailClaim,
        },
      );
    } catch (error) {
      // A mutation response can be lost after its transaction commits. Read
      // back the authoritative booking before deleting events, so an
      // ambiguous response never removes a successfully approved series.
      let current: Booking | null;
      try {
        current = (await ctx.runQuery(
          internal.bookings.getInternal,
          { bookingId: booking._id },
        )) as Booking | null;
      } catch {
        calendarError(
          "CALENDAR_APPROVAL_STATUS_UNKNOWN",
          "Google Calendar events were created, but RoomOps could not confirm the final Convex transaction. Check the booking and audit log before retrying.",
        );
      }
      const expectedEventKeys = new Set(
        completedEvents.map(
          (event) => `${event.calendarId}\u0000${event.eventId}`,
        ),
      );
      const storedEventKeys = new Set(
        (current?.calendarEvents ?? []).map(
          (event) => `${event.calendarId}\u0000${event.eventId}`,
        ),
      );
      if (
        current?.status === "approved" &&
        expectedEventKeys.size === storedEventKeys.size &&
        [...expectedEventKeys].every((key) =>
          storedEventKeys.has(key),
        )
      ) {
        return await finish({
          status: "approved" as const,
          calendarEventCount: created.length,
          occurrenceCount: occurrences.length,
        });
      }

      const cleanupErrors: string[] = [];
      try {
        await cleanupManagedEvents(
          runtime,
          String(booking._id),
          completedEvents,
        );
      } catch (cleanupError) {
        cleanupErrors.push(errorMessage(cleanupError));
      }
      const message = [
        errorMessage(error),
        cleanupErrors.length
          ? `Cleanup also failed: ${cleanupErrors.join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (
        current?.status === "pending" &&
        current.calendarSyncToken === syncToken
      ) {
        await ctx.runMutation(
          internal.bookings.failCalendarApproval,
          {
            bookingId: booking._id,
            syncToken,
            errorMessage: message,
          },
        );
      }
      calendarError(
        "CALENDAR_APPROVAL_FINALIZE_FAILED",
        `The Google events were rolled back because Convex could not finalize approval. ${message}`,
      );
    }
    return await finish({
      status: "approved" as const,
      calendarEventCount: created.length,
      occurrenceCount: occurrences.length,
    });
    } catch (error) {
      if (!emailClaim) throw error;
      let current: Booking | null = null;
      try {
        current = (await ctx.runQuery(
          internal.bookings.getInternal,
          { bookingId: args.bookingId },
        )) as Booking | null;
      } catch {
        // Preserve the decision error below. A failed status read is not
        // evidence that the token should be consumed.
      }
      if (
        current?.status === "approved" ||
        current?.status === "rejected" ||
        current?.status === "unavailable"
      ) {
        try {
          await finishEmailDecision();
          if (current.status === "approved") {
            return {
              status: "approved" as const,
              calendarEventCount:
                current.calendarEvents?.length ?? 0,
              occurrenceCount:
                current.occurrences?.length ?? 1,
            };
          }
          return { status: current.status };
        } catch {
          // A different terminal decision may have won the race. Release our
          // lease if it is still ours, then surface the original failure.
        }
      }
      try {
        await releaseEmailDecision();
      } catch {
        // The claim lease is a final safety net if release cannot be
        // recorded after a transient Convex failure.
      }
      throw error;
    }
  },
});

export const cleanupSupersededBooking = internalAction({
  args: {
    bookingId: v.id("bookings"),
    approvedBookingId: v.id("bookings"),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = (await ctx.runQuery(
      internal.bookings.getInternal,
      { bookingId: args.bookingId },
    )) as Booking | null;
    if (!existing || existing.status !== "pending") return;

    const syncToken = crypto.randomUUID();
    try {
      const start = (await ctx.runMutation(
        internal.bookings.beginCalendarApproval,
        {
          bookingId: existing._id,
          actorId: "system:approved-conflict",
          syncToken,
          purpose: "cleanup",
        },
      )) as CalendarApprovalStart;
      if (!start.started) {
        throw new Error(
          "CALENDAR_CLEANUP_LOCK_FAILED:The superseded booking could not be locked for cleanup.",
        );
      }
      const runtime = requiredRuntime();
      await cleanupManagedEvents(
        runtime,
        String(start.booking._id),
        start.booking.calendarAttemptedEvents ?? [],
      );
      await ctx.runMutation(
        internal.bookings
          .markApprovedConflictAfterCalendarCleanup,
        {
          bookingId: start.booking._id,
          conflictBookingId: args.approvedBookingId,
          actorId: "system:approved-conflict",
          syncToken,
          note:
            "Automatically rejected because an overlapping room request was approved first.",
        },
      );
    } catch (error) {
      const current = (await ctx.runQuery(
        internal.bookings.getInternal,
        { bookingId: args.bookingId },
      )) as Booking | null;
      if (!current || current.status !== "pending") return;
      await ctx.runMutation(
        internal.bookings.failCalendarApproval,
        {
          bookingId: args.bookingId,
          syncToken,
          errorMessage: errorMessage(error),
        },
      );
    }
  },
});

export const reconcileApprovedBooking = internalAction({
  args: {
    bookingId: v.id("bookings"),
    expectedRevision: v.number(),
    syncToken: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    // The scheduler may start this action long after it was queued. Renew
    // ownership at worker start so the 31-minute lease covers this action's
    // own (at most 30-minute) runtime, not its time waiting in the queue.
    const booking = (await ctx.runMutation(
      internal.bookings.renewCalendarReconciliationLease,
      {
        bookingId: args.bookingId,
        expectedRevision: args.expectedRevision,
        syncToken: args.syncToken,
      },
    )) as Booking | null;
    if (!booking) return;
    try {
      const runtime = requiredRuntime();
      const occurrences = occurrencesForBooking(booking);
      if (!booking.calendarEvents?.length) {
        throw new Error(
          "GOOGLE_CALENDAR_EVENT_REFERENCE_MISSING:This approved booking has no managed Google Calendar event.",
        );
      }
      const managedEvents: Array<
        NonNullable<Booking["calendarEvents"]>[number] & {
          targetVenue: GoogleCalendarVenue;
        }
      > = booking.calendarEvents.map((event) => {
        if (!isGoogleCalendarVenue(event.targetVenue)) {
          throw new Error(
            "GOOGLE_CALENDAR_VENUE_UNKNOWN:Stored event venue is invalid.",
          );
        }
        return {
          ...event,
          targetVenue: event.targetVenue,
        };
      });
      const replacementCandidates = await Promise.all(
        managedEvents.map(async (event) => ({
          calendarId: event.calendarId,
          eventId: await deterministicGoogleCalendarEventId({
            bookingId: String(booking._id),
            calendarId: event.calendarId,
            venue: event.targetVenue,
            generation: `repair-${event.eventId}`,
          }),
          targetVenue: event.targetVenue,
        })),
      );
      // Persist every deterministic replacement before the first external
      // PATCH/POST. If this worker dies after Google creates a repair, safe
      // deletion and later retries retain a durable cleanup candidate.
      const reconciliationCandidates = (await ctx.runMutation(
        internal.bookings.recordCalendarReconciliationTargets,
        {
          bookingId: booking._id,
          expectedRevision: args.expectedRevision,
          syncToken: args.syncToken,
          events: replacementCandidates,
        },
      )) as ManagedCalendarEventReference[];
      const reconciledEvents: NonNullable<
        Booking["calendarEvents"]
      > = [];
      for (const event of managedEvents) {
        const reconciled = await runtime.client.updateEvent(
          event.eventId,
          eventInput(
            booking,
            {
              calendarId: event.calendarId,
              requestedVenue: booking.room,
              venue: event.targetVenue,
            },
            occurrences,
          ),
          // The repair generation is tied to the stored missing event, not
          // the booking revision. If a worker creates the replacement and
          // then dies before Convex stores its ref, every retry converges on
          // the same deterministic replacement ID.
          `repair-${event.eventId}`,
        );
        reconciledEvents.push({
          calendarId: reconciled.calendarId,
          eventId: reconciled.eventId,
          htmlLink: reconciled.htmlLink,
          targetVenue: event.targetVenue,
        });
      }
      const supersededCandidates = managedCalendarEventsExcluding(
        reconciliationCandidates,
        reconciledEvents,
      );
      if (supersededCandidates.length > 0) {
        await cleanupManagedEvents(
          runtime,
          String(booking._id),
          supersededCandidates,
        );
      }
      await ctx.runMutation(
        internal.bookings.recordCalendarReconcileResult,
        {
          bookingId: booking._id,
          expectedRevision: args.expectedRevision,
          syncToken: args.syncToken,
          success: true,
          events: reconciledEvents,
        },
      );
    } catch (error) {
      await ctx.runMutation(
        internal.bookings.recordCalendarReconcileResult,
        {
          bookingId: booking._id,
          expectedRevision: args.expectedRevision,
          syncToken: args.syncToken,
          success: false,
          errorMessage: errorMessage(error),
        },
      );
    }
  },
});
