# RoomOps integration setup

This guide connects RoomOps to Clerk, Convex,
[Jotform form 261740998492068](https://submit.jotform.com/261740998492068),
Google Calendar, and Vercel.

RoomOps uses one booking-data path:

1. Jotform posts a submission ID to the secure Convex webhook.
2. A Convex action retrieves the authoritative submission from Jotform
   with a server-only API key.
3. Convex maps the core booking fields and expands any recurrence into
   concrete occurrences, rejecting self-overlapping series and requests
   that would exceed 2,000 reservation claim slots.
4. Convex stores a visible booking and bounded, text-safe response
   snapshot keyed by each Jotform question ID (`qid`), then durably
   queues the requester acknowledgement.
5. Convex checks pending and approved overlaps plus Google Calendar
   availability for every occurrence and physical venue. Approver and
   unavailable follow-ups are created only after this step completes.
6. `/sheet` reads and edits the authorized fields directly in Convex.
7. Approval rechecks Google availability and creates the accepted event
   on each required venue calendar.
8. Approved requester and title-field edits reconcile the existing
   managed Calendar events.

If Google Calendar configuration or FreeBusy temporarily fails after
step 4, the saved row remains visible with **Availability check pending**.
The Jotform receipt remains failed/retryable and no approver or rejection
follow-up is sent until a retry completes the availability result.

There is no Google Sheet, embedded worksheet, or spreadsheet-header
contract in this design. Adding a non-core question such as **Remarks**
does not require a RoomOps code change: its answer becomes a dynamic
qid-keyed column after a new submission includes it.

Do not commit API keys, Clerk secret keys, webhook secrets, Google
service-account keys, or deploy keys.

## 1. Environment variables

### Local Next.js variables

Copy `.env.local.example` to `.env.local`.

| Variable | Purpose |
|---|---|
| `CONVEX_DEPLOYMENT` | Selects the personal Convex development deployment. `npx convex dev` normally writes it. Do not copy it to Vercel. |
| `NEXT_PUBLIC_CONVEX_URL` | Browser connection to the Convex data endpoint. Convex writes it locally and injects production during the Vercel build command. |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Non-secret `.convex.site` base URL displayed in the webhook helper. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk browser key for the matching development or production instance. |
| `CLERK_SECRET_KEY` | Clerk server key for that same instance. |
| Clerk route variables | Keep the values shown in `.env.local.example`. |

### Convex server variables

Set these once in development and again in production:

```bash
npx convex env set NAME
npx convex env --prod set NAME
```

| Variable | Purpose |
|---|---|
| `CLERK_JWT_ISSUER_DOMAIN` | Clerk Frontend API URL accepted by Convex authentication. |
| `HEAD_ADMIN_CLERK_USER_ID` | Exact Clerk `user_...` subject for the sole Head Administrator. |
| `JOTFORM_FORM_ID` | Accepted form ID: `261740998492068`. |
| `JOTFORM_API_BASE_URL` | Jotform API origin, normally `https://api.jotform.com`. |
| `JOTFORM_API_KEY` | Server-only read key for form questions and submissions. |
| `JOTFORM_WEBHOOK_SECRET` | Random secret included in the webhook URL. |
| `JOTFORM_FIELD_MAP_JSON` | Stable question-ID mapping for core booking fields. |
| `BOOKING_TIME_ZONE` | IANA zone used for answers without an offset, such as `Asia/Singapore`. |
| `GOOGLE_CALENDAR_ENABLED` | `true` enables Google free/busy checks and approved-event writes; keep `false` until setup is complete. |
| `GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64` | Base64-encoded Google service-account JSON used only by Convex actions. |
| `GOOGLE_CALENDAR_VENUE_MAP_JSON` | JSON mapping all ten individual venue names to their real Google Calendar IDs. |
| `BOOKING_RECURRENCE_DEFAULT_COUNT` | Occurrence count used when a repeating request supplies neither count nor until date; default `12`, allowed `2`–`120`. |
| `APP_BASE_URL` | Public application origin used in secure email-decision and conflict-review links. |
| `GMAIL_CLIENT_ID` | OAuth web client ID for the notification mailbox. |
| `GMAIL_CLIENT_SECRET` | Server-only secret for that OAuth client. |
| `GMAIL_REFRESH_TOKEN` | Offline refresh token authorized for `gmail.send`. |
| `GMAIL_FROM_EMAIL` | Authenticated mailbox or verified Gmail send-as alias. |

No Google Sheets credential, spreadsheet ID, worksheet GID, Sheet range,
or expected header list is required. Google Calendar uses a distinct
service-account variable and venue-to-Calendar-ID map. Keep both in
Convex, not `.env.local` or Vercel. Configure the Gmail variables with
the separate procedure in [GMAIL_SETUP.md](GMAIL_SETUP.md).

### Vercel-only variable

| Variable | Purpose |
|---|---|
| `CONVEX_DEPLOY_KEY` | Production Convex deploy key used by the Vercel build command. Scope it to Production. |

## 2. Install and create the Convex project

Requirements:

- Node.js 20.9 or later
- Clerk, Convex, Jotform, Google Cloud, Google Calendar, and Vercel
  accounts
- Owner access to the Jotform form
- Permission to share and edit all ten venue calendars

Run:

```bash
npm install
cp .env.local.example .env.local
npx convex dev
```

Select or create the Convex project. The first function push may pause
because `CLERK_JWT_ISSUER_DOMAIN` is not set. Complete the next section
from a second terminal, then let the watcher retry.

## 3. Connect Clerk and create the Head Administrator

### 3.1 Configure Clerk

1. Create a Clerk application.
2. Require an email address and email verification.
3. Copy its development keys to `.env.local`:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/home
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/register
```

4. In Clerk, activate **Integrations → Convex**.
5. Copy the matching Clerk Frontend API URL and set it:

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN
```

6. In **Sessions → Customize session token → Claims**, preserve existing
   claims and include:

```json
{
  "aud": "convex",
  "email": "{{user.primary_email_address}}",
  "email_verified": "{{user.email_verified}}",
  "name": "{{user.full_name}}"
}
```

7. Sign out completely and sign in again so Clerk issues a new token.

The email claims prevent `AUTH_IDENTITY_MISSING_EMAIL` during
registration.

### 3.2 Anchor the Head Administrator

1. Create or sign up the intended Head Administrator.
2. Open that person in **Clerk Dashboard → Users**.
3. Copy the exact ID beginning with `user_`.
4. Set it in the matching Convex deployment:

```bash
npx convex env set HEAD_ADMIN_CLERK_USER_ID
```

5. Run `npm run dev`, sign in as that person, open `/register`, and submit.

Only that exact identity becomes Head Administrator. Other sign-ups submit
pending administrator requests that the Head Administrator must approve.

## 4. Connect Jotform directly to Convex

### 4.1 Configure the Jotform API

Create a Jotform API key with read access, then set:

```bash
npx convex env set JOTFORM_API_KEY
npx convex env set JOTFORM_FORM_ID 261740998492068
npx convex env set JOTFORM_API_BASE_URL https://api.jotform.com
npx convex env set BOOKING_TIME_ZONE Asia/Singapore
```

Use `https://eu-api.jotform.com` or
`https://hipaa-api.jotform.com` only when the Jotform account requires
that endpoint.

Repeat the commands with `--prod` for production. Use a production API
key and the production deployment's settings.

### 4.2 Map stable question IDs for the core fields

1. Sign in as Head Administrator.
2. Open `/admin/integrations`.
3. Select **Inspect configured form**.
4. Map requester name, requester email, room, optional event name,
   purpose, ministry, recurrence fields (including the new end-date
   Yes/No and last-date questions), and the required date/time fields.
5. Copy the generated JSON.
6. Set it:

```bash
npx convex env set JOTFORM_FIELD_MAP_JSON
```

Example for one date and separate start/end times:

```json
{"requesterName":"3","requesterEmail":"4","room":"5","eventName":"9","purpose":"10","ministry":"11","recurrence":"12","recurrenceHasEndDate":"13","recurrenceUntil":"14","date":"6","startTime":"7","endTime":"8"}
```

Example for a booking that can cross midnight:

```json
{"requesterName":"3","requesterEmail":"4","room":"5","date":"6","startTime":"7","endDate":"8","endTime":"9"}
```

Use the qids from the inspector, not the example numbers. The optional
recurrence keys are:

- `recurrence` — **No repeat**, **Daily**, **Every week**,
  **Every 2 weeks**, **Every month on the same day**, or
  **Every month on the same date**;
- `recurrenceHasEndDate` — the answer to
  **Does this recurring booking have an end date?**;
- `recurrenceUntil` — the answer to
  **What is the LAST date required for the booking?**; and
- `recurrenceCount` — optional compatibility mapping for an older form
  that supplied a total occurrence count.

For a repeating request, **Yes** requires a nonblank last date and that
date is inclusive in `BOOKING_TIME_ZONE`. **No** deliberately ignores
any stale hidden last-date value and uses
`BOOKING_RECURRENCE_DEFAULT_COUNT`. If
`recurrenceHasEndDate` is absent from an older deployment's mapping,
RoomOps preserves the earlier behavior: it honors a supplied
`recurrenceUntil`, otherwise it uses the configured default count.
If an upgraded environment still maps the retired
`recurrenceCount` question together with `recurrenceHasEndDate`, the new
Yes/No answer is authoritative: **Yes** uses the last date and **No**
uses `BOOKING_RECURRENCE_DEFAULT_COUNT`. Remove the obsolete count
mapping after confirming the new questions.
Multi-occurrence series may not cross a daylight-saving or other
UTC-offset transition in `BOOKING_TIME_ZONE`; split those requests into
series on one side of the transition or use one-time bookings for the
affected dates. Conflict checks globally deduplicate current and legacy
claim-room aliases before querying. If the unique-alias count multiplied
by all UTC dates touched across the occurrences exceeds the conservative
3,000-range transaction budget, RoomOps rejects the request with
`BOOKING_CONFLICT_LOOKUP_RANGE_LIMIT_EXCEEDED`.

The core mapping is deliberately qid-based:

- Reordering questions is safe.
- Renaming a label is safe because the mapping uses its `qid`.
- Adding a non-core question is safe and needs no mapping.
- Deleting and recreating a mapped core question can assign a new `qid`.
  Inspect the form and update the mapping before accepting more bookings.

Core fields drive availability and the canonical booking workflow.
Additional response fields are captured separately as bounded text keyed
by qid. Their latest labels are presentation metadata, not database keys,
so a label or hypothetical spreadsheet header change cannot disconnect
the stored values.

The response snapshot has defensive limits of 80 fields, 4,000
characters per field, and 50,000 answer characters per submission.
Canonical booking fields are stored separately and are not lost if a
snapshot reaches a limit. RoomOps marks a capped snapshot in `/sheet` and
writes the counts to the system log. Within the field limit, canonical
fields and newer, higher question IDs are retained first.

### 4.3 Add the secure webhook

Generate a separate random secret for each deployment:

```bash
openssl rand -hex 32
npx convex env set JOTFORM_WEBHOOK_SECRET
```

Find the current Convex HTTP Actions hostname ending in `.convex.site`.
Construct:

```text
https://YOUR-DEPLOYMENT.convex.site/webhooks/jotform?secret=YOUR_RANDOM_SECRET
```

In the Jotform Form Builder:

1. Open form `261740998492068`.
2. Choose **Settings → Integrations → Webhooks**.
3. Enter the complete URL.
4. Finish the integration.

RoomOps validates the secret and configured form, accepts only a valid
submission ID, and queues processing. The server then retrieves the
submission from Jotform; it does not trust booking values copied from the
webhook request. Repeated delivery of the same submission ID is
idempotent.

For production, set the production webhook secret with `--prod` and add
the production `.convex.site` URL as a separate Jotform webhook.

References: [Jotform webhook setup](https://www.jotform.com/help/245-how-to-send-submission-data-via-a-webhook/)
and [Convex HTTP Actions](https://docs.convex.dev/functions/http-actions).

## 5. Connect Google Calendar

Follow [GOOGLE_CALENDAR_SETUP.md](GOOGLE_CALENDAR_SETUP.md) for the
complete setup and test procedure. In summary:

1. Enable the Google Calendar API in a Google Cloud project.
2. Create a service account and download its JSON key.
3. Share each of the ten individual venue calendars with the service
   account using **Make changes to events** permission.
4. Copy each real **Calendar ID** from **Settings and sharing →
   Integrate calendar**.
5. Build `GOOGLE_CALENDAR_VENUE_MAP_JSON` with all ten individual venues.
   Do not create combined A & B or ABC map entries.
6. Set the four Calendar and recurrence variables in the target Convex
   deployment, initially keeping `GOOGLE_CALENDAR_ENABLED=false`.
7. Deploy the new Convex functions and frontend while Calendar automation
   is disabled.
8. As Head Administrator, open `/admin/integrations` and run
   **Normalize reservation claims → Rebuild active claims**. Select
   **Continue** until it reports **Finished**. If it reports skipped
   bookings, resolve them and run the normalization again. The migration
   intentionally rebuilds at most two bookings per Convex mutation so
   removing old claims plus inserting new claims stays safely below the
   transaction write limit.
9. Set `GOOGLE_CALENDAR_ENABLED=true`, then immediately run the
   configuration check. Confirm every returned Google calendar name
   matches its RoomOps venue and every access role is `writer` or
   `owner`. Set it back to `false` while correcting any failed check:

```bash
npx convex env set GOOGLE_CALENDAR_ENABLED false
npx convex env set BOOKING_RECURRENCE_DEFAULT_COUNT 12

base64 < /PATH/TO/service-account.json \
  | tr -d '\n' \
  | npx convex env set GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64

npx convex env set GOOGLE_CALENDAR_VENUE_MAP_JSON \
  --from-file /PATH/TO/google-calendar-map.json
```

After deployment and successful claim normalization, enable the
integration:

```bash
npx convex env set GOOGLE_CALENDAR_ENABLED true
```

Repeat this exact order with `--prod` in production. Complete
normalization once in each existing environment before enabling Calendar
automation or accepting and approving normal requests.

The required venue-map keys are Board Room, Counselling / Music Room, L1
Ministry Space, Ministry Centre A, Ministry Centre B, Ministry Centre C,
Office L2 Main Area, Pastor Office, PIC Office, and Shema Space.

Ministry Centre A & B checks and books A plus B. Ministry Centre ABC
checks and books A, B, and C. Every occurrence and physical venue must be
available. Approval performs a second availability check before writing
events.

The supported repeat modes are no repeat, daily, every week, every two
weeks, monthly on the same ordinal weekday, and monthly on the same
numerical date. Monthly rules skip a month when the requested date or
ordinal weekday does not exist. Occurrences within one request cannot
overlap. A request is also limited to 2,000 claim slots, counted across
the UTC dates touched by every occurrence and every physical venue. See
the detailed guide for end-date rules and test cases.

## 6. Use the Convex booking-data table

Open `/sheet` after a Jotform submission has been processed.

The table contains fixed booking columns and discovers non-core form
columns by qid. Adding a Remarks question therefore requires only:

1. Add and publish the question in Jotform.
2. Submit a test response that answers it.
3. Confirm the submission appears in Convex.
4. Open `/sheet` and confirm the new qid-keyed column is present.

Existing bookings created before response snapshots were introduced do
not acquire historical non-core answers automatically.
Once a question has been seen and cataloged by Convex, a Data Editor can
fill its blank cell on another booking; the browser cannot invent unknown
or canonical question IDs.

### Role behavior

| Role | View data table | Download XLSX | Approve/reject | Edit table data | Edit canonical booking | Delete booking | Manage users/integrations |
|---|---:|---:|---:|---:|---:|---:|---:|
| Head Administrator | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Booking Viewer | Yes | Yes | No | No | No | No | No |
| Booking Approver | Yes | Yes | Yes | No | No | No | No |
| Data Editor | Yes | Yes | No | Yes | No | Yes | No |
| Booking Manager | Yes | Yes | Yes | Yes | Yes | Yes | No |

All table viewers may download the authorized booking data as `.xlsx`.
The workbook includes canonical columns and qid-keyed dynamic columns.
An export includes up to 10,000 newest bookings and 150 dynamic fields;
the most recently seen dynamic fields take priority, and the page reports
when either safety cap omits data. The workbook also identifies bookings
whose original response snapshot was capped or predates snapshot capture.

Head Administrator, Data Editor, and Booking Manager may enter table edit
mode, change requester name, requester email, event name, purpose,
ministry, or non-core responses, and save the batch to Convex. For an
approved booking, requester name/email changes reconcile the Calendar
description only when the requester name changes; requester email stays
private to Convex and email notifications. Event Name, Purpose, and
Ministry changes reconcile the title and description. Room and time
remain booking fields, while status and approve/reject remain workflow
operations; use `/bookings` for those actions.

If an approved-booking reconciliation fails, `/bookings` shows
**Calendar action needs attention**. Head Administrator and Booking
Manager may select the circular-arrow **Retry Google Calendar
synchronization** action. Data Editor can make an authorized table edit,
but does not have the canonical `bookings.edit` capability required to
retry a failed approved-booking synchronization.

Convex enforces these permissions in the query or mutation, not only in
the browser. A table save uses record revisions so one administrator does
not silently overwrite another administrator's newer change. Reload the
data and reapply the intended edit if a conflict is reported.

Head Administrator, Data Editor, and Booking Manager may also delete a
booking from Booking data; Head Administrator and Booking Manager also
see the same action in Bookings. This is a coordinated deletion, not a
raw row removal. RoomOps acquires a per-booking lease, verifies the
ownership metadata and ETag of every stored managed or attempted Google
Calendar event, removes those events, and only then atomically deletes
the Convex booking, claims, and decision links while cancelling
outstanding email work. If Google cleanup fails, the row and event
references remain available for a safe retry. Booking Approver and
Booking Viewer cannot invoke this action, even by calling Convex
directly. The same action may remove an intake row stranded during its
availability check: it invalidates the receipt and prevents a late
worker from finalizing or sending new workflow messages for the removed
booking.

## 7. Upgrade from the v0.2 Google Sheets API mirror

This section applies only to an installation that previously configured
the API-based Google Sheets mirror.

Complete this order for development and production:

1. Stop new legacy synchronization:

```bash
npx convex env set GOOGLE_SHEETS_AUTO_SYNC false
npx convex env --prod set GOOGLE_SHEETS_AUTO_SYNC false
```

2. Wait at least **11 minutes** for the longest legacy sync lease to
   drain.
3. Deploy v0.7.0. Its compatibility handlers terminate any
   remaining scheduled legacy jobs without calling Google or scheduling
   another retry.
4. Before normal traffic resumes, sign in as Head Administrator, open
   `/admin/integrations`, and finish **Normalize reservation claims**.
   This rewrites existing active booking claims to the physical venue
   model used by the Calendar integration.
5. Verify `/sheet`, `/bookings`, `/admin/integrations`, and one new
   Jotform submission.
6. Remove the retired variables:

```bash
npx convex env remove GOOGLE_SERVICE_ACCOUNT_JSON_B64
npx convex env remove GOOGLE_SHEETS_SPREADSHEET_ID
npx convex env remove GOOGLE_SHEETS_BOOKINGS_RANGE
npx convex env remove GOOGLE_SHEETS_AUTO_SYNC

npx convex env --prod remove GOOGLE_SERVICE_ACCOUNT_JSON_B64
npx convex env --prod remove GOOGLE_SHEETS_SPREADSHEET_ID
npx convex env --prod remove GOOGLE_SHEETS_BOOKINGS_RANGE
npx convex env --prod remove GOOGLE_SHEETS_AUTO_SYNC
```

7. Remove or revoke the former service account's Google Sheet access and
   retire the key according to your Google Cloud policy.

Legacy schema fields and worker entry points remain for one release so an
in-place deployment accepts old records and already scheduled jobs. They
do not drive the v0.7.0 UI, table, or export path. New installations
should not set any of these legacy variables.

The retired Sheets key is named `GOOGLE_SERVICE_ACCOUNT_JSON_B64`. It is
not the new Calendar key,
`GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64`. Do not remove the Calendar
key during this migration.

## 8. Verify locally

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Manual checks:

1. Sign in as Head Administrator and open `/admin/integrations`.
2. Inspect the form and confirm the core and recurrence qid mapping.
3. With `GOOGLE_CALENDAR_ENABLED=false`, run **Normalize reservation
   claims** and select **Continue** until it reports **Finished**.
4. Set `GOOGLE_CALENDAR_ENABLED=true` and run the Google Calendar
   configuration check.
5. Submit a non-conflicting one-time booking and confirm it is pending.
6. Approve it and confirm the event appears on the correct venue calendar.
7. Create an existing busy Calendar event, submit an overlapping request,
   and confirm RoomOps marks it unavailable.
8. Submit and approve short daily, weekly, every-two-weeks,
   monthly-same-day, and monthly-same-date series. Test both **Yes** with
   a last date and **No** with a deliberately stale hidden date value.
9. Confirm a self-overlapping recurrence and a request exceeding 2,000
   claim slots are rejected before approval.
10. Submit Ministry Centre A & B and Ministry Centre ABC tests; confirm
   events fan out to A+B and A+B+C respectively.
11. Add a non-core Remarks question and submit another test response.
12. Confirm the new response appears as a dynamic column without changing
   `JOTFORM_FIELD_MAP_JSON`.
13. Edit requester metadata or the Remarks value as a Data Editor, save,
    reload, and confirm the Convex value persisted.
14. Submit two pending requests for the same physical venue and interval.
    Confirm both remain pending, both show warnings, and the overview
    reports the overlap. Approving one must automatically make the other
    unavailable.
15. Confirm approved Requester Name edits reconcile the Calendar
    description, Requester Email remains private to RoomOps, and Event
    Name/Purpose/Ministry edits reconcile its title and description.
16. In development, force an approved reconciliation failure, restore
    Calendar access, and use the circular-arrow retry action as Head
    Administrator or Booking Manager.
17. As a Booking Manager, edit the recurrence and last date of a pending
    booking. Confirm claims and the concrete final occurrence are rebuilt.
    Confirm recurrence remains locked after a decision.
18. Confirm room, time, status, and approval are not editable in the data
    table.
19. Download `.xlsx` as each role that can view the table and confirm the
    requested last date and concrete final occurrence columns.
20. Sign in with each administrator role and verify the matrix above.
21. Review the audit log for the intake, Calendar, edit, retry, and export
    events.

## 9. Deploy to Vercel and production Convex

Use separate Clerk and Convex production instances. Create and anchor the
production Head Administrator separately.

Set these Vercel **Production** variables:

```text
CONVEX_DEPLOY_KEY
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/home
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/register
NEXT_PUBLIC_CONVEX_SITE_URL=https://YOUR-PRODUCTION-DEPLOYMENT.convex.site
```

Do not manually set `NEXT_PUBLIC_CONVEX_URL` in Vercel when using the
Convex deploy command.

Recommended Vercel settings:

```text
Install Command: npm ci
Build Command: npx convex deploy --cmd 'npm run build'
```

Set all Convex server variables with `--prod`, initially using
`GOOGLE_CALENDAR_ENABLED=false`. Deploy the production Convex functions
and frontend, then sign in as the production Head Administrator and
finish **Normalize reservation claims** at `/admin/integrations`. Only
then set `GOOGLE_CALENDAR_ENABLED=true`, run the production Calendar
configuration check, and register or re-enable the production
`.convex.site` webhook in Jotform. Calendar secrets stay in Convex and
must not be added to Vercel.

Avoid putting production keys in Vercel Preview scope. A safe preview
environment needs isolated Convex, Clerk, Jotform webhook, and venue
calendar resources.

## 10. Troubleshooting

### `AUTH_IDENTITY_MISSING_EMAIL`

Add the Clerk `email` and boolean `email_verified` session claims, save,
then sign out and in again.

### A Jotform submission does not appear

Check `/logs` for the submission ID. Confirm that:

- the webhook uses the current `.convex.site` hostname and the complete
  `?secret=...` value;
- `JOTFORM_FORM_ID` matches the form;
- `JOTFORM_API_KEY` can read the form and its submissions;
- `JOTFORM_API_BASE_URL` matches the Jotform account's region; and
- all variables were set in the same development or production Convex
  deployment used by the app.

The Head Administrator may retry a failed submission ID from
`/admin/integrations`.

### A mapped field was deleted and recreated

Its question ID may have changed. Inspect the form again at
`/admin/integrations` and replace `JOTFORM_FIELD_MAP_JSON`.

### A new non-core field does not appear in the data table

Publish the Jotform change and submit a new response with a non-empty
answer. The table derives dynamic columns from stored response snapshots;
older bookings are not retroactively fetched. The field's label may
change, but its qid remains the stable column identity.

### A role can view but cannot edit

This is expected for Booking Viewer and Booking Approver. Grant Data
Editor or Booking Manager, or use the Head Administrator. Role changes
take effect through Convex authorization; do not bypass them in the
browser.

### A table save reports a revision conflict

Another administrator changed at least one of the same records after the
page loaded. Reload, review the newer values, and reapply only the edits
that are still required.

### Google Calendar setup or approval fails

Open [GOOGLE_CALENDAR_SETUP.md](GOOGLE_CALENDAR_SETUP.md#12-troubleshooting)
and match the structured error code in `/logs`. In particular:

- `GOOGLE_CALENDAR_NOT_ENABLED` means the integration is still disabled
  in the active Convex deployment.
- `GOOGLE_CALENDAR_VENUE_MAP_INCOMPLETE` means one or more of the ten
  individual venue keys is missing.
- a Google `403` normally means the Calendar API is disabled or the
  service account lacks the required calendar permission.
- `GOOGLE_CALENDAR_WRITE_ACCESS_REQUIRED` means at least one mapped
  calendar was shared below **Make changes to events** permission.
- `GOOGLE_CALENDAR_CONFLICT` means at least one occurrence or physical
  venue became busy.
- `BOOKING_OCCURRENCES_SELF_OVERLAP` means occurrences within the same
  recurrence overlap each other.
- `RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED` means the series
  crosses a daylight-saving or other UTC-offset change and must be split
  into offset-stable series or one-time bookings.
- `BOOKING_CLAIM_SLOT_LIMIT_EXCEEDED` means the request would create more
  than 2,000 UTC-day-by-physical-venue reservation claims.
- `BOOKING_CONFLICT_LOOKUP_RANGE_LIMIT_EXCEEDED` means the unique
  current/legacy claim-room aliases multiplied by all occurrence UTC
  dates would require more than the conservative 3,000 indexed lookups
  reserved for one transaction. Shorten the series or duration, or split
  the request.

Development and production Convex variables are independent. A working
development check does not configure production.

### Calendar synchronization does not finish

Calendar approval and reconciliation use a durable 31-minute lease, one
minute longer than Convex's 30-minute action limit. If a worker never
finishes, the scheduled recovery marks the operation failed, releases its
ownership token, and writes `calendar_sync_lease_expired` to `/logs`.
Scheduler delivery may occur slightly after the 31-minute mark.

If the booking is still pending, fix the cause and select **Approve**
again. If it is approved and has managed Calendar events, use Head
Administrator or Booking Manager to select the circular-arrow **Retry
Google Calendar synchronization** action on `/bookings`. The button
appears only for a failed approved-booking sync; do not manually create a
replacement event.

### Claim normalization reports skipped bookings

Wait for active Calendar synchronization to finish and inspect `/logs`
for invalid legacy booking data. Then select **Rebuild active claims**
again and continue until a full pass finishes without unexpected skips.
The operation is idempotent. Each mutation handles at most two bookings
to leave room for both old-claim deletions and rebuilt-claim inserts; the
page runs multiple mutations automatically.

### The browser still reports a Google Sheets configuration error

The frontend and Convex deployment are on different code versions, or a
stale client is still open. Deploy both v0.7.0 frontend and Convex
functions, then reload. The current `/sheet` route does not require any
Google Sheets variable.

### Existing Convex users fail schema validation

Follow `docs/LEGACY_USER_MIGRATION.md`; this is independent of the
booking-data table migration.
