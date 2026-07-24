import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireActionHeadAdmin } from "./lib/actionAuth";
import {
  mapJotformBooking,
  parseFieldMap,
  snapshotJotformAnswers,
  type JotformAnswers,
} from "./lib/jotformMapping";
import {
  calendarTargetsForVenue,
  googleCalendarRuntimeFromEnv,
} from "./lib/googleCalendar";
import {
  MAX_RECURRENCE_OCCURRENCES,
  expandRecurrence,
} from "./lib/recurrence";

type JotformEnvelope<T> = {
  responseCode?: number;
  message?: string;
  content?: T;
  "limit-left"?: number;
};

type JotformSubmission = {
  id?: string;
  form_id?: string;
  answers?: JotformAnswers;
};

type QueueResult = {
  accepted: true;
  duplicate: boolean;
  state: "received" | "processing" | "processed" | "failed";
};

type RetryResult = {
  state: "received" | "processed";
  alreadyProcessed: boolean;
};

type FormInspection = {
  formId: string;
  apiBase: string;
  apiCallsRemaining?: number;
  questions: Array<{
    qid: string;
    type: string;
    name: string;
    text: string;
    order: number;
  }>;
};

const ALLOWED_API_BASES = new Set([
  "https://api.jotform.com",
  "https://eu-api.jotform.com",
  "https://hipaa-api.jotform.com",
]);
const MAX_PROCESSING_ATTEMPTS = 3;
const PROCESSING_LEASE_MS = 5 * 60_000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function apiBase(): string {
  const base = (
    process.env.JOTFORM_API_BASE_URL ?? "https://api.jotform.com"
  ).replace(/\/+$/, "");
  if (!ALLOWED_API_BASES.has(base)) {
    throw new Error("JOTFORM_API_BASE_URL_NOT_ALLOWED");
  }
  return base;
}

function defaultRecurrenceCount(): number {
  const raw =
    process.env.BOOKING_RECURRENCE_DEFAULT_COUNT?.trim() || "12";
  const count = Number(raw);
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    count > MAX_RECURRENCE_OCCURRENCES
  ) {
    throw new Error("BOOKING_RECURRENCE_DEFAULT_COUNT_INVALID");
  }
  return count;
}

async function jotformGet<T>(path: string): Promise<{
  content: T;
  limitLeft?: number;
}> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: {
      APIKEY: requiredEnv("JOTFORM_API_KEY"),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const envelope = (await response.json()) as JotformEnvelope<T>;
  if (
    !response.ok ||
    envelope.responseCode !== 200 ||
    envelope.content === undefined
  ) {
    throw new Error(
      `JOTFORM_API_ERROR:${response.status}:${envelope.message ?? "Unknown response"}`,
    );
  }
  return {
    content: envelope.content,
    limitLeft: envelope["limit-left"],
  };
}

