# RoomOps

RoomOps is a Next.js 16 administrator workspace for room requests from
[Jotform 261740998492068](https://form.jotform.com/261740998492068).
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
- Approved-event creation and reconciliation across the ten venue
  calendars
- Durable Calendar synchronization recovery and an administrator retry
  control for failed approved-booking updates
- Daily, weekly, ordinal-weekday monthly, and same-date monthly recurrence
- Recurrence self-overlap rejection and a 2,000 reservation-claim-slot
  safety cap
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
- The data table may edit requester name, requester email, event name,
  purpose, ministry, and non-core responses. For approved bookings,
  requester-name edits reconcile the Calendar description, while event
  name, purpose, and ministry edits reconcile the title and description.
  Requester email remains private to RoomOps and its notification flow.
  Room, time, status, and approval changes stay on `/bookings`, where
  their dedicated rules are enforced.
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

| Role | View data table | Download XLSX | Approve/reject | Edit table data | Edit canonical booking | Manage users/integrations |
|---|---:|---:|---:|---:|---:|---:|
| Head Administrator | Yes | Yes | Yes | Yes | Yes | Yes |
| Booking Viewer | Yes | Yes | No | No | No | No |
| Booking Approver | Yes | Yes | Yes | No | No | No |
| Data Editor | Yes | Yes | No | Yes | No | No |
| Booking Manager | Yes | Yes | Yes | Yes | Yes | No |

Every Convex query and mutation enforces its capability server-side.
`table.edit` permits requester metadata, event name, purpose, ministry,
and non-core response edits. It does not permit room, time, status, or
approval changes.
When an approved-booking Calendar reconciliation fails, only Head
Administrator and Booking Manager have the `bookings.edit` capability
used by the retry action.
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
precedence, recurrence self-overlap and claim-slot limits, venue fan-out,
Calendar configuration, synchronization recovery, and event rendering.

## Source layout

- `app/` — Next.js routes and pages
- `components/` — application shell and shared UI
- `convex/` — schema, authorization, webhook, booking workflow, logs,
  data-table operations, Google Calendar integration, and transition
  handlers
- `shared/roles.ts` — role labels and capability matrix
- `docs/` — setup, migration, and deployment instructions
