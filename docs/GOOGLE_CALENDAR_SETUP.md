# Google Calendar setup for RoomOps

This guide configures the RoomOps v0.7.0 Google Calendar integration.
RoomOps checks every requested occurrence against Google Calendar during
Jotform processing, checks again immediately before approval, and creates
the approved event on the calendar for each physical venue.

The integration uses a Google Cloud service account. It does not require
an API key, an OAuth consent screen, a Google Sheet, or Google credentials
in the Next.js/Vercel environment.

### Required rollout order

Use this order independently for development and production:

1. Complete the Google Cloud, calendar-sharing, and Calendar-ID work in
   sections 2–4.
2. Set `GOOGLE_CALENDAR_ENABLED=false`, then set the service-account,
   venue-map, recurrence-default, and Jotform mapping variables.
3. Deploy the new Convex functions and frontend while Calendar automation
   is still disabled.
4. Sign in as the Head Administrator and run **Normalize reservation
   claims** to completion as described in section 10.
5. Set `GOOGLE_CALENDAR_ENABLED=true`.
6. Immediately run the Google Calendar configuration check. If it fails,
   set `GOOGLE_CALENDAR_ENABLED=false` again before correcting the setup.
7. Complete the end-to-end tests before accepting or approving normal
   requests.

Do not skip or reorder the claim-normalization step on an existing
deployment. Development and production each have their own data and
Convex environment variables, so repeat the rollout in both.

## 1. Understand the booking flow

When `GOOGLE_CALENDAR_ENABLED=true`, RoomOps:

1. receives a Jotform submission ID;
2. retrieves and maps the authoritative submission;
3. expands one-time or recurring requests into concrete occurrences;
4. resolves the requested venue into one or more physical venues;
5. checks both Convex reservations and the relevant Google calendars;
6. automatically marks externally busy or already-approved slots
   `unavailable`, while keeping pending-versus-pending overlaps in review
   with a warning on both requests;
7. checks Google Calendar again when an approver selects **Approve**; and
8. creates one Google recurring-event parent on each required calendar.

An approved event title has this format:

```text
[Venue] Event Name or Purpose of Booking Ministry
```

RoomOps uses Event Name first, then Purpose as a fallback, then
`Room Booking` if both are empty. Ministry is appended when present. For
example:

```text
[Board Room] Leaders Meeting Youth Ministry
```

The Calendar description intentionally uses this exact, compact format.
RoomOps sends safely escaped HTML so Google Calendar renders the four
labels in bold, matching the event-details layout:

```text
Ministry:
{ministry}

Event Name or Purpose of Booking:
{event name, or purpose as fallback}

Name:
{requester name}

Venue:
{physical venue}
```

For combined Ministry Centre requests, each Calendar event names its own
physical target venue. The requester email and Jotform submission ID stay
out of the visible description. Editing an approved booking's requester
name reconciles the description; editing its event name, purpose, or
ministry reconciles both the title and description.

Convex claims make overlapping RoomOps submissions atomic. Google
Calendar exposes availability checking and event creation as separate API
operations, so no integration can hold an atomic lock against a person
who inserts an external event in the brief interval after the final
free/busy check. RoomOps minimizes that external race by checking again
immediately before creation and records the result in `/logs`.

## 2. Create the Google Cloud service account