export const queueSubmission = internalMutation({
  args: {
    formId: v.string(),
    submissionId: v.string(),
  },
  handler: async (ctx, args): Promise<QueueResult> => {
    const expectedFormId = process.env.JOTFORM_FORM_ID?.trim();
    if (!expectedFormId || args.formId !== expectedFormId) {
      throw new ConvexError({
        code: "JOTFORM_FORM_MISMATCH",
        message: "The webhook form ID does not match JOTFORM_FORM_ID.",
      });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("externalSubmissions")
      .withIndex("by_provider_submission", (range) =>
        range
          .eq("provider", "jotform")
          .eq("formId", args.formId)
          .eq("submissionId", args.submissionId),
      )
      .unique();

    if (existing) {
      const processingLeaseExpired =
        existing.state === "processing" &&
        (!existing.processingStartedAt ||
          existing.processingStartedAt + PROCESSING_LEASE_MS <= now);
      const shouldRetry =
        (existing.state === "failed" || processingLeaseExpired) &&
        existing.attempts < MAX_PROCESSING_ATTEMPTS;
      const shouldDispatch =
        existing.state === "received" || shouldRetry;
      await ctx.db.patch(existing._id, {
        deliveryCount: existing.deliveryCount + 1,
        lastReceivedAt: now,
        state: shouldRetry ? "received" : existing.state,
        lastError: shouldRetry ? undefined : existing.lastError,
        processingStartedAt: shouldRetry
          ? undefined
          : existing.processingStartedAt,
        processingToken: shouldRetry
          ? undefined
          : existing.processingToken,
      });
      if (shouldDispatch) {
        await ctx.scheduler.runAfter(
          0,
          internal.jotform.dispatchSubmission,
          { receiptId: existing._id },
        );
      }
      return {
        accepted: true,
        duplicate: true,
        state: shouldRetry ? "received" : existing.state,
      };
    }

    const receiptId = await ctx.db.insert("externalSubmissions", {
      provider: "jotform",
      formId: args.formId,
      submissionId: args.submissionId,
      state: "received",
      deliveryCount: 1,
      attempts: 0,
      firstReceivedAt: now,
      lastReceivedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.jotform.dispatchSubmission, {
      receiptId,
    });
    return { accepted: true, duplicate: false, state: "received" };
  },
});

export const dispatchSubmission = internalMutation({
  args: { receiptId: v.id("externalSubmissions") },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.state !== "received" ||
      receipt.attempts >= MAX_PROCESSING_ATTEMPTS
    ) {
      return;
    }
    const now = Date.now();
    const processingToken = `${String(receipt._id)}:${receipt.attempts + 1}:${now}`;

    await ctx.db.patch(receipt._id, {
      state: "processing",
      attempts: receipt.attempts + 1,
      processingStartedAt: now,
      processingToken,
      lastError: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.jotform.processSubmission,
      {
        receiptId: receipt._id,
        processingToken,
        submissionId: receipt.submissionId,
      },
    );
    await ctx.scheduler.runAfter(
      PROCESSING_LEASE_MS,
      internal.jotform.recoverProcessingLease,
      {
        receiptId: receipt._id,
        processingToken,
      },
    );
  },
});

export const markFailed = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    processingToken: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.state !== "processing" ||
      receipt.processingToken !== args.processingToken
    ) {
      return;
    }
    const message = args.errorMessage.slice(0, 500);
    await ctx.db.patch(receipt._id, {
      state: "failed",
      lastError: message,
      processingStartedAt: undefined,
      processingToken: undefined,
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "jotform",
      action: "submission_processing_failed",
      actorType: "system",
      entityType: "jotform_submission",
      entityId: receipt.submissionId,
      message: "A Jotform submission could not be processed.",
      detailsJson: JSON.stringify({
        error: message,
        attempt: receipt.attempts,
      }),
      createdAt: Date.now(),
    });

    if (receipt.attempts < MAX_PROCESSING_ATTEMPTS) {
      const retryDelayMs = receipt.attempts === 1 ? 60_000 : 300_000;
      await ctx.scheduler.runAfter(
        retryDelayMs,
        internal.jotform.resetAndProcess,
        {
          receiptId: receipt._id,
          failedAttempt: receipt.attempts,
        },
      );
    }
  },
});

export const resetAndProcess = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    failedAttempt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.state !== "failed" ||
      receipt.attempts !== args.failedAttempt ||
      receipt.attempts >= MAX_PROCESSING_ATTEMPTS
    ) {
      return;
    }
    await ctx.db.patch(receipt._id, {
      state: "received",
      processingStartedAt: undefined,
      processingToken: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.jotform.dispatchSubmission, {
      receiptId: receipt._id,
    });
  },
});

