# RoomOps

RoomOps manages church room bookings submitted through
[Jotform](https://submit.jotform.com/261740998492068). It uses Next.js and React
for the website, Convex for booking data and background jobs, Clerk for
administrator authentication, Google Calendar for venue schedules, and Gmail
for notifications.

## Setup

Use Node.js 22.18 or later (Node.js 24 recommended) and npm.

1. Install dependencies with `npm ci`.
2. Configure Clerk and Convex using [Integration setup](docs/INTEGRATION_SETUP.md).
3. Configure venue calendars and service-account access using
   [Google Calendar setup](docs/GOOGLE_CALENDAR_SETUP.md).
4. Configure Gmail OAuth using [Gmail setup](docs/GMAIL_SETUP.md).
5. Start Convex and Next.js in separate terminals:

```bash
npx convex dev
```

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000). Deploy the Convex schema/functions
and Next.js frontend together, regenerating Convex bindings through the deployment
workflow. Use separate test and production credentials and deployments.

### Frontend environment

Configure `.env.local` for local development and the hosting provider's environment
settings for deployment:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | Convex client endpoint, normally populated by the Convex workflow. |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Optional explicit Convex HTTP actions origin for custom/local endpoints. Standard cloud deployments derive the `.convex.site` origin. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk browser key. |
| `CLERK_SECRET_KEY` | Clerk server key. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | `/home` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | `/register` |

Clerk is required for administrator features. Visitors to the public booking
calendar do not need a Clerk account, an email verification, or administrator approval.

### Convex environment

Set these variables in the intended Convex deployment. Keep server credentials
in Convex; do not prefix them with `NEXT_PUBLIC_`.