1. Open the [Google Cloud console](https://console.cloud.google.com/).
2. Create a project or select the project that will own the RoomOps
   integration.
3. Open **APIs & Services → Library**.
4. Search for **Google Calendar API** and select **Enable**.
5. Open **IAM & Admin → Service Accounts**.
6. Select **Create service account**.
7. Use a recognizable name such as `roomops-calendar`.
8. Do not grant the service account Project Owner or Project Editor. Access
   to the venue calendars is granted separately in Google Calendar.
9. Open the new service account and select **Keys → Add key → Create new
   key → JSON**.
10. Download the JSON file and store it securely.

The JSON file contains a private key. Do not commit it, put it in
`.env.local`, upload it to Vercel, paste it into chat, or share it with
other administrators. Google does not let you download the same private
key again; create a replacement key and revoke the old one when rotating
credentials.

Copy the `client_email` value from the JSON file. It resembles:

```text
roomops-calendar@YOUR_PROJECT.iam.gserviceaccount.com
```

## 3. Share every venue calendar

The check marks in Google Calendar show which calendars are visible in
the current browser. They do not give the service account access.

For each of the following ten calendars:

1. Open Google Calendar on a computer.
2. Under **My calendars**, point to the calendar and select
   **More → Settings and sharing**.
3. Under **Share with specific people or groups**, add the service
   account's `client_email`.
4. Grant **Make changes to events**. Read-only or free/busy-only access
   is not sufficient because RoomOps creates and updates approved events.

Share these calendars:

- Board Room
- Counselling / Music Room
- L1 Ministry Space
- Ministry Centre A
- Ministry Centre B
- Ministry Centre C
- Office L2 Main Area
- Pastor Office
- PIC Office
- Shema Space

Do not substitute LWMC Shared Calendar, Birthdays, or Tasks. They are not
venue calendars in this integration.

If a Google Workspace policy prevents sharing with the service-account
address, a Workspace administrator must permit that sharing. This
integration does not impersonate a Workspace user through domain-wide
delegation.

Reference: [Share your calendar](https://support.google.com/calendar/answer/37082).

## 4. Copy the real Calendar IDs

Repeat these steps for each of the same ten calendars:

1. Open **Settings and sharing**.
2. Scroll to **Integrate calendar**.
3. Copy **Calendar ID**.

Use the Calendar ID, not the display name, browser URL, public URL, embed
code, or secret iCal address. A Calendar ID may resemble an email address
or a long value ending in `@group.calendar.google.com`.

Create a local file named `google-calendar-map.json` outside the
repository:

```json
{
  "Board Room": "REPLACE_WITH_BOARD_ROOM_CALENDAR_ID",
  "Counselling / Music Room": "REPLACE_WITH_COUNSELLING_MUSIC_ROOM_CALENDAR_ID",
  "L1 Ministry Space": "REPLACE_WITH_L1_MINISTRY_SPACE_CALENDAR_ID",
  "Ministry Centre A": "REPLACE_WITH_MINISTRY_CENTRE_A_CALENDAR_ID",
  "Ministry Centre B": "REPLACE_WITH_MINISTRY_CENTRE_B_CALENDAR_ID",
  "Ministry Centre C": "REPLACE_WITH_MINISTRY_CENTRE_C_CALENDAR_ID",
  "Office L2 Main Area": "REPLACE_WITH_OFFICE_L2_MAIN_AREA_CALENDAR_ID",
  "Pastor Office": "REPLACE_WITH_PASTOR_OFFICE_CALENDAR_ID",
  "PIC Office": "REPLACE_WITH_PIC_OFFICE_CALENDAR_ID",
  "Shema Space": "REPLACE_WITH_SHEMA_SPACE_CALENDAR_ID"
}
```

All ten keys are required. Each Calendar ID must be assigned to only one
individual venue. Do not add combined entries such as Ministry Centre
A & B or Ministry Centre ABC; RoomOps performs that fan-out itself.

## 5. Set the Convex development variables

These are Convex server variables. Set them in the same development
deployment used by `npx convex dev`.

First, keep Calendar automation disabled while loading the configuration:

```bash
npx convex env set GOOGLE_CALENDAR_ENABLED false
npx convex env set BOOKING_RECURRENCE_DEFAULT_COUNT 12
```

Encode the downloaded service-account JSON and pipe it directly to
Convex. This keeps the secret value out of shell history:

```bash
base64 < /PATH/TO/service-account.json \
  | tr -d '\n' \
  | npx convex env set GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64
```

Set the venue map from the file created in the previous section:

```bash
npx convex env set GOOGLE_CALENDAR_VENUE_MAP_JSON \
  --from-file /PATH/TO/google-calendar-map.json
```

Restart or leave `npx convex dev` running so the latest Convex functions
are deployed. Leave `GOOGLE_CALENDAR_ENABLED=false` until the one-time
claim normalization in section 10 is finished.

`BOOKING_RECURRENCE_DEFAULT_COUNT` must be an integer from 2 through 120.
It is used only when Jotform says a booking repeats but supplies neither
a repeat count nor a repeat-until date. The default is 12 when the
variable is omitted.

## 6. Set the production variables

Production needs the same four variable names in the production Convex
deployment. Prefer a separate production service account and key. If
development points at the live venue calendars, development tests create
real calendar events and can affect live availability.

```bash
npx convex env --prod set GOOGLE_CALENDAR_ENABLED false
npx convex env --prod set BOOKING_RECURRENCE_DEFAULT_COUNT 12

base64 < /PATH/TO/production-service-account.json \
  | tr -d '\n' \
  | npx convex env --prod set GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64

npx convex env --prod set GOOGLE_CALENDAR_VENUE_MAP_JSON \
  --from-file /PATH/TO/production-google-calendar-map.json
```

Do not add these variables to Vercel. The Calendar calls run in Convex
actions; Vercel only needs the frontend, Clerk, and Convex deployment
variables documented in `INTEGRATION_SETUP.md`. Deploy the production
Convex functions and frontend with Calendar automation still disabled,
then follow section 10.

## 7. Map the optional Jotform fields

Sign in as Head Administrator, open `/admin/integrations`, select
**Inspect configured form**, and map the applicable questions using their
stable numeric Jotform question IDs (`qid`).

The Calendar and recurrence-related mapping keys are:

| Mapping key | Jotform value | Required |
|---|---|---:|
| `eventName` | Event name | No |
| `purpose` | Purpose of booking | No |
| `ministry` | Ministry | No |
| `recurrence` | Repeat option | When any recurrence bound is mapped |
| `recurrenceHasEndDate` | Does this recurring booking have an end date? | No |
| `recurrenceCount` | Legacy total number of occurrences | No |
| `recurrenceUntil` | What is the LAST date required for the booking? | With the end-date question |

The required requester, room, and timing fields remain unchanged. A
complete split-date example resembles:

```json
{
  "requesterName": "3",
  "requesterEmail": "4",
  "room": "5",
  "eventName": "6",
  "purpose": "7",
  "ministry": "8",
  "recurrence": "9",
  "recurrenceHasEndDate": "10",
  "recurrenceUntil": "11",
  "date": "12",
  "startTime": "13",
  "endTime": "14"
}
```

Those numbers are examples only. Use the qids displayed for form
`261740998492068`. Omit a mapping key when the corresponding question
does not exist.

Set the generated JSON:

```bash
npx convex env set JOTFORM_FIELD_MAP_JSON
npx convex env --prod set JOTFORM_FIELD_MAP_JSON
```

Run the commands separately and paste the matching development or
production JSON when prompted.

The integration screen prevents copying an incomplete map or assigning
one Jotform question ID to more than one canonical field. Convex enforces
the same rules, so a manually entered duplicate mapping is rejected
instead of silently reusing one answer.

Adding unrelated questions such as Remarks or Phone Number still needs
no mapping. Those responses remain dynamic qid-keyed Convex columns.
Renaming or reordering a mapped question is safe; deleting and recreating
it may produce a new qid and requires remapping.

## 8. Recurrence semantics

RoomOps recognizes these form choices:

| Jotform choice | RoomOps behavior |
|---|---|
| No repeat | One occurrence |
| Daily | Every local calendar day |
| Every week | Every week on the starting weekday |
| Every 2 weeks | Every other week on the starting weekday |
| Every month on the same day | The same ordinal weekday, such as the third Friday |
| Every month on the same date | The same numerical date, such as the 16th |

The original booking is occurrence 1, so a count of 4 means the original
date plus three later occurrences.

Additional rules:

- When `recurrenceHasEndDate` is **Yes**, `recurrenceUntil` is required
  and inclusive through the end of that date in `BOOKING_TIME_ZONE`.
- When `recurrenceHasEndDate` is **No**, a stale hidden
  `recurrenceUntil` answer is ignored and
  `BOOKING_RECURRENCE_DEFAULT_COUNT` is used.
- An older field map without `recurrenceHasEndDate` remains compatible:
  a supplied `recurrenceUntil` is honored.
- With the new Yes/No field mapped, it is authoritative even if an
  obsolete count mapping remains: **Yes** uses the last date and **No**
  uses the configured default count.
- In a legacy map without the Yes/No field, if count and repeat-until are
  both supplied, the earlier bound wins.
- If neither is supplied for a repeating booking,
  `BOOKING_RECURRENCE_DEFAULT_COUNT` is used.
- A series may contain at most 120 concrete occurrences.
- An until-only series may extend at most five years from its first
  occurrence.
- Monthly same-date bookings skip months that do not contain that date.
  For example, a booking on the 31st does not run in February.
- Monthly same-day bookings on a fifth weekday skip months without that
  fifth weekday.
- Recurrences preserve the venue's local wall-clock start and end times.
  A multi-occurrence series that reaches a UTC-offset transition is
  rejected with
  `RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED`. Google applies a
  recurring event's initial exact duration to later instances, which can
  otherwise disagree with RoomOps' wall-clock reservation intervals
  around daylight-saving or other offset changes.
- Occurrences in one request must not overlap each other. Exact adjacency
  is allowed, but a daily request whose individual booking lasts longer
  than 24 hours is rejected with
  `BOOKING_OCCURRENCES_SELF_OVERLAP`.
- One request may require at most 2,000 reservation claim slots. RoomOps
  counts each UTC date touched by each occurrence on each physical
  venue. A long A & B or ABC series therefore consumes more slots than a
  short single-room series. An oversized request is rejected with
  `BOOKING_CLAIM_SLOT_LIMIT_EXCEEDED`.
- Before conflict lookup begins, RoomOps globally deduplicates current
  and legacy claim-room aliases, then budgets one indexed lookup for
  every unique alias and UTC date touched by the occurrences. A plan
  above the conservative 3,000-range transaction budget is rejected with
  `BOOKING_CONFLICT_LOOKUP_RANGE_LIMIT_EXCEEDED`; shorten the series or
  duration, or split the request.

Convex stores the accepted occurrence set and reserves every occurrence.
Google Calendar receives a bounded recurring event whose count matches
that same accepted set.

Reference: [Google Calendar recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents).

## 9. Combined Ministry Centre bookings

Combined selections are aliases, not separate Google calendars:

| Jotform venue | Calendars checked and booked |
|---|---|
| Ministry Centre A & B | Ministry Centre A and Ministry Centre B |
| Ministry Centre ABC | Ministry Centre A, Ministry Centre B, and Ministry Centre C |

The American spelling `Center` and common spacing differences around
`A&B` are normalized. The workflow label `Church Office L1 Ministry
Space` resolves to `L1 Ministry Space`.

Every physical room and every recurrence must be available. A conflict
on B therefore makes an A & B request unavailable even when A is free.
After approval, A & B creates two managed Calendar events; ABC creates
three.

## 10. Deploy, normalize claims, enable, and verify

Complete these steps in order in the target environment:

1. Confirm `GOOGLE_CALENDAR_ENABLED=false`.
2. Deploy the new Convex functions and frontend. For local development,
   keep these running in separate terminals:

```bash
npx convex dev
```

```bash
npm run dev
```

3. Sign in as the Head Administrator and open `/admin/integrations`.
4. Under **Normalize reservation claims**, select **Rebuild active
   claims**. Select **Continue** until the result says **Finished**.
   This idempotent, one-time upgrade rewrites existing pending and
   approved bookings against their physical venue claims, including A&B
   and ABC fan-out. Each Convex mutation processes at most two bookings
   so deleting old claims and inserting rebuilt claims remains safely
   below the transaction write limit; the page advances through multiple
   mutations automatically before asking you to continue.
5. If the result reports skipped bookings, inspect `/logs`. Wait for any
   active Calendar synchronization to finish, fix any invalid legacy
   booking, then run **Rebuild active claims** again from the beginning
   until it finishes without unexpected skips.
6. Enable Calendar automation in that same Convex deployment:

```bash
npx convex env set GOOGLE_CALENDAR_ENABLED true
```

For production, use:

```bash
npx convex env --prod set GOOGLE_CALENDAR_ENABLED true
```

7. Return to `/admin/integrations` and run the Google Calendar
   configuration check.
8. Confirm it reports the service-account email, ten venues, and the
   expected number of calendars.

The connection check verifies free/busy access, reads each Google
calendar's actual name, and requires the service account's effective
access role to be `writer` or `owner`. Compare every returned Google
calendar name with the RoomOps venue to catch swapped IDs. The
end-to-end approval test below still verifies real event creation. If the
check fails, immediately set
`GOOGLE_CALENDAR_ENABLED=false` in that deployment, correct the
configuration, then enable and check again.

## 11. End-to-end test plan

Use dedicated development calendars when possible. Otherwise, select
clearly labeled future test slots that do not interfere with operations.

### One-time booking

1. Submit a Jotform request for Board Room at an unused future time.
2. Confirm `/bookings` shows `pending`, Calendar availability
   `available`, and Calendar sync `not created`.
3. Approve it with an account that has `bookings.approve`.
4. Confirm the booking becomes `approved` and Calendar sync becomes
   `synced`.
5. Open the Board Room calendar and verify the title, time zone,
   description, and venue.

### Existing Calendar conflict

1. Manually create a busy event on a venue calendar.
2. Submit an overlapping Jotform request for that venue.
3. Confirm RoomOps marks the request `unavailable`.
4. Check `/logs` for the Google Calendar availability result.

RoomOps also checks availability again during approval. If someone books
the Calendar after submission but before approval, approval stops and the
request is marked as a Calendar conflict.

To test recovery, temporarily use an invalid development Calendar
configuration and submit a request. The booking should remain visible as
**Availability check pending**, the requester receipt should still be
queued, and no approver or unavailable follow-up should exist. Restore
the configuration and retry the Jotform submission; only then should the
normal pending or unavailable follow-up be created.

### Recurring bookings

Submit short test series for:

- daily, count 3;
- every week, count 3;
- every 2 weeks, count 3;
- every month on the same day beginning on a third Friday; and
- every month on the same date, preferably using a date that demonstrates
  shorter-month behavior.

For each series, verify the occurrence count in RoomOps and the recurring
parent event in Google Calendar.

Also confirm the two booking-side safeguards:

1. Attempt a daily series whose individual occurrence lasts longer than
   one day and confirm RoomOps rejects its self-overlap.
2. Use a development-only oversized long-duration, multi-venue series and
   confirm RoomOps rejects it before writing more than 2,000 claim slots.

### Combined venues

1. Submit Ministry Centre A & B and approve it.
2. Confirm matching events exist on both A and B.
3. Submit an overlapping A-only request and confirm it is unavailable.
4. Repeat with Ministry Centre ABC and verify A, B, and C.

### Approved detail updates and retry

1. Edit Requester Name through an authorized RoomOps edit surface.
   Confirm the approved Google event description updates. Requester Email
   remains in Convex for notifications and is not exposed on Calendar.
2. Edit Event Name, Purpose, or Ministry. Confirm the approved event title
   and description update.
3. Confirm `/logs` records each reconciliation.
4. On a development calendar, temporarily remove the service account's
   write permission, make another approved-booking detail edit, and
   confirm the booking shows **Calendar action needs attention**.
5. Restore **Make changes to events** permission.
6. As Head Administrator or Booking Manager, select the circular-arrow
   **Retry Google Calendar synchronization** action on `/bookings`.
7. Confirm the status returns to `synced` without creating a duplicate
   event.
8. Delete a managed event from a development calendar, trigger or retry
   synchronization, and confirm RoomOps recreates it and saves the new
   managed event reference.

The retry control is deliberately limited to approved bookings that
already have managed Calendar events and whose synchronization failed.
If initial approval fails while the booking is still pending, fix the
cause and select **Approve** again instead.

Finally run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## 12. Troubleshooting

### `GOOGLE_CALENDAR_NOT_ENABLED`

Calendar approval is unavailable while the integration is disabled.
Complete the deployment and one-time claim normalization first, then set
`GOOGLE_CALENDAR_ENABLED=true` in the same Convex deployment used by the
application and run the configuration check.

### `GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON_B64 is not configured`

The encoded JSON was set in a different deployment or the variable name
is wrong. Repeat the base64 pipeline with `--prod` only for production.
Do not use the retired Google Sheets variable
`GOOGLE_SERVICE_ACCOUNT_JSON_B64`.

### `GOOGLE_SERVICE_ACCOUNT_INVALID`

Create a new JSON key for the service account and encode the complete
file. Do not encode only `private_key`, and do not manually alter
`token_uri`.

### `GOOGLE_CALENDAR_VENUE_MAP_INCOMPLETE`

The map must contain every one of the ten individual venue keys listed in
this guide. Combined A & B and ABC are not map keys.

### `GOOGLE_CALENDAR_VENUE_MAP_INVALID`

Check that the value is valid JSON, each value is a real Calendar ID, no
Calendar ID is assigned to two venues, and no venue is configured twice
through spelling aliases.

### `GOOGLE_CALENDAR_RESOLVED_ID_DUPLICATE`

Two configured strings resolve to the same Google calendar, for example
`primary` and that calendar's real ID. Replace aliases with the real
Calendar IDs from **Integrate calendar** and assign each physical
calendar exactly once.

### Free/busy or configuration check returns `403` or `404`

- Confirm the Calendar ID, not its display name, was copied.
- Confirm the Google Calendar API is enabled in the service account's
  Cloud project.
- Confirm every calendar was shared with the exact service-account email.
- Confirm a Workspace sharing policy is not blocking the account.

### Event creation returns `403`

The service account can read the calendar but cannot write to it. Change
its sharing permission to **Make changes to events**.

### `GOOGLE_CALENDAR_WRITE_ACCESS_REQUIRED`

The configuration check found `reader` or `freeBusyReader` access on at
least one mapped calendar. Grant the service account **Make changes to
events**, rerun the check, and compare each returned Google calendar name
with its RoomOps venue before testing approval.

### `GOOGLE_CALENDAR_CONFLICT`

At least one physical venue is busy for at least one requested
occurrence. For A & B or ABC, inspect every underlying venue calendar.
The technical details in `/logs` identify the affected venue and
occurrence.

### `BOOKING_OCCURRENCES_SELF_OVERLAP`

At least two occurrences generated by the same request overlap. Shorten
the individual booking duration, choose a less frequent repeat rule, or
split the request into separate non-overlapping bookings. Occurrences
that touch at an endpoint without overlapping are allowed.

### `RECURRENCE_TIMEZONE_OFFSET_TRANSITION_UNSUPPORTED`

The multi-occurrence series reaches a daylight-saving or other UTC-offset
change in `BOOKING_TIME_ZONE`. Split the request into series that remain
on one side of the transition, or submit the affected dates as one-time
bookings. This safeguard keeps Convex reservation intervals identical to
the instances generated by Google Calendar.

### `BOOKING_CLAIM_SLOT_LIMIT_EXCEEDED`

The request would exceed 2,000 Convex reservation claim rows. The total
is the number of UTC dates touched across all occurrences multiplied by
the number of physical venues. Shorten the series or duration, or split
it into smaller requests.

### `BOOKING_CONFLICT_LOOKUP_RANGE_LIMIT_EXCEEDED`

The conflict query would require more than the conservative 3,000
indexed lookup ranges reserved for one Convex transaction. RoomOps
calculates this before querying by multiplying the number of globally
unique current/legacy claim-room aliases by the total UTC dates touched
across all occurrences. Shorten the series or duration, or split it into
smaller requests.

### `JOTFORM_RECURRENCE_COUNT_INVALID`

The mapped count answer must be a whole number from 1 through 120. For a
repeating series, use at least 2.

### `BOOKING_RECURRENCE_DEFAULT_COUNT_INVALID`

Set `BOOKING_RECURRENCE_DEFAULT_COUNT` to a whole number from 2 through
120.

### A repeat option is treated as invalid

Make sure the Jotform answer is one of the supported choices in section
8. Unknown recurrence labels are rejected instead of silently becoming a
one-time booking.

### Calendar synchronization stays `creating`

Each approval or approved-booking reconciliation owns a durable
31-minute safety lease. This is deliberately one minute longer than the
30-minute Convex action limit, preventing a replacement worker from
writing to Google while the original action could still be running.
After the lease expires, RoomOps marks the operation failed, clears its
ownership token, and records `calendar_sync_lease_expired` in `/logs`.
Scheduler delivery can make the visible transition occur slightly after
31 minutes.

For a pending request, fix the cause and select **Approve** again. For an
approved booking with existing managed events, a Head Administrator or
Booking Manager can use **Retry Google Calendar synchronization** on
`/bookings`. Do not create a replacement Google event manually.

### An approved Calendar retry button is not visible

The circular-arrow retry action appears only when the booking is
approved, already has managed Google Calendar event references, its sync
status is `failed`, and the signed-in role has `bookings.edit`. Use Head
Administrator or Booking Manager. Booking Approver can retry a failed
pending approval by selecting **Approve** again, but cannot reconcile an
approved booking.

### Development works but production fails

Convex development and production environments are separate. Repeat all
four Calendar variables with `npx convex env --prod set ...`, share the
production service-account email with every calendar, and deploy the
production Convex functions.

## 13. Security and maintenance

- Keep the service-account JSON only in the Convex server environment.
- Use separate keys for development and production where practical.
- Revoke unused keys in Google Cloud.
- Grant Calendar access only to the ten venue calendars.
- Do not grant Project Owner/Editor or Calendar sharing-management access.
- Review `google_calendar` entries in `/logs` after failures.
- When rotating a key, set the new base64 JSON in Convex, verify the
  connection, and then revoke the old Google Cloud key.

References:

- [Google Calendar API overview](https://developers.google.com/workspace/calendar/api/guides/overview)
- [Create Calendar events](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [FreeBusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Server-to-server OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)
