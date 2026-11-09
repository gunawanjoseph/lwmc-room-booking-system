import { DateTime } from "luxon";
import { writeAuditLog } from "./lib/auditLog";
import { ConvexError, v } from "convex/values";
import {
  JOTFORM_API_BASE_URLS,
  JOTFORM_DEFAULT_API_BASE_URL,
} from "../shared/jotformConstants";
import {
  action,
  internalAction,
  internalMutation,
  type MutationCtx,
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
import { JOTFORM_ATTEMPT_OFFSETS_MS, JOTFORM_ATTENTION_AFTER_MS, nextJotformRetryAt } from "../shared/jotformRetry";

type JotformEnvelope<T> = {
  responseCode?: number;
  message?: string;
  content?: T;
  "limit-left"?: number;
};

type JotformSubmission = {
  created_at?: string;
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

const ALLOWED_API_BASES = new Set<string>(JOTFORM_API_BASE_URLS);
const MAX_PROCESSING_ATTEMPTS = JOTFORM_ATTEMPT_OFFSETS_MS.length;
const PROCESSING_LEASE_MS = 5 * 60_000;

async function recordSubmissionFailure(ctx: MutationCtx, receipt: Doc<"externalSubmissions">, error: string) {
  const now = Date.now();
  const retryStartedAt = receipt.retryStartedAt ?? receipt.firstReceivedAt;
  const nextRetryAt = nextJotformRetryAt(retryStartedAt, receipt.attempts, now);
  const needsAttention = nextRetryAt === undefined || now - retryStartedAt >= JOTFORM_ATTENTION_AFTER_MS;
  const firstAttention = needsAttention && receipt.attentionNotifiedAt === undefined;
  await ctx.db.patch(receipt._id, {
    state: "failed", lastError: error.slice(0, 500), processingStartedAt: undefined, processingToken: undefined,
    retryStartedAt, nextRetryAt, failureCount: (receipt.failureCount ?? Math.max(0, receipt.attempts - 1)) + 1,
    ...(firstAttention ? { attentionNotifiedAt: now } : {}),
  });
  await writeAuditLog(ctx, {
    level: nextRetryAt === undefined ? "error" : firstAttention ? "warning" : "info",
    category: "jotform", actorType: "system", entityType: "jotform_submission", entityId: receipt.submissionId,
    action: nextRetryAt === undefined ? "submission_processing_failed" : firstAttention ? "submission_processing_attention" : "submission_retry_scheduled",
    message: nextRetryAt === undefined ? "Jotform submission needs attention. Automatic retries are exhausted; retry it manually after checking the integration."
      : firstAttention ? "Jotform submission is still delayed and needs attention. Automatic retries will continue."
      : "Jotform submission delayed. An automatic retry is scheduled.",
    detailsJson: JSON.stringify({ error: error.slice(0, 500), attempt: receipt.attempts, nextRetryAt }), createdAt: now,
  });
  if (nextRetryAt !== undefined) await ctx.scheduler.runAfter(nextRetryAt - now, internal.jotform.resetAndProcess, {
    receiptId: receipt._id, failedAttempt: receipt.attempts, retryRun: receipt.retryRun ?? 0,
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function apiBase(): string {
  const base = (
    process.env.JOTFORM_API_BASE_URL ?? JOTFORM_DEFAULT_API_BASE_URL
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
      if (processingLeaseExpired) {
        await ctx.db.patch(existing._id, { deliveryCount: existing.deliveryCount + 1, lastReceivedAt: now });
        await recordSubmissionFailure(ctx, existing, "JOTFORM_PROCESSING_LEASE_EXPIRED");
        return { accepted: true, duplicate: true, state: "failed" };
      }
      const shouldRetry = existing.state === "failed" && existing.attempts < MAX_PROCESSING_ATTEMPTS
        && (existing.nextRetryAt === undefined || existing.nextRetryAt <= now);
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
        nextRetryAt: shouldRetry ? undefined : existing.nextRetryAt,
      });
      if (shouldDispatch) {
        await ctx.scheduler.runAfter(
          0,
          internal.jotform.dispatchSubmission,
          { receiptId: existing._id, retryRun: existing.retryRun ?? 0 },
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
  args: { receiptId: v.id("externalSubmissions"), retryRun: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.state !== "received" ||
      (receipt.retryRun ?? 0) !== (args.retryRun ?? 0) ||
      receipt.attempts >= MAX_PROCESSING_ATTEMPTS
    ) {
      return;
    }
    const now = Date.now();
    const processingToken = `${String(receipt._id)}:${receipt.retryRun ?? 0}:${receipt.attempts + 1}:${now}`;

    await ctx.db.patch(receipt._id, {
      state: "processing",
      attempts: receipt.attempts + 1,
      processingStartedAt: now,
      processingToken,
      retryStartedAt: receipt.retryStartedAt ?? now,
      nextRetryAt: undefined,
    });
    if (receipt.attempts === 0) await ctx.scheduler.runAfter(JOTFORM_ATTENTION_AFTER_MS, internal.jotform.flagDelayedSubmission, {
      receiptId: receipt._id, retryRun: receipt.retryRun ?? 0,
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
    await recordSubmissionFailure(ctx, receipt, args.errorMessage);
  },
});

export const flagDelayedSubmission = internalMutation({
  args: { receiptId: v.id("externalSubmissions"), retryRun: v.number() },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.state === "processed" || (receipt.retryRun ?? 0) !== args.retryRun
      || receipt.attentionNotifiedAt !== undefined || (receipt.failureCount ?? 0) === 0) return;
    const now = Date.now();
    if (now < (receipt.retryStartedAt ?? receipt.firstReceivedAt) + JOTFORM_ATTENTION_AFTER_MS) return;
    await ctx.db.patch(receipt._id, { attentionNotifiedAt: now });
    await writeAuditLog(ctx, {
      level: "warning", category: "jotform", action: "submission_processing_attention", actorType: "system",
      entityType: "jotform_submission", entityId: receipt.submissionId,
      message: "Jotform submission is still delayed after 15 minutes and needs attention. Automatic retries will continue.",
      detailsJson: JSON.stringify({ attempt: receipt.attempts, nextRetryAt: receipt.nextRetryAt, error: receipt.lastError }), createdAt: now,
    });
  },
});

export const resetAndProcess = internalMutation({
  args: {
    receiptId: v.id("externalSubmissions"),
    failedAttempt: v.number(),
    retryRun: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (
      !receipt ||
      receipt.state !== "failed" ||
      receipt.attempts !== args.failedAttempt ||
      (receipt.retryRun ?? 0) !== (args.retryRun ?? 0) ||
      receipt.attempts >= MAX_PROCESSING_ATTEMPTS
    ) {
      return;
    }
    if (receipt.nextRetryAt !== undefined && receipt.nextRetryAt > Date.now()) return;
    await ctx.db.patch(receipt._id, {
      state: "received",
      processingStartedAt: undefined,
      processingToken: undefined,
      nextRetryAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.jotform.dispatchSubmission, {
      receiptId: receipt._id, retryRun: receipt.retryRun ?? 0,
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

    await recordSubmissionFailure(ctx, receipt, "JOTFORM_PROCESSING_LEASE_EXPIRED");
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
        // Passed lazily so a misconfigured BOOKING_RECURRENCE_DEFAULT_COUNT
        // only fails recurring submissions that actually need the default,
        // not every submission (including "Does not repeat" ones).
        { defaultRecurrenceCount },
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
      const submitted = typeof content.created_at === "string"
        ? DateTime.fromISO(content.created_at.replace(" ", "T"), {zone:process.env.JOTFORM_SUBMISSION_TIME_ZONE?.trim()||timezone}) : null;
      const booking = (await ctx.runMutation(
        internal.bookings.stageJotformSubmission,
        {
          receiptId: args.receiptId,
          processingToken: args.processingToken,
          formId: expectedFormId,
          submissionId: args.submissionId,
          ...mapped,
          submittedAt: submitted?.isValid ? submitted.toMillis() : undefined,
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
      failureCount: receipt.failureCount ?? receipt.attempts,
      retryRun: (receipt.retryRun ?? 0) + 1,
      retryStartedAt: undefined,
      nextRetryAt: undefined,
      attentionNotifiedAt: undefined,
      lastError: undefined,
      processingStartedAt: undefined,
      processingToken: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.jotform.dispatchSubmission, {
      receiptId: receipt._id,
      retryRun: (receipt.retryRun ?? 0) + 1,
    });
    return { state: "received", alreadyProcessed: false };
  },
});
