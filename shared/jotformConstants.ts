/**
 * Single source of truth for values owned by the Jotform intake contract.
 *
 * Keep labels/aliases that may be changed in Jotform here. Internal domain
 * code should consume these constants rather than repeating the external
 * strings throughout the application.
 */

export const JOTFORM_FORM_ID = "261740998492068";
export const JOTFORM_FORM_URL = `https://submit.jotform.com/${JOTFORM_FORM_ID}`;

export const JOTFORM_API_BASE_URLS = [
  "https://api.jotform.com",
  "https://eu-api.jotform.com",
  "https://hipaa-api.jotform.com",
] as const;

export const JOTFORM_DEFAULT_API_BASE_URL = JOTFORM_API_BASE_URLS[0];

export const JOTFORM_CANONICAL_FIELDS = [
  "requesterName",
  "requesterEmail",
  "room",
  "eventName",
  "purpose",
  "ministry",
  "recurrence",
  "recurrenceHasEndDate",
  "recurrenceCount",
  "recurrenceUntil",
  "start",
  "end",
  "date",
  "startTime",
  "endDate",
  "endTime",
] as const;

export const JOTFORM_NAME_PART_ORDER = [
  "prefix",
  "first",
  "middle",
  "last",
  "suffix",
] as const;

export const JOTFORM_STRUCTURAL_TYPES = [
  "control_button",
  "control_collapse",
  "control_divider",
  "control_head",
  "control_image",
  "control_pagebreak",
  "control_text",
] as const;

/** Labels accepted from the current/legacy Jotform recurrence question. */
export const JOTFORM_RECURRENCE_ALIASES = {
  "": "none",
  none: "none",
  no: "none",
  no_repeat: "none",
  does_not_repeat: "none",
  one_time: "none",
  once: "none",
  daily: "daily",
  every_day: "daily",
  weekly: "weekly_same_day",
  every_week: "weekly_same_day",
  weekly_same_day: "weekly_same_day",
  weekly_on_same_day: "weekly_same_day",
  weekly_on_the_same_day: "weekly_same_day",
  biweekly: "biweekly_same_day",
  fortnightly: "biweekly_same_day",
  fortnightly_every_2_weeks: "biweekly_same_day",
  every_2_weeks: "biweekly_same_day",
  every_two_weeks: "biweekly_same_day",
  every_other_week: "biweekly_same_day",
  biweekly_same_day: "biweekly_same_day",
  biweekly_on_same_day: "biweekly_same_day",
  biweekly_on_the_same_day: "biweekly_same_day",
  every_month_on_same_day: "monthly_same_day",
  every_month_on_the_same_day: "monthly_same_day",
  monthly_same_day: "monthly_same_day",
  monthly_same_weekday: "monthly_same_day",
  monthly_on_same_day: "monthly_same_day",
  monthly_on_the_same_day: "monthly_same_day",
  monthly_on_same_weekday: "monthly_same_day",
  monthly_on_the_same_weekday: "monthly_same_day",
  every_month_on_same_date: "monthly_same_date",
  every_month_on_the_same_date: "monthly_same_date",
  monthly_same_date: "monthly_same_date",
  monthly_on_same_date: "monthly_same_date",
  monthly_on_the_same_date: "monthly_same_date",
} as const;

/** Venue labels currently exposed by the Jotform room question. */
export const JOTFORM_VENUES = [
  "Board Room",
  "Counselling / Music Room",
  "L1 Ministry Space",
  "Ministry Centre A",
  "Ministry Centre B",
  "Ministry Centre C",
  "Office L2 Main Area",
  "Pastor Office",
  "PIC Office",
  "Shema Space",
] as const;

export const JOTFORM_BOOKABLE_VENUES = [
  "Board Room",
  "Counselling / Music Room",
  "L1 Ministry Space",
  "Ministry Centre A",
  "Ministry Centre B",
  "Ministry Centre C",
  "Shema Space",
] as const;

/**
 * Historical/current spellings emitted by Jotform and mapped to canonical
 * physical venues. Values are kept as plain strings so this module remains
 * usable by both Next.js and Convex code.
 */
export const JOTFORM_VENUE_ALIASES = {
  "Church Office L1 Ministry Space": ["L1 Ministry Space"],
  "Church Office Ministry Space": ["L1 Ministry Space"],
  "Ministry Space L1": ["L1 Ministry Space"],
  "Church Office L2 Main Area": ["Office L2 Main Area"],
  "L2 Main Area": ["Office L2 Main Area"],
  "Ministry Centre A & B": ["Ministry Centre A", "Ministry Centre B"],
  "Ministry Centre AB": ["Ministry Centre A", "Ministry Centre B"],
  "Ministry Centre ABC": [
    "Ministry Centre A",
    "Ministry Centre B",
    "Ministry Centre C",
  ],
  "Ministry Centre A, B & C": [
    "Ministry Centre A",
    "Ministry Centre B",
    "Ministry Centre C",
  ],
  "Ministry Centre A, B, & C": [
    "Ministry Centre A",
    "Ministry Centre B",
    "Ministry Centre C",
  ],
  "Ministry Centre A&B&C": [
    "Ministry Centre A",
    "Ministry Centre B",
    "Ministry Centre C",
  ],
} as const;

/** Legacy combined-room labels retained for v0.3 claim compatibility. */
export const JOTFORM_LEGACY_COMBINED_VENUE_ALIASES = {
  "Ministry Centre A": [
    "Ministry Centre A&B",
    "Ministry Centre A & B",
    "Ministry Center A&B",
    "Ministry Center A & B",
    "Ministry Centre ABC",
    "Ministry Center ABC",
    "Ministry Centre A, B & C",
    "Ministry Center A, B & C",
  ],
  "Ministry Centre B": [
    "Ministry Centre A&B",
    "Ministry Centre A & B",
    "Ministry Center A&B",
    "Ministry Center A & B",
    "Ministry Centre ABC",
    "Ministry Center ABC",
    "Ministry Centre A, B & C",
    "Ministry Center A, B & C",
  ],
  "Ministry Centre C": [
    "Ministry Centre ABC",
    "Ministry Center ABC",
    "Ministry Centre A, B & C",
    "Ministry Center A, B & C",
  ],
} as const;
