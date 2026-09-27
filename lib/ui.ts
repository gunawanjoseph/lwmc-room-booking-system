export function messageFromError(error: unknown): string {
  const fallback = "We couldn’t complete this action. Please refresh and try again.";
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  let message = typeof data === "string" ? data : data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : error instanceof Error ? error.message : "";
  const json = message.match(/\{"code"[^\n]*\}/)?.[0];
  if (json) { try { message = JSON.parse(json).message ?? ""; } catch { return fallback; } }
  if (/BOOKING_EDIT_CONFLICT|BOOKING_NOT_FOUND|BOOKING_STATE_CHANGED|REQUEST_STATE_CHANGED|booking (?:has )?changed|no longer exists/i.test(message)) return "This booking has been updated. Please review the latest booking details before trying again.";
  if (message.includes("ConvexError:")) message = message.slice(message.indexOf("ConvexError:") + 12);
  message = message.replace(/^Uncaught Error:\s*/i, "").split(/\n\s*at\s/)[0].trim();
  if (!message || /\[CONVEX|Request ID:|Server Error|Stack trace|\b[A-Z][A-Z_]{5,}\b|https?:\/\//.test(message)) return fallback;
  return message.slice(0, 600);
}

export function formatDateTime(
  timestamp: number,
  timezone?: string,
): string {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone || "Asia/Singapore",
  }).format(new Date(timestamp));
}

export function formatDate(
  timestamp: number,
  timezone?: string,
): string {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeZone: timezone || "Asia/Singapore",
  }).format(new Date(timestamp));
}
