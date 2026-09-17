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
import type * as myBookings from "../myBookings.js";
import type * as bookings from "../bookings.js";
import type * as conflictAdmins from "../conflictAdmins.js";
import type * as emailNotifications from "../emailNotifications.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as googleSheets from "../googleSheets.js";
import type * as googleSheetsDb from "../googleSheetsDb.js";
import type * as http from "../http.js";
import type * as jotform from "../jotform.js";
import type * as lib_actionAuth from "../lib/actionAuth.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_bookingDeletion from "../lib/bookingDeletion.js";
import type * as lib_bookingEdit from "../lib/bookingEdit.js";
import type * as lib_bookingOverview from "../lib/bookingOverview.js";
import type * as lib_bookingRules from "../lib/bookingRules.js";
import type * as lib_calendarTransition from "../lib/calendarTransition.js";
import type * as lib_emailDecisionClaim from "../lib/emailDecisionClaim.js";
import type * as lib_emailDecisionView from "../lib/emailDecisionView.js";
import type * as lib_emailText from "../lib/emailText.js";
import type * as lib_gmailMessage from "../lib/gmailMessage.js";
import type * as lib_googleCalendar from "../lib/googleCalendar.js";
import type * as lib_jotformMapping from "../lib/jotformMapping.js";
import type * as lib_recurrence from "../lib/recurrence.js";
import type * as lib_userMigration from "../lib/userMigration.js";
import type * as logs from "../logs.js";
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
  bookings: typeof bookings;
  bookingNotices: typeof bookingNotices;
  myBookings: typeof myBookings;
  conflictAdmins: typeof conflictAdmins;
  emailNotifications: typeof emailNotifications;
  googleCalendar: typeof googleCalendar;
  googleSheets: typeof googleSheets;
  googleSheetsDb: typeof googleSheetsDb;
  http: typeof http;
  jotform: typeof jotform;
  "lib/actionAuth": typeof lib_actionAuth;
  "lib/auth": typeof lib_auth;
  "lib/bookingDeletion": typeof lib_bookingDeletion;
  "lib/bookingEdit": typeof lib_bookingEdit;
  "lib/bookingOverview": typeof lib_bookingOverview;
  "lib/bookingRules": typeof lib_bookingRules;
  "lib/calendarTransition": typeof lib_calendarTransition;
  "lib/emailDecisionClaim": typeof lib_emailDecisionClaim;
  "lib/emailDecisionView": typeof lib_emailDecisionView;
  "lib/emailText": typeof lib_emailText;
  "lib/gmailMessage": typeof lib_gmailMessage;
  "lib/googleCalendar": typeof lib_googleCalendar;
  "lib/jotformMapping": typeof lib_jotformMapping;
  "lib/recurrence": typeof lib_recurrence;
  "lib/userMigration": typeof lib_userMigration;
  logs: typeof logs;
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
