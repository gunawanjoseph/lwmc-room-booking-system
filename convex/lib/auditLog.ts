import { configuredDeveloperEmail } from "./developerIdentity";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

export function needsSupportAlert(log: {level: string; action: string; message: string}): boolean {
  if (log.action.startsWith("tech_alert_")) return false;
  return log.level === "warning" || log.level === "error" ||
    /fail(?:ed|ure)?|suspicious|unauthori[sz]ed|forbidden|denied|timeout|expired|collision/i.test(`${log.action} ${log.message}`);
}

/** Insert the audit record and durable alert outbox in the same transaction. */
export async function writeAuditLog(
  ctx: MutationCtx,
  log: Omit<Doc<"auditLogs">, "_id" | "_creationTime">,
): Promise<Id<"auditLogs">> {
  const logId = await ctx.db.insert("auditLogs", log);
  if (!needsSupportAlert(log)) return logId;
  const email = configuredDeveloperEmail();
  if (email) {
    const deliveryId = await ctx.db.insert("techAlertDeliveries", {
      logId, email,
      status: "pending", attempts: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.emailNotifications.sendTechAlert, { deliveryId });
  }
  return logId;
}