export const recoverProcessingLease = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    processingToken: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    const now = Date.now();
    if (
      !receipt ||
      receipt.state !== "processing" ||
      receipt.processingToken !== args.processingToken ||
      !receipt.processingStartedAt ||
      receipt.processingStartedAt + PROCESSING_LEASE_MS > now
    ) {
      return;
    }

    if (receipt.attempts < MAX_PROCESSING_ATTEMPTS) {
      await ctx.db.patch(receipt._id, {
        state: "received",
        processingStartedAt: undefined,
        processingToken: undefined,
        lastError: "JOTFORM_PROCESSING_LEASE_EXPIRED",
      });
      await ctx.scheduler.runAfter(
        0,
        internal.jotform.dispatchSubmission,
        { receiptId: receipt._id },
      );
      return;
    }

    await ctx.db.patch(receipt._id, {
      state: "failed",
      processingStartedAt: undefined,
      processingToken: undefined,
      lastError: "JOTFORM_PROCESSING_LEASE_EXPIRED",
    });
    await ctx.db.insert("auditLogs", {
      level: "error",
      category: "jotform",
      action: "submission_processing_lease_expired",
      actorType: "system",
      entityType: "jotform_submission",
      entityId: receipt.submissionId,
      message:
        "A Jotform submission exhausted its processing retries after a worker timeout.",
      detailsJson: JSON.stringify({ attempt: receipt.attempts }),
      createdAt: now,
    });
  },
});

export const processSubmission = internalAction({
  args: {
    receiptId: v.id("externalSubmissions"),
    processingToken: v.string(),
    submissionId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const { content } = await jotformGet<JotformSubmission>(
        `/submission/${encodeURIComponent(args.submissionId)}`,
      );
      const expectedFormId = requiredEnv("JOTFORM_FORM_ID");
      if (String(content.form_id ?? "") !== expectedFormId) {
        throw new Error("JOTFORM_FETCHED_FORM_MISMATCH");
      }
      if (!content.answers || typeof content.answers !== "object") {
        throw new Error("JOTFORM_SUBMISSION_ANSWERS_MISSING");
      }

      const fieldMap = parseFieldMap(
        requiredEnv("JOTFORM_FIELD_MAP_JSON"),
      );
      const timezone =
        process.env.BOOKING_TIME_ZONE?.trim() || "Asia/Singapore";
      const mapped = mapJotformBooking(
        content.answers,
        fieldMap,
        timezone,
        { defaultRecurrenceCount: defaultRecurrenceCount() },
      );
      const snapshot = snapshotJotformAnswers(
        content.answers,
        fieldMap,
      );
      const mappedOccurrences = expandRecurrence({
        startAt: mapped.startAt,
        endAt: mapped.endAt,
        timezone: mapped.timezone,
        frequency: mapped.recurrenceFrequency,
        count: mapped.recurrenceCount,
        untilAt: mapped.recurrenceUntilAt,
      });
      const booking = (await ctx.runMutation(
        internal.bookings.stageJotformSubmission,
        {
          receiptId: args.receiptId,
          processingToken: args.processingToken,
          formId: expectedFormId,
          submissionId: args.submissionId,
          ...mapped,
          // Persist the exact bounded series accepted by Convex. This is
          // especially important when Jotform supplies an until date without
          // an explicit occurrence count.
          recurrenceCount: mappedOccurrences.length,
          formResponses: snapshot.responses,
          formResponsesTruncated: snapshot.truncated,
          formResponseCapturedCount: snapshot.responses.length,
          formResponseFieldCount: snapshot.totalFields,
        },
      )) as Doc<"bookings">;

      // Await the delivery-row mutation before any Google call. The staged
      // mutation also schedules the same idempotent operation as a crash
      // fallback, so a worker termination cannot strand the acknowledgement.
      await ctx.runMutation(
        internal.emailNotifications.prepareBookingReceipt,
        { bookingId: booking._id },
      );
      if (booking.availabilityCheckPending !== true) return;

      const occurrences =
        booking.occurrences ?? [
          {
            sequence: 0,
            startAt: booking.startAt,
            endAt: booking.endAt,
          },
        ];
      const calendarRuntime =
        googleCalendarRuntimeFromEnv(process.env);
      let calendarAvailabilityStatus:
        | "unchecked"
        | "available"
        | "conflict" = "unchecked";
      let calendarConflictSummary: string | undefined;
      if (calendarRuntime) {
        const targets = calendarTargetsForVenue(
          booking.room,
          calendarRuntime.venueMap,
        );
        const availability =
          await calendarRuntime.client.checkAvailability({
            calendarIds: targets.map(
              (target) => target.calendarId,
            ),
            occurrences,
            timeZone: booking.timezone,
          });
        calendarAvailabilityStatus = availability.available
          ? "available"
          : "conflict";
        if (!availability.available) {
          const venueByCalendar = new Map(
            targets.map((target) => [
              target.calendarId,
              target.venue,
            ]),
          );
          calendarConflictSummary = availability.conflicts
            .slice(0, 5)
            .map(
              (conflict) =>
                `${venueByCalendar.get(conflict.calendarId) ?? "Requested venue"}, occurrence ${conflict.occurrenceSequence + 1}: ${conflict.start}–${conflict.end}`,
            )
            .join("; ");
        }
      }
      await ctx.runMutation(
        internal.bookings.finalizeJotformSubmission,
        {
          receiptId: args.receiptId,
          processingToken: args.processingToken,
          bookingId: booking._id,
          calendarIntegrationEnabled: Boolean(calendarRuntime),
          calendarAvailabilityStatus,
          calendarConflictSummary,
        },
      );
    } catch (error) {
      await ctx.runMutation(internal.jotform.markFailed, {
        receiptId: args.receiptId,
        processingToken: args.processingToken,
        errorMessage:
          error instanceof Error ? error.message : "UNKNOWN_JOTFORM_ERROR",
      });
    }
  },
});

