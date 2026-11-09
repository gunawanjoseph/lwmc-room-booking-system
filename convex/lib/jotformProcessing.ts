import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAuditLog } from "./auditLog";

/** Commit processing and recovery together, including idempotent staging paths. */
export async function completeJotformProcessing(ctx: MutationCtx, receipt: Doc<"externalSubmissions">, now: number) {
  const recovered = receipt.attempts > 1 || (receipt.failureCount ?? 0) > 0;
  await ctx.db.patch(receipt._id, {
    state: "processed", lastError: undefined, processingStartedAt: undefined,
    processingToken: undefined, nextRetryAt: undefined,
    recoveredAt: recovered ? now : receipt.recoveredAt,
  });
  if (recovered) await writeAuditLog(ctx, {
    level: "info", category: "jotform", action: "submission_recovered",
    actorType: "system", entityType: "jotform_submission", entityId: receipt.submissionId,
    message: "Jotform submission recovered after retry.",
    detailsJson: JSON.stringify({ attempt: receipt.attempts, failureCount: receipt.failureCount, recoveredAt: now }),
    createdAt: now,
  });
}
