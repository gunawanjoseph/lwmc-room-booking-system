export function needsCalendarAttemptCleanup(value: {
  calendarAttemptedEvents?: readonly unknown[];
}): boolean {
  return (value.calendarAttemptedEvents?.length ?? 0) > 0;
}

export function partitionCalendarCleanupCandidates<
  T extends {
    calendarAttemptedEvents?: readonly unknown[];
  },
>(values: readonly T[]): {
  cleanupRequired: T[];
  safeToFinalize: T[];
} {
  const cleanupRequired: T[] = [];
  const safeToFinalize: T[] = [];
  for (const value of values) {
    (needsCalendarAttemptCleanup(value)
      ? cleanupRequired
      : safeToFinalize
    ).push(value);
  }
  return { cleanupRequired, safeToFinalize };
}
