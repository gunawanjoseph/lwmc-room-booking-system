# RoomOps

RoomOps is a Next.js 16 administrator workspace for room requests from
[Jotform 261740998492068](https://submit.jotform.com/261740998492068).
Clerk authenticates administrators, while Convex is the canonical store
for booking data, authorization, and audit logs.

## Included in this phase

- Landing, sign-in/sign-up, and Convex-linked administrator registration
- Sole Head Administrator with user approval, role changes, and removal
- Role-gated booking view, approve/reject, edit, data-table, workbook
  export, logs, and integration screens
- Secure Jotform webhook intake with authoritative API retrieval
- Idempotent submission processing
- Atomic overlap protection: approved or externally busy slots are
  auto-rejected, while overlapping pending requests remain reviewable and
  are marked on both rows
- Google Calendar free/busy checks during intake and immediately before
  approval
- Approved-event creation across seven bookable venue calendars, with
  historical reconciliation and safe deletion retained for three retired
  office-venue calendars
- Durable Calendar synchronization recovery and an administrator retry
  control for failed approved-booking updates
- No-repeat, daily, weekly, every-two-weeks, ordinal-weekday monthly,
  and same-date monthly recurrence
- Optional recurring-booking last dates, stored in the booking timezone
  and shown together with the concrete final occurrence
- Recurrence self-overlap and UTC-offset-transition rejection, plus a
  2,000 reservation-claim-slot safety cap
- Ministry Centre A & B and Ministry Centre ABC multi-calendar fan-out
- Gmail requester notifications and no-login email approval links
- Per-recipient, deduplicated email delivery with bounded automatic retry
- Head Administrator Gmail connection test and approver-recipient management
- Convex-backed booking-data table with controlled batch editing
- Automatic qid-keyed columns for non-core Jotform answers
- `.xlsx` download for every administrator who may view the data table
- System audit logs and failed-submission retry
- One-release compatibility handlers for the retired v0.2 Google Sheets
  API mirror

Home Assistant automation remains a later phase.

## Data boundaries

- Convex owns bookings, form-response snapshots, approval state, overlap
  checks, recurrence occurrences, Calendar sync state, table edits, and
  audit logs.
- Jotform sends a submission ID to a secure Convex HTTP action. Convex
  then retrieves the authoritative submission with a server-only API key.
- Mapped core fields provide requester, room, and timing data used by the
  booking workflow.
- Non-core answers are stored as bounded text keyed by stable Jotform
  `qid`. A new field such as Remarks appears as a dynamic table column
  without coupling RoomOps to a label or spreadsheet header.
- Response capture is bounded to 80 fields, 4,000 characters per answer,
  and 50,000 answer characters per submission. A capped capture is marked
  on the table and written to the system log; core booking fields remain
  stored separately.
- Deleting and recreating a mapped core question can change its `qid`;
  update `JOTFORM_FIELD_MAP_JSON` when that happens.
- Recurrence end-date or legacy-count mappings require the repeat-option
  question to be mapped too; the integrations page validates this before
  copying the JSON.
- The data table may edit requester name, requester email, event name,
  purpose, ministry, and non-core responses. For approved bookings,
  requester-name edits reconcile the Calendar description, while event
  name, purpose, and ministry edits reconcile the title and description.
  Requester email remains private to RoomOps and its notification flow.
  Room, time, recurrence, status, and approval changes stay on
  `/bookings`, where their dedicated rules are enforced. Pending and approved
  bookings may change their reservation or recurrence schedule; recurring
  bookings support this event, this and following events, and all events.
- Google Calendar owns external venue-busy events. RoomOps checks those
  calendars but stores the accepted request and concrete recurrence
  occurrences in Convex.

## Start here

Follow [docs/INTEGRATION_SETUP.md](docs/INTEGRATION_SETUP.md).
For the complete Google Cloud, venue-sharing, Calendar-ID, recurrence,
and test procedure, also follow
[docs/GOOGLE_CALENDAR_SETUP.md](docs/GOOGLE_CALENDAR_SETUP.md).
For Gmail OAuth, requester notifications, email approval links, and
delivery troubleshooting, follow
[docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md).

If this replaces the earlier authentication starter and Convex reports
legacy `identitySubject`/`name` user records, first follow
[docs/LEGACY_USER_MIGRATION.md](docs/LEGACY_USER_MIGRATION.md).

Then run:

```bash
npm install
npx convex dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

After deploying this Calendar release to each existing Convex
environment, the Head Administrator must open `/admin/integrations` and
run **Normalize reservation claims → Rebuild active claims**. Select
**Continue** until the page reports **Finished**. Complete this one-time
step before accepting or approving new requests; if any booking is
skipped because Calendar synchronization is active, wait for it to finish
and run the normalization again.

## Authorization matrix

| Role | View data table | Download XLSX | Approve/reject | Edit table data | Edit canonical booking | Delete booking | Manage users/integrations |
|---|---:|---:|---:|---:|---:|---:|---:|
| Head Administrator | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Booking Viewer | Yes | Yes | No | No | No | No | No |
| Booking Approver | Yes | Yes | Yes | No | No | No | No |
| Data Editor | Yes | Yes | No | Yes | No | Yes | No |
| Booking Manager | Yes | Yes | Yes | Yes | Yes | Yes | No |

Every Convex query and mutation enforces its capability server-side.
`table.edit` permits requester metadata, event name, purpose, ministry,
and non-core response edits. It does not permit room, time, status, or
approval changes.
When an approved-booking Calendar reconciliation fails, only Head
Administrator and Booking Manager have the `bookings.edit` capability
used by the retry action.
Head Administrator, Data Editor, and Booking Manager have `table.edit`
and may permanently delete a booking. Deletion runs through a leased
Convex action: RoomOps verifies ownership and ETags while removing every
managed or partially-created Google Calendar event, then atomically
removes the Convex row, reservation claims, and decision links while
cancelling outstanding email deliveries. A Calendar cleanup failure
keeps the booking intact so the administrator can retry safely.
An intake row stranded during its availability check may also be
deleted; the deletion invalidates its processing receipt, and a late
worker is prevented from finalizing the removed booking.
Workbook exports are capped at 10,000 newest bookings and 150 dynamic
fields, prioritizing the most recently seen fields and warning in-app if
a cap is reached.

## Required Convex variables

RoomOps does not require Google Sheets credentials, a spreadsheet ID, a
worksheet GID, or a fixed header contract. Configure the Clerk, Jotform,
and Google Calendar variables described in
[docs/INTEGRATION_SETUP.md](docs/INTEGRATION_SETUP.md), including:

```text
CLERK_JWT_ISSUER_DOMAIN
HEAD_ADMIN_CLERK_USER_ID
JOTFORM_FORM_ID
JOTFORM_API_BASE_URL
JOTFORM_API_KEY
JOTFORM_WEBHOOK_SECRET
JOTFORM_FIELD_MAP_JSON
BOOKING_TIME_ZONE
GOOGLE_CALENDAR_ENABLED
GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64
GOOGLE_CALENDAR_VENUE_MAP_JSON
BOOKING_RECURRENCE_DEFAULT_COUNT
APP_BASE_URL
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN
GMAIL_FROM_EMAIL
```

An installation upgrading from the old API-based Google Sheets mirror
must complete the short cutover procedure in the setup guide before
removing its legacy Google variables and service-account access.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Tests cover the capability matrix, overlap rules, UTC-day claims, Jotform
date/time and recurrence mapping, qid-keyed response capture, exact-qid
precedence, recurrence offset-transition, self-overlap, and claim-slot
limits, venue fan-out,
Calendar configuration, synchronization recovery, and event rendering.

## Source layout

- `app/` — Next.js routes and pages
- `components/` — application shell and shared UI
- `convex/` — schema, authorization, webhook, booking workflow, logs,
  data-table operations, Google Calendar integration, and transition
  handlers
- `shared/roles.ts` — role labels and capability matrix
- `docs/` — setup, migration, and deployment instructions

For the September Calendar safety fixes, incident recovery, test coverage and
release checks, see [the review](docs/ROOMOPS_CALENDAR_FIX_REVIEW.md).


## Recurring meeting controls and developer alerts

This feature patch builds on the previous Calendar safety patch. It updates
this README only; the earlier review document describes the earlier release.
Where their behavior differs, this section is authoritative.

### Remove meetings

The Bookings and Booking data pages now open an in-app side panel instead of
`window.confirm`. It includes a date picker, scope cards, the affected meeting
count, a keep/remove choice, inline errors, keyboard focus containment, Escape
handling and focus restoration.

For a recurring booking, select the meeting and choose:

- **This event:** remove only the selected meeting.
- **This and following events:** remove the selected meeting and meetings whose
  current start dates are later than or equal to its start date.
- **All events:** remove the full booking, including past meetings.

Partial removal updates the concrete occurrence list and reservation claims in
one Convex mutation. It preserves the other meetings and queues approved
Calendar reconciliation immediately. The UI explicitly reports synchronization
as pending; it must reach `synced` before Calendar removal is treated as complete.
If the operation fails, the row remains with `failed` Calendar status and a
retry path. If the selected scope contains every remaining meeting, the panel
uses the existing verified whole-booking deletion action instead.

Deletion requires the existing `table.edit` capability. A stale booking revision
or active Calendar/deletion lease prevents conflicting changes. A pending
booking with leftover events from a failed approval must have that failed
approval resolved before partial removal. Full deletion remains available.

### Edit meetings

The recurring-booking editor provides **This event**, **This and following
events**, and **All events**, plus a selected-meeting dropdown for scoped edits.
Room, start/end time, event name, purpose and ministry follow the selected
scope. Requester contact details belong to the entire booking and are editable
only under All events. Recurrence pattern/end-date controls also belong to
All events.

This and following shifts the selected and later meetings by the same amount
as the selected start-time change, applies the selected duration and room, and
keeps the existing date pattern. Earlier meetings keep their dates and details.
Scoped titles/purpose/ministry are stored as occurrence overrides and used in
Google event creation. All-events metadata edits apply the displayed metadata
to every meeting, clearing those overrides; date/room exceptions survive a
metadata-only save. A series time shift retains the concrete dates, so it does
not recreate cancelled meetings. Explicitly changing the repeat definition can
regenerate the occurrence list and should be reviewed before saving.

Both preview and save run the existing overlap and booking-size checks.
Occurrence sequence IDs remain stable during scoped changes, while the booking
revision rejects stale editors. The earliest remaining date is reflected in the
summary after partial deletion or editing.

### Calendar reconciliation

Reconciliation now rebuilds the complete retained concrete schedule, including
past meetings, rather than retaining all historical Google references blindly.
This is necessary when a user explicitly edits/deletes a past meeting or when
replacing a legacy recurring Google parent. It also avoids leaving removed
occurrences inside a parent recurrence rule. Unselected meetings retain their
content, but their Google event IDs/links can change during rebuilding.

RoomOps discovers owned events, persists cleanup/create candidates, removes
obsolete events, checks active/future availability, creates the retained
occurrences, then verifies the created events. Failures remain visible and
retryable. This is not an atomic transaction across Google and Convex: partial
Calendar failures can temporarily leave a partially rebuilt schedule. Check
room controls separately for meetings already running. Historical events are
rebuilt without applying present-day free/busy checks to their past intervals.

### Developer emails

The single Developer email is configured by `DEVELOPER_EMAIL` in Convex.
**Integrations → Developer notifications** shows the address and latest 30 alert
deliveries. It is read-only: the Head Administrator cannot add recipients,
disable the developer, or change this address through RoomOps.

Every existing application audit-log insertion is routed through a shared
transactional writer. A new persisted log queues one email to the
configured Developer when:

- its level is `warning` or `error`; or
- its action/message contains a failure, suspicious activity, unauthorized,
  forbidden, denied, timeout, expired or collision marker.

Normal informational logs are not emailed. This includes every warning, even
an intentional administrative deletion; the rule is deliberately inclusive.
It operates on saved application audit logs, not an external monitoring feed:
old logs are not replayed and a runtime exception that never writes an audit
record cannot be emailed by this mechanism. Mutations that roll back do not
persist their logs or email jobs.

Alerts are queued with zero scheduler delay as part of the log transaction.
They use the existing Gmail OAuth configuration and contain the severity,
category, action, timestamp, log ID, a bounded summary and a link to `/logs`.
Raw `detailsJson` is excluded; obvious secret assignments and URLs in the
message are redacted. Recipients can receive operational information, so configure
only the intended developer address. Full details require normal app access.

An outbox tracks pending/sending/sent/failed/cancelled delivery status. Workers
claim a lease, retry failures up to five total attempts with exponential backoff,
and recover abandoned workers. The Head Administrator or Developer can retry failed alerts.
The configured address is checked again before sending; an already in-flight
email may still arrive. Exhausted alert failures stay visible locally and never
queue more alert emails, preventing an email failure loop. A timeout after Gmail
accepts a message can cause a duplicate on retry; the stable Message-ID does not
provide an exactly-once guarantee. If Gmail itself is unavailable, alert email
will also be delayed or fail. No live email was sent during patch preparation.

### Deployment and verification

Apply `lwmc-recurring-controls-support-alerts.patch` **after** the previous
`lwmc-roomops-calendar-safety.patch`:

```bash
git apply --check "$HOME/Downloads/lwmc-recurring-controls-support-alerts.patch"
git apply "$HOME/Downloads/lwmc-recurring-controls-support-alerts.patch"
```

The new schema adds `techSupportEmails`, `techAlertDeliveries` and optional
per-occurrence details. Existing bookings need no data migration. Deploy the
Convex schema/functions and the Next.js frontend together, regenerate Convex
bindings through the normal deployment workflow, and refresh old browser tabs.
Use the existing Gmail environment settings; no new secrets are required.

Run on Node 22.18+ / Node 24:

```bash
node --test tests/calendar-safety.regression.mjs tests/recurrence-support.regression.mjs
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

The dependency-free handler/API regression suites pass 40 tests. They cover
scope selection, partial deletion/claims, stale revisions, scoped metadata,
Calendar rebuilding and verification, support routing, email normalization,
leases, retries, deactivation, Gmail message composition and redaction. Convex
registration/authentication and network calls are mocked; they do not certify
real database transactions, browser rendering or live delivery. npm installation
was blocked by registry HTTP 403 in the preparation environment, so the full
Vitest suite, typecheck, lint and Next.js build still need to run before release.

On a test deployment, exercise each scope from both deletion entry points,
verify the actual Google calendars and remaining dates, test an overlapping
edit and a partial sync failure/retry, then set a test DEVELOPER_EMAIL and
produce a warning/error log. Confirm the recipient is read-only in the app,
and test address rotation and failed-delivery retry. Verify the drawer
on mobile and with keyboard navigation. No deployment was performed here.

## Support conversations and developer updates

Apply `lwmc-support-conversations.patch` **after**
`lwmc-recurring-controls-support-alerts.patch` (and its Calendar-safety prerequisite):

```bash
git apply --check "$HOME/Downloads/lwmc-support-conversations.patch"
git apply "$HOME/Downloads/lwmc-support-conversations.patch"
```

The new **Support** tab provides:

- Bug reports with a title, message, low/medium/high/critical severity, and up to
  five PNG, JPEG, WebP or GIF pictures per message (5 MB each).
- Live conversation threads, follow-up replies, open/solved filtering, and
  pagination for reports and messages. Replying to a solved conversation reopens
  it. Any active administrator or the Developer can change severity
  and close/reopen a case; changes appear in the conversation. Revision checks prevent stale
  status updates from overwriting another person's changes.
- Developer announcements for new features, changes, known bugs and fixed bugs,
  with replies in the same interface.
- Per-message email-delivery counts and developer retry controls for failures.
  Message request IDs suppress duplicate submissions when a response is retried.

### Developer access and email routing

**Developer** is the single term for the account previously called Technical
Support. Set one address in the Convex environment variable `DEVELOPER_EMAIL`.
Matching is case-insensitive and trimmed; missing, invalid, or multiple addresses
fail closed. Do not add a `NEXT_PUBLIC_` prefix or store it in frontend settings.

After normal Clerk sign-up/sign-in, the app automatically provisions or upgrades
the account when the **current verified Clerk email claim** matches
`DEVELOPER_EMAIL`. No Head Administrator approval is required. Developer access
includes every app capability: bookings, Calendar, data editing/export, logs,
users, integrations, support conversations, triage and announcements. Developer
and Head Administrator identities themselves remain environment-controlled and
cannot be changed through the user-management API.

The Head Administrator cannot approve, reject, demote, remove or assign a
Developer. The role is absent from registration and management dropdowns;
protected accounts display an environment-managed badge. The old `tech_support`
role remains schema-compatible but grants no permissions. Existing accounts using
it are upgraded only when signed in with the configured verified email. Stored
email/role values alone cannot establish developer access; queries, mutations,
HTTP image requests and actions check the current authenticated identity.
Changing/removing `DEVELOPER_EMAIL` revokes the old developer's elevated access
on subsequent requests. A developer row belonging to the old address is inactive;
a matching new account is activated on its next login. Ordinary administrator
permissions and Head Administrator approval of ordinary users are preserved.

Support conversations and pictures are shared with all active administrators and
the Developer. **Any active administrator or the Developer can close and reopen
any report**, including reports created by someone else. Status changes are
recorded in the conversation; stale revisions are still rejected.

Every administrator message, including the Head Administrator's, queues email to
`DEVELOPER_EMAIL`. Automatic warning/error/suspicious-log alerts use that same
address. Developer replies email the active administrator participants; new
announcements notify active booking administrators except the author. Existing
`techSupportEmails` rows are ignored, and the old recipient-edit endpoint rejects
changes from stale clients. Missing/invalid configuration leaves reports saved,
shows a warning, and sends no developer notification. Queued messages to a
previous developer address are cancelled when their worker starts; already
in-flight email cannot be recalled. Notifications are not retrospectively sent
to a newly configured address.

Emails include the message and an authenticated conversation link. **Replies are
made inside the Support tab; replies sent directly to the Gmail notification
address are not imported.** Pictures are viewed in the application, not attached
to email. Automatic audit-log alerts retain their existing retry and redaction behavior.

Message creation and its email outbox are saved in one Convex mutation. Sending
is scheduled immediately, with five attempts, exponential retry delays, worker
leases and abandoned-worker recovery. Recipients are rechecked before sending;
in-flight email cannot be recalled. Delivery is at least once: a timeout after
Gmail accepts a message can cause a duplicate. Failed emails remain visible in
the conversation and do not recursively create alert emails.

### Attachments and deployment

Pictures use authenticated `/support/image` HTTP upload/download handlers;
public storage URLs are never returned. The handlers enforce the configured
application origin, support permissions, body-size limits and supported image
signatures. Draft pictures are owner-bound, and sent pictures cannot be removed
through the draft-deletion endpoint. Unsent drafts expire after 24 hours and are
cleaned up automatically. Sent pictures remain as conversation history. Do not
include passwords or credentials in reports: text is included in notification
emails to configured recipients.

Deploy the Convex schema/functions and Next.js frontend together and regenerate
Convex bindings. The schema adds `supportThreads`, `supportMessages`,
`supportParticipants`, `supportAttachments` and `supportDeliveries`; existing
bookings require no migration. Keep the existing Gmail and Clerk/Convex JWT
settings. Set Convex `APP_BASE_URL` to the frontend URL with its exact origin.
For standard deployments, the frontend derives the HTTP endpoint by changing
`NEXT_PUBLIC_CONVEX_URL` from `*.convex.cloud` to `*.convex.site`. For a custom or
local endpoint, set `NEXT_PUBLIC_CONVEX_SITE_URL` explicitly to its HTTP actions
origin. Cross-origin previews must use a matching test backend/app-origin setting.

### Regression verification

```bash
# Dependency-free handler and HTTP tests; Node 22.18+ / Node 24 required:
npm run test:regression

# Complete release checks when dependencies are available:
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

The regression command passes **101 tests**: 79 booking, Calendar, alert and
support checks (updated for the intended developer-policy changes), plus 22
developer-identity and authorization checks. New coverage includes
report/reply routing, announcements, duplicate requests, optimistic concurrency,
open/solved transitions, role isolation, real authorization guards, attachment
ownership/quotas/expiry, authenticated HTTP routes, streamed upload limits, email
composition, recipient revocation, lease recovery and retry exhaustion. The
Vitest role matrix also covers the new role. Changed TypeScript/TSX files passed
syntax parsing.

These are handler tests with in-memory database/scheduler doubles and mocked
network calls, not a proof of live Convex transaction behavior or browser
rendering. `npm ci` was blocked by registry HTTP 403 in the preparation environment;
the full Vitest suite, typecheck, lint, build and browser checks could not run.
Before production release, run those commands and use a staging deployment to
exercise report → developer email → developer reply → admin email → solve →
reopen; publish each announcement category; upload/view/remove pictures; test
mobile and keyboard interaction; and change/remove DEVELOPER_EMAIL to verify
old developer access is removed. No production deployment or real email delivery was performed here.


### Apply the developer identity patch

Apply `lwmc-developer-identity.patch` after `lwmc-support-conversations.patch`:

```bash
git apply --check "$HOME/Downloads/lwmc-developer-identity.patch"
git apply "$HOME/Downloads/lwmc-developer-identity.patch"
```

Before deploying the updated schema/functions and frontend, set `DEVELOPER_EMAIL`
in each intended Convex deployment using its Environment Variables settings.
Use exactly one email, for example `developer@example.com`, then sign in through
Clerk using that address and verify it. The existing JWT configuration must expose
`email` and boolean `email_verified` claims. If account initialization fails, the
login gate shows an error and Retry button. A normal administrator sign-in does
not self-approve or gain developer permissions.

No destructive data migration is required. Existing developer accounts and
notification history remain readable; `tech_support`, `techSupport` API paths,
`techSupportEmails`, `techAlertDeliveries` and the persisted `technical` delivery
kind are retained only for compatibility with existing data/scheduled jobs.
Their UI labels use Developer. Developer alert deliveries no longer require a
legacy recipient row. Deploy backend and frontend together and refresh old tabs.

New regression coverage includes automatic activation and idempotency, unverified
identity rejection, all-capability/action access, operation without a configured
head account, legacy-role denial, address revocation, protected-account mutation
rejection, developer administrator-management access, impersonation rejection,
read-only recipient configuration, and shared close/reopen controls. No live
account, environment variable or production deployment was changed here.


### Support layout and developer-only publishing

Apply `lwmc-support-layout-publishing.patch` after `lwmc-developer-identity.patch`:

```bash
git apply --check "$HOME/Downloads/lwmc-support-layout-publishing.patch"
git apply "$HOME/Downloads/lwmc-support-layout-publishing.patch"
```

The Support page now uses the app's normal page margins, padded panels, a compact
conversation list and a wider reading/composer area. New reports and updates open
in that detail area instead of pushing the conversation list down the page.
Buttons size to their content; attachments and long text stay within their column.
Below 900 px, selecting a conversation or opening a draft shows the detail view
with a Back to conversations button. The list remains available without squeezing
the conversation beside it. Existing drafts must be closed before opening another.

Only the configured Developer can publish feature/change/bug announcements.
The separate `support.publish` capability is excluded from Head Administrator and
all other administrator roles, and the create mutation also verifies the actor's
Developer role. Hiding the publish button is not the authorization boundary.
Administrators can still read updates, reply, report bugs, close/reopen reports,
and use their existing notification-retry permissions. Deploy backend and frontend
together so this restriction applies to both new and already-open clients.

All 101 handler regression tests pass, including publishing rejection for every
non-developer role and all four announcement categories, successful Developer
publishing, and preserved Head Administrator reporting/triage. TypeScript/TSX
syntax parsing and patch application were checked. Full build/typecheck remain
blocked by the previously documented npm registry 403. The local browser runtime
was unavailable and its download also returned HTTP 403, so visual/browser
verification still needs to run on a test deployment at mobile, tablet and desktop
widths before release. No live deployment was changed.