export const inspectForm = action({
  args: {},
  handler: async (ctx): Promise<FormInspection> => {
    await requireActionHeadAdmin(ctx);
    const formId = requiredEnv("JOTFORM_FORM_ID");
    const { content, limitLeft } = await jotformGet<
      Record<
        string,
        {
          qid?: string;
          type?: string;
          name?: string;
          text?: string;
          order?: string;
        }
      >
    >(`/form/${encodeURIComponent(formId)}/questions`);

    return {
      formId,
      apiBase: apiBase(),
      apiCallsRemaining: limitLeft,
      questions: Object.entries(content)
        .map(([qid, question]) => ({
          qid: String(question.qid ?? qid),
          type: String(question.type ?? ""),
          name: String(question.name ?? ""),
          text: String(question.text ?? ""),
          order: Number(question.order ?? 0),
        }))
        .sort((first, second) => first.order - second.order),
    };
  },
});

export const retrySubmission = action({
  args: { submissionId: v.string() },
  handler: async (ctx, args): Promise<RetryResult> => {
    await requireActionHeadAdmin(ctx);
    return (await ctx.runMutation(
      internal.jotform.retryBySubmissionId,
      {
        submissionId: args.submissionId.trim(),
      },
    )) as RetryResult;
  },
});

export const retryBySubmissionId = internalMutation({
  args: { submissionId: v.string() },
  handler: async (ctx, args): Promise<RetryResult> => {
    const formId = process.env.JOTFORM_FORM_ID?.trim();
    if (!formId) throw new Error("JOTFORM_FORM_ID_NOT_CONFIGURED");
    const receipt = await ctx.db
      .query("externalSubmissions")
      .withIndex("by_provider_submission", (range) =>
        range
          .eq("provider", "jotform")
          .eq("formId", formId)
          .eq("submissionId", args.submissionId),
      )
      .unique();
    if (!receipt) {
      throw new ConvexError({
        code: "SUBMISSION_NOT_FOUND",
        message: "No webhook receipt has that submission ID.",
      });
    }
    if (receipt.state === "processed") {
      return { state: receipt.state, alreadyProcessed: true };
    }
    const now = Date.now();
    const liveProcessingLease =
      receipt.state === "processing" &&
      Boolean(
        receipt.processingStartedAt &&
          receipt.processingStartedAt + PROCESSING_LEASE_MS > now,
      );
    if (liveProcessingLease) {
      throw new ConvexError({
        code: "SUBMISSION_ALREADY_PROCESSING",
        message:
          "That submission is already being processed. Try again after its five-minute processing lease expires.",
      });
    }
    await ctx.db.patch(receipt._id, {
      state: "received",
      attempts: 0,
      lastError: undefined,
      processingStartedAt: undefined,
      processingToken: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.jotform.dispatchSubmission, {
      receiptId: receipt._id,
    });
    return { state: "received", alreadyProcessed: false };
  },
});