| Variable | Purpose |
| --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` | Trusted Clerk issuer. Include `email` and boolean `email_verified` claims in the Convex JWT. |
| `HEAD_ADMIN_CLERK_USER_ID` | Clerk subject of the sole Head Administrator. |
| `DEVELOPER_EMAIL` | Exactly one developer email. The current verified Clerk email must match. |
| `JOTFORM_FORM_ID` | Source booking form. |
| `JOTFORM_API_BASE_URL` | Jotform API endpoint. |
| `JOTFORM_API_KEY` | Server-only API key. |
| `JOTFORM_WEBHOOK_SECRET` | Secret protecting webhook intake. |
| `JOTFORM_FIELD_MAP_JSON` | Core field mappings by Jotform question ID. |
| `BOOKING_TIME_ZONE` | Venue timezone, normally `Asia/Singapore`. |
| `JOTFORM_SUBMISSION_TIME_ZONE` | Optional timezone for unzoned Jotform submission timestamps; defaults to the booking timezone. |
| `BOOKING_RECURRENCE_DEFAULT_COUNT` | Default concrete recurrence count; see the integration guide. |
| `GOOGLE_CALENDAR_ENABLED` | Enables Google Calendar integration. |
| `GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64` | Encoded service-account credentials. |
| `GOOGLE_CALENDAR_VENUE_MAP_JSON` | Venue-to-calendar mapping. |
| `APP_BASE_URL` | Exact frontend origin used in email links and authenticated image requests. |
| `GMAIL_CLIENT_ID` | Google OAuth client ID. |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret. |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token. |
| `GMAIL_FROM_EMAIL` | Sending Gmail address. |

The setup guides explain JSON formats, permissions, webhook registration, and
production configuration. Google Sheets credentials are not required.

### Existing installations

For legacy user records, follow [User migration](docs/LEGACY_USER_MIGRATION.md).
When reservation claims need normalization, open **Integrations → Normalize
reservation claims → Rebuild active claims** and select **Continue** until
finished. Complete normalization before approving new bookings; wait for any
active Calendar synchronization and rerun if records were skipped. The integration
guide also documents retiring a legacy Google Sheets connection.

## Public booking calendar

**Booking calendar** is available from the landing page and administrator home at
`/booking-calendar`, without sign-in. Existing `/my-bookings` links and its old
sign-in/sign-up links redirect there.

The default is **Calendar view**, reading the actual events in the seven bookable
venue Google calendars configured in `GOOGLE_CALENDAR_VENUE_MAP_JSON`. Events
created directly in Google are included; RoomOps-only bookings do not appear
until their events exist in Google. Cancelled events are excluded. Google
recurring events are expanded, including moved instances and cancellations.
A booking copied to three venue calendars appears as three entries, just as in
Google. Retired office calendars and personal calendars are not included.

This is a public read-only view. Google events do not gain a RoomOps approval
status by being displayed: details identify them as Google confirmed/tentative.
Pending RoomOps requests are not read by this page. Titles of public/default
Google events are visible to visitors; events explicitly marked private or
confidential are labelled Busy, with no ministry. Contact details, attendees,
descriptions, meeting links, and raw Google IDs are never returned publicly.

The Calendar/List switch sits below the filters. Slow updates show a loading
overlay without flashing on quick changes. A last-updated time and Refresh button
show the schedule's freshness. The shared cache lasts 60 seconds; open pages poll
every minute. Refresh respects the cache and rate limit. This is not instant push
synchronization. On errors, the last complete snapshot can remain visible with a
warning. RoomOps data is never silently substituted for a failed Google read.

Deploy the `publicCalendarCache` table and backend functions with the frontend.
Use the existing Calendar credentials; enable `GOOGLE_CALENDAR_ENABLED` and share
all mapped venue calendars with the service account. Event-read permission is
needed for this view; the existing booking-write operations still need their
normal write permission. Missing access to any calendar fails the refresh rather
than presenting an incomplete schedule as complete. Failed refreshes write an
audit error and use existing Developer notifications.

Filters apply to both calendar and list views:

- **Ministry:** select one or more ministries. No selection means all ministries.
  Meetings without a ministry are labelled Unspecified.
- **Room:** select one or more rooms. No selection means all rooms. A combined
  venue matches its display name or one of its resolved constituent rooms.

Selections within a category match any selected value. Different categories
must all match: for example, Youth + Shema Space shows approved Youth
meetings in Shema Space. **Show all / reset filters** restores the default selection.
There is no status filter; this view shows Google events, not the approval queue.

The calendar provides Day, Week, and Month views, previous/next navigation for
the selected period, Today, a date picker, and
a daily agenda. Selecting an event in the grid or agenda opens an in-app
details window with its full title, start/end dates and times, timezone, room,
ministry, and status. Close it with the Close button or Escape; keyboard focus
returns to the event. The window follows live changes to the selected meeting.
Calendar entries show both start and end times, including dates for overnight
meetings. Crowded days show a count and the agenda lists every
matching meeting. Multi-day events appear on each occupied date; midnight end
times are exclusive. Times use `BOOKING_TIME_ZONE`, not the browser timezone.
The whole month day box is selectable, including its empty space. On screens
700 px wide or narrower, selecting a month day immediately opens Week view with
that day selected. Desktop month selections stay in Month view. Event buttons
open details independently. On phones the month grid fits the screen, showing
booking counts with a full selected-day agenda below. Week view uses a seven-day
selector and the selected day's hourly timeline on phones; wider screens show
seven timelines side by side. Day view shows a single hourly timeline. Overlapping
meetings use separate columns. Short meetings have a minimum visible height;
their exact start/end times remain in event details. Timelines initially scroll
to 07:00 and can be scrolled to all 24 hours. Switching views preserves the
selected date. Filters apply to all three views. List view groups meetings by date with their title, room, ministry, and start/end
times. It opens at Today, even when there are no bookings today. Scroll up within
the list for history and down for future events; the Today button returns to
today. Changing filters or reopening List returns to today, while live booking
updates preserve browsing position. Overnight meetings continuing into today also
appear in today's section. Tap any event to open its full details. The list fits
phone screens without horizontal scrolling.

The public API exposes event title, ministry where known, mapped room, Google
status, all-day flag, and meeting times, with a hashed key for rendering. Ministry
is optional RoomOps metadata for linked approved bookings; standalone events and
moved scoped events that cannot be matched safely use Unspecified. Google remains
authoritative for title/time/existence. Applying a ministry filter can therefore
hide events without RoomOps metadata. All-day dates use `BOOKING_TIME_ZONE` and
Google's exclusive end-date convention; configure the venue timezone correctly.

Google is queried for the displayed month grid, with neighboring dates for complete
weeks. Calendar navigation loads the corresponding range. List view opens at today
and includes history within the loaded range; previous/next month and the month
picker load other dates without a one-year cutoff. This replaces downloading the
entire booking history, which cannot represent infinite Google recurrence safely.
Each refresh follows all Google pages, with safety limits of 2,500 events per
calendar and a 750 KB sanitized snapshot. Exceeding a limit reports an error instead
of truncating the schedule. A shared lease avoids duplicate refreshes for a range;
a deployment-wide start limit spaces uncached requests by at least three seconds.
Unused snapshots older than a day are removed in bounded batches on later reads.

This read model does not import Google changes into RoomOps booking records,
change requester-email snapshots, repair failed calendar writes, or operate room
hardware. Administrative edits can still overwrite manual Google changes when
reconciliation runs. Use the existing synchronization status and retry controls
for failed writes. Compare the same venue calendars, dates, timezone, and filters
when checking against Google Calendar.

## Administrator access

Administrators sign in with Clerk, register for a role, and receive Head
Administrator approval. The Developer signs in with the verified email configured
in `DEVELOPER_EMAIL` and receives full access automatically. The Head Administrator
cannot assign, remove, or change the Developer through the app. Changing the
environment email revokes the previous developer's elevated access on subsequent
requests. Stored role/email values alone do not establish developer identity.

| Role | View/export table | Approve/reject | Edit table | Edit bookings | Delete bookings | Manage users/integrations |
| --- | --- | --- | --- | --- | --- | --- |
| Developer | Yes | Yes | Yes | Yes | Yes | Yes |
| Head Administrator | Yes | Yes | Yes | Yes | Yes | Yes |
| Booking Viewer | Yes | No | No | No | No | No |
| Booking Approver | Yes | Yes | No | No | No | No |
| Data Editor | Yes | No | Yes | No | Yes | No |
| Booking Manager | Yes | Yes | Yes | Yes | Yes | No |

Administrative queries, mutations, and actions enforce capabilities server-side.
Only the Developer can publish announcements, including feature updates and bug
notices. Other administrators can read and reply to them.

## Booking workflow

Convex retrieves authoritative Jotform submissions after authenticated webhook
intake and processes submission IDs idempotently. It stores canonical bookings,
concrete recurrence occurrences, approval state, reservation claims, and audit logs.

Approved or externally busy overlaps are rejected. Overlapping pending requests
remain reviewable and are marked. Google Calendar availability is checked during
intake and immediately before approval. Approved bookings fan out across the
configured venue calendars, including combined Ministry Centre rooms.

Recurrence supports no repeat, daily, weekly, every two weeks, ordinal-weekday
monthly, and same-date monthly patterns, with optional last dates. Self-overlap,
UTC-offset transitions, and a 2,000 reservation-claim-slot limit are checked.

### Edit and delete recurring bookings

In-app editors and the removal panel offer **This event**, **This and following
events**, and **All events**. Following means the selected occurrence and meetings
whose current start times are at or after it. Scoped edits apply room, time,
title, purpose, and ministry changes while retaining unselected occurrences.
A following edit shifts selected meetings by the same amount and applies the
selected duration. Contact details and recurrence definitions belong to All events.

All-events metadata edits clear occurrence metadata overrides. Metadata-only
saves preserve date/room exceptions; time shifts preserve concrete dates rather
than recreating cancelled meetings. Changing the recurrence definition can
regenerate occurrences. Preview/save enforce overlap limits, and revision guards
reject stale edits.

Partial deletion saves remaining occurrences and queues Calendar reconciliation.
Full deletion verifies removal of managed Google events before removing the
booking, reservation claims, and decision links. Failed cleanup preserves the
booking for retry. If a partial scope covers every remaining occurrence, it uses
full deletion. Reconciliation discovers managed events, cleans obsolete events,
recreates retained occurrences, and verifies them. Google event IDs can change.

Convex and Google Calendar are not one atomic transaction. Pending or failed
synchronization remains visible, with recovery and authorized retry controls.
Do not treat a saved scoped change as proof of Calendar completion. Home Assistant
room-control automation is not implemented by this application.

### Booking data and export

The data table supports batch edits to requester metadata, event title, purpose,
ministry, and non-core Jotform answers. Room/time/status changes use the booking
editor. Dynamic columns are keyed by question ID; update `JOTFORM_FIELD_MAP_JSON`
when mapped core questions are recreated. Response capture is bounded to 80 fields,
4,000 characters per answer, and 50,000 characters per submission; capped captures
are flagged. Workbook export includes up to 10,000 newest bookings and 150 dynamic
fields, with an in-app warning when capped.

## Submitter emails

Gmail sends receipts, decisions, and no-login email approval links. Administrators
can select **Email the submitter** when editing or deleting; it is off by default.
Notices describe scope, changed fields, and previous/updated or removed meetings.
Only changed table rows generate notices. Correcting the requester email sends
the notice to the newly saved address.

Every submitter email ends with that recipient's outstanding pending/approved
meetings from today onward, without a one-year cutoff, plus a public booking
calendar link. The emailed table remains recipient-specific even though the
linked calendar shows everyone's published bookings. Administrator approval/conflict
emails, developer alerts, and Support notifications do not receive this footer.

Edit/delete notices preserve an outstanding-bookings snapshot in the successful
change transaction; batch edits capture the completed batch. Retries use that
snapshot even after subsequent changes. Full deletion queues its notice only
after verified Calendar cleanup. Scoped notices explain that Calendar or room
control changes may still be pending. Receipts, decision emails, and legacy
notices without saved snapshots use the schedule at sending time.

Durable outboxes provide deduplication, leases, abandoned-worker recovery, and up
to five attempts with backoff. **Integrations → Retry failed emails** retries
exhausted notices. Email can be delayed or duplicated if Gmail accepts a message
before a timeout; delivery is not guaranteed exactly once. Convex and email-provider
size limits still apply to large schedules.

## Support and developer notifications

The Support tab lets administrators and the Developer report bugs with a title,
message, severity (low/medium/high/critical), and up to five JPEG, PNG, WebP, or GIF
pictures per message, each up to 5 MB. Conversations support replies and open/solved
filtering. Any active administrator or the Developer can close/reopen a case or
change severity; replying to a solved case reopens it.

Every administrator message queues email to `DEVELOPER_EMAIL`. Developer replies
notify active administrator participants. Only the Developer can publish updates
for features, changes, known bugs, and fixed bugs; announcements notify active
administrators. Replies are made in the app: replies to notification emails are
not imported. Pictures remain in the authenticated app rather than email attachments.

Support conversations and pictures are shared with active administrators and the
Developer. Upload/download handlers enforce origin, permissions, image signatures,
and size limits. Draft attachments are owner-bound and expire after 24 hours;
sent pictures remain in conversation history. Message request IDs prevent duplicate
submissions, and revision checks reject stale status changes. Failed notifications
remain visible with retry controls. Missing developer configuration does not
prevent reports from being saved.

Persisted warning/error audit logs and logs matching suspicious/failure markers
queue immediate developer alerts. Informational logs without these markers are
not emailed. Alerting covers saved application logs, not exceptions that never
persist a log or mutations that roll back. Alerts include a bounded, redacted
summary and a logs link; raw details are excluded. Gmail failures can delay alerts.
The read-only **Developer notifications** integration panel shows the configured
address and delivery status. Recipients are revalidated before sending; in-flight
mail cannot be recalled. Exhausted delivery failures do not recursively generate
alert emails.

## Validation and deployment checks

```bash
npm run test:regression
npm test
npm run typecheck
npm run lint
npm run build
```

Regression tests cover booking scopes, conflicts, Calendar cleanup/recovery,
authorization, public booking projections and combined filters, email snapshots,
notification retries, and Support workflows. Handler tests use database/scheduler
doubles and mocked network calls; they complement live integration checks.

Before production deployment, verify anonymous calendar access, combined filters,
mobile/keyboard layout, repeated recurring edits, Calendar synchronization, Gmail
delivery/retries, administrator roles, developer-only publishing, and Support
attachments and case transitions in staging. Use the setup guides for integration
troubleshooting and refresh old browser tabs after deployment.

## Source layout

- `app/`: routes and pages.
- `components/`: shared UI and booking calendar.
- `convex/`: schema, booking workflow, public projections, authorization, HTTP
  handlers, integrations, background jobs, and logs.
- `shared/roles.ts`: role labels and capability matrix.
- `tests/`: regression coverage.
- `docs/`: integration setup and operational guides.

## Requester changes and cancellations

Approval emails contain **Request Changes** and **Cancel Booking** buttons. Both
open `/booking-request` without an account. Each link uses a private 244-bit random
bearer token in the URL fragment; booking IDs, user IDs and email addresses are not
in the URL. Convex validates the token and current requester on every operation.
Treat the link like a password. Changing the requester email invalidates the old
link, and administrators with booking-edit permission can revoke links through
`bookingRequests.revokeLink`. A completed full cancellation leaves a read-only
receipt at the same link.

The management page shows the approved booking first. Requesters can then edit the
room, date, start/end time, title, purpose and ministry using native controls, review
highlighted differences, and submit a note. Requester identity stays fixed to the
verified email recipient. Additional text, number, email and phone answers are editable and stored per
occurrence. File uploads, signatures, payment fields and recurrence frequency/count
remain administrator-managed. The room choices use the existing bookable venue
rules, including combined Ministry Centre rooms. Desktop and mobile layouts share
the same steps and clear progress/error states.

Choose **This event only** or **This event and following events**. Following edits
keep the frequency unchanged (daily, weekly, fortnightly or monthly). Changing the
start re-anchors the remaining concrete meetings to the new calendar day while
keeping their identities and count; earlier meetings are preserved. Monthly rules
use calendar dates/ordinal weekdays, not a fixed number of milliseconds. Months
without the required day are skipped. Previously deleted meetings are not recreated.
The remaining meetings adopt the selected times and details. Availability is
checked for every affected occurrence. Existing occurrence exceptions are used;
sequence numbers are not assumed to be chronological.

Requests and confirmed cancellations must begin at least two hours before every
affected original meeting. Proposed edit starts must also stay outside that window.
The server checks again before an edit enters approval and when approval begins.
An outdated booking snapshot or an expired cutoff prevents the change. One active
operation is allowed per booking, with idempotent submission handling and version-checked approval.
A pending edit can be updated in place or superseded by a confirmed cancellation.
Each edit submission, including an update to a pending request, uses one of three
lifetime edits per booking. Rejected and completed edits count; cancellation does
not. Historical requests seed the counter when it is first used. Previous pending
versions remain in request history. The server checks both the booking revision and
the exact request revision reviewed by the approver. The first committed conflicting
operation wins; stale actions cannot silently overwrite it. This is transaction
commit ordering, not a guarantee of which network request arrives first.

### Edit approval

Booking approvers, managers, the head admin and the developer use **Edit Requests**
at `/booking-requests`. Compare current and requested details, then approve or
reject, with an optional reason included in the requester email. The searchable
list uses the same cards, status badges and controls as the booking page. Opening a
request captures its reviewed version; close and reopen it after a stale-state message.
Approval automatically applies the change; no manual booking edit is needed.
Older free-text requests remain visible but cannot be automatically approved; ask
the requester to resubmit a structured request using their existing link.

Submission checks the same Convex reservation claims as ordinary bookings and
reads Google Calendar events, excluding only the booking's own verified events.
Unavailable edits are rejected automatically, with a requester email and no approval
work. Valid edits leave the original booking unchanged while awaiting approval.
Approval checks availability again and holds both old and proposed reservation
claims during synchronization, blocking competing RoomOps bookings.

Google replacement events are created and verified before originals are removed.
Another check before removal detects conflicts introduced during creation and
rolls back replacements if needed. Ordinary unaffected occurrences retain their
Google event IDs. Legacy recurring parents are rebuilt as the retained concrete
schedule so obsolete recurrence rules cannot recreate cancelled meetings.

Calendar work uses durable phases, deterministic event IDs and 31-minute worker
leases. Failed attempts retry with backoff; after repeated failure, use **Needs
attention → Retry synchronization** in Edit Requests. Original database details and
reservation protection remain until Calendar success. After partial external writes,
Calendar may temporarily show an incomplete transition: a failure is never reported
as a completed approval or cancellation. Suspicious/failure logs use the existing
`DEVELOPER_EMAIL` notification system.

Google Calendar does not offer a transaction spanning its API and Convex. Direct
external Calendar edits can still race the final check; make booking changes through
RoomOps where possible. Direct Google edits are not imported into the admin booking
record by this feature. Building controls are not directly operated by this code;
their existing integration consumes the resulting Calendar schedule.

### Cancellation and notifications

Cancellation has its own confirmation step and does not require administrator
approval. Confirmation immediately starts verified Calendar cleanup. When cleanup
succeeds, RoomOps releases the selected reservations, updates or removes the active
booking using its existing lifecycle, and cancels obsolete queued booking emails.
Request history retains the original details, scope, requester, reason and outcome,
even after full cancellation. A failed cleanup keeps reservations protected and shows
that cancellation has not completed.

Valid edit submissions send a receipt to the requester and a comparison/review link
to active entries in **Approver Emails**. Rejection, automatic unavailability and
successful approval each send the appropriate requester message. Successful
cancellation sends a requester receipt and an informational approver notification.
Approver review requires signing in with booking-approval permission; notification
recipient settings do not grant that permission. Email delivery uses the existing
Gmail outbox, leases and retry controls. Submitter emails include a snapshot of their
outstanding bookings captured in the lifecycle transaction; approver messages do not.

### Deployment

Deploy Convex schema/functions and the frontend together, then refresh old tabs.
Set `BOOKING_MINISTRIES_JSON` in the **Convex deployment environment variables**
to this JSON array of ministries:

```json
["Children's Ministry","Church Archivist","Church Governance","Church Office","Communications","Discipleship & Nurture","Finance","Hospitality","LCEC","Mandarin Ministry","Missions","Others (Please Specify)","Outreach & Social Concerns","Pastor's Office","PPRSC","Prayer","Property Management","Seniors Ministry","Springs-WSCS","Witness & Evangelism + ACSI Ministry","Worship & Music","Young Adults Ministry","Youth Ministry"]
```

Selecting **Others (Please Specify)** reveals a required ministry name field
(1–120 characters). The server validates it and stores `Others (Please Specify): <name>` in the affected meetings. Reviews, emails and Calendar descriptions include
the specified name, and reopening the editor restores both fields.

This is the authoritative dropdown and server
allowlist; it is not inferred from historical free-text submissions. Configure it
separately in dev and production. Missing or invalid configuration disables edit
submission with a helpful message; cancellations remain available. Legacy bookings
with unlisted ministries must select a valid ministry before submitting changes.

Phone fields accept Singapore eight-digit numbers beginning with 3, 6, 8 or 9 and
store them as `(65) 9087 3541`. Legacy `full:` values are normalized when edited.
Start and end times define duration; no separate Duration input is shown.
Administrator edits, bulk table edits and cancellations have optional comments,
stored in the audit log and included when an email notification is selected.

Configure the existing Calendar service
account, venue map and `GOOGLE_CALENDAR_ENABLED=true`, Gmail credentials, active
Approver Emails, and Convex `APP_BASE_URL` for the intended frontend deployment.
The Calendar identity needs full event read/write access to each mapped calendar;
free/busy-only access cannot distinguish the booking being edited from conflicts.
Keep the public `/booking-request` route outside the Clerk-authenticated layout.

Schema additions are optional for existing rows: request proposal/version, original
and candidate snapshots, idempotency key, processing phase, lease and event targets;
a booking operation lock; link revocation; and request-specific fields in the existing
booking-notice outbox. Existing records need no backfill. Request revisions and the lifetime edit counter
are initialized lazily; do not reset these fields to grant additional attempts. Histories retain the previous
`pending`, `completed` and `declined` states and add `checking`, `applying` and `failed`.
Do not remove the requester operation fields while a synchronization is in flight.

Regression coverage includes single/recurring changes, room and time validation,
cutoffs, invalid/revoked tokens, duplicate requests, authorization, conflicts at
submission and approval, automatic cancellation, Calendar rollback/recovery, and
requester-only email snapshots. Run the validation commands above, then exercise
approval, rejection and cancellation against the intended test Calendar and mailbox
before using a deployment for live bookings.
