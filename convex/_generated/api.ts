/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as approvers from "../approvers.js";
import type * as bookingNotices from "../bookingNotices.js";
import type * as bookingOverviewCache from "../bookingOverviewCache.js";
import type * as bookingReminders from "../bookingReminders.js";
import type * as bookingRequests from "../bookingRequests.js";
import type * as bookings from "../bookings.js";
import type * as conflictAdmins from "../conflictAdmins.js";
import type * as crons from "../crons.js";
import type * as emailNotifications from "../emailNotifications.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as googleSheets from "../googleSheets.js";
import type * as googleSheetsDb from "../googleSheetsDb.js";
import type * as http from "../http.js";
import type * as jotform from "../jotform.js";
import type * as lib_actionAuth from "../lib/actionAuth.js";
import type * as lib_auditLog from "../lib/auditLog.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_bookingCalendar from "../lib/bookingCalendar.js";
import type * as lib_bookingDeletion from "../lib/bookingDeletion.js";
import type * as lib_bookingEdit from "../lib/bookingEdit.js";
import type * as lib_bookingList from "../lib/bookingList.js";
import type * as lib_bookingNotice from "../lib/bookingNotice.js";
import type * as lib_bookingOverview from "../lib/bookingOverview.js";
import type * as lib_bookingRules from "../lib/bookingRules.js";
import type * as lib_calendarTransition from "../lib/calendarTransition.js";
import type * as lib_developerIdentity from "../lib/developerIdentity.js";
import type * as lib_emailDecisionClaim from "../lib/emailDecisionClaim.js";
import type * as lib_emailDecisionView from "../lib/emailDecisionView.js";
import type * as lib_emailText from "../lib/emailText.js";
import type * as lib_gmailMessage from "../lib/gmailMessage.js";
import type * as lib_googleCalendar from "../lib/googleCalendar.js";
import type * as lib_googlePublicCalendar from "../lib/googlePublicCalendar.js";
import type * as lib_jotformMapping from "../lib/jotformMapping.js";
import type * as lib_publicBookings from "../lib/publicBookings.js";
import type * as lib_recurrence from "../lib/recurrence.js";
import type * as lib_recurrenceScope from "../lib/recurrenceScope.js";
import type * as lib_requestMinistries from "../lib/requestMinistries.js";
import type * as lib_requesterRules from "../lib/requesterRules.js";
import type * as lib_requesterWorkflow from "../lib/requesterWorkflow.js";
import type * as lib_submitterBookings from "../lib/submitterBookings.js";
import type * as lib_supportRules from "../lib/supportRules.js";
import type * as lib_userMigration from "../lib/userMigration.js";
import type * as logs from "../logs.js";
import type * as myBookings from "../myBookings.js";
import type * as publicCalendar from "../publicCalendar.js";
import type * as support from "../support.js";
import type * as techSupport from "../techSupport.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  approvers: typeof approvers;
  bookingNotices: typeof bookingNotices;
  bookingOverviewCache: typeof bookingOverviewCache;
  bookingReminders: typeof bookingReminders;
  bookingRequests: typeof bookingRequests;
  bookings: typeof bookings;
  conflictAdmins: typeof conflictAdmins;
  crons: typeof crons;
  emailNotifications: typeof emailNotifications;
  googleCalendar: typeof googleCalendar;
  googleSheets: typeof googleSheets;
  googleSheetsDb: typeof googleSheetsDb;
  http: typeof http;
  jotform: typeof jotform;
  "lib/actionAuth": typeof lib_actionAuth;
  "lib/auditLog": typeof lib_auditLog;
  "lib/auth": typeof lib_auth;
  "lib/bookingCalendar": typeof lib_bookingCalendar;
  "lib/bookingDeletion": typeof lib_bookingDeletion;
  "lib/bookingEdit": typeof lib_bookingEdit;
  "lib/bookingList": typeof lib_bookingList;
  "lib/bookingNotice": typeof lib_bookingNotice;
  "lib/bookingOverview": typeof lib_bookingOverview;
  "lib/bookingRules": typeof lib_bookingRules;
  "lib/calendarTransition": typeof lib_calendarTransition;
  "lib/developerIdentity": typeof lib_developerIdentity;
  "lib/emailDecisionClaim": typeof lib_emailDecisionClaim;
  "lib/emailDecisionView": typeof lib_emailDecisionView;
  "lib/emailText": typeof lib_emailText;
  "lib/gmailMessage": typeof lib_gmailMessage;
  "lib/googleCalendar": typeof lib_googleCalendar;
  "lib/googlePublicCalendar": typeof lib_googlePublicCalendar;
  "lib/jotformMapping": typeof lib_jotformMapping;
  "lib/publicBookings": typeof lib_publicBookings;
  "lib/recurrence": typeof lib_recurrence;
  "lib/recurrenceScope": typeof lib_recurrenceScope;
  "lib/requestMinistries": typeof lib_requestMinistries;
  "lib/requesterRules": typeof lib_requesterRules;
  "lib/requesterWorkflow": typeof lib_requesterWorkflow;
  "lib/submitterBookings": typeof lib_submitterBookings;
  "lib/supportRules": typeof lib_supportRules;
  "lib/userMigration": typeof lib_userMigration;
  logs: typeof logs;
  myBookings: typeof myBookings;
  publicCalendar: typeof publicCalendar;
  support: typeof support;
  techSupport: typeof techSupport;
  users: typeof users;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
