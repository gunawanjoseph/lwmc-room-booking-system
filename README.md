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

The default is **Calendar view** with **All bookings (god mode)**: everyone's
approved and pending meetings, across all ministries and rooms. This is a public
read-only view; it grants no administrator permissions. Rejected, unavailable,
and processing bookings are excluded by the server.

Filters apply to both calendar and table views:

- **Booking status:** Approved and Pending are selected initially. Select either
  or both; clearing both shows no meetings.
- **Ministry:** select one or more ministries. No selection means all ministries.
  Meetings without a ministry are labelled Unspecified.
- **Room:** select one or more rooms. No selection means all rooms. A combined
  venue matches its display name or one of its resolved constituent rooms.

Selections within a category match any selected value. Different categories
must all match: for example, Pending + Youth + Shema Space shows pending Youth
meetings in Shema Space. **Show all / reset filters** restores the default selection.
Pending requests are not confirmed reservations.

The month calendar provides previous/next navigation, Today, a month picker, and
an expandable daily agenda. Crowded days show a count and the agenda lists every
matching meeting. Multi-day events appear on each occupied date; midnight end
times are exclusive. Times use `BOOKING_TIME_ZONE`, not the browser timezone.
On narrow screens the month grid scrolls horizontally. Table view lists meetings
in booking-date order and progressively reveals additional rows.

The public API exposes event title, ministry, room, status, and meeting times,
with an opaque key for rendering. It does not expose requester names/emails,
submission references, form answers, purpose, internal notes, or integration errors.
Anyone with the page URL can read the published booking details.

Both views subscribe to the current saved occurrences. Repeated edits to a single
meeting, following meetings, or the full series update the displayed times, rooms,
titles, and ministries. Removed occurrences disappear. There is no one-year date
cutoff; the page shows concrete occurrences saved in RoomOps, including past dates.
It does not invent additional future recurrences. Public booking queries paginate
by approved/pending status; the view loads all pages before applying its filters.

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
