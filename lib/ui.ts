export function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    const dataMatch = message.match(
      /"message"\s*:\s*"([^"]+)"/,
    );
    if (dataMatch?.[1]) return dataMatch[1];
    return message
      .replace(/^Uncaught (ConvexError|Error):\s*/i, "")
      .replace(/\s+at\s+[\s\S]*$/, "")
      .slice(0, 600);
  }
  return "Something went wrong. Check the system logs and try again.";
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
