export function formatLocalDateTime(
  timestamp: number,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(new Date(timestamp));
}

export function formatLocalDate(
  timestamp: number,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "long",
    timeZone,
  }).format(new Date(timestamp));
}
