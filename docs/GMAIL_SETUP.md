# Gmail notifications and email approval setup

RoomOps uses the Gmail API from Convex actions. OAuth credentials and the
refresh token belong in Convex server environment variables. They must
not be put in `.env.local`, Vercel, browser code, git, screenshots, or
support messages.

The Google Calendar service account is not a Gmail sender. Gmail uses a
separate OAuth client and a refresh token belonging to the mailbox that
sends the notifications.

## 1. Choose the sending mailbox

Choose one Gmail or Google Workspace account that will send all RoomOps
messages. The value configured as `GMAIL_FROM_EMAIL` must be:

- that account's primary email address; or
- an address already configured and verified under Gmail **Settings →
  Accounts and Import → Send mail as**.

Using an unrelated address in the `From` header can cause Gmail to reject
or rewrite the message.

## 2. Enable the Gmail API

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select the project that will own the RoomOps Gmail OAuth client.
3. Open **APIs & Services → Library**.
4. Search for **Gmail API** and enable it.

The Calendar service-account project may be reused, but the Gmail OAuth
credentials remain independent from the Calendar service account.

## 3. Configure the Google Auth consent screen

1. Open **Google Auth Platform → Branding** and complete the required app
   details.
2. Under **Audience**, choose:
   - **Internal** when the sender belongs to a Google Workspace
     organization and RoomOps is only for that organization; or
   - **External** for a consumer Gmail account or cross-organization use.
3. If the app is External and in Testing, add the sending Gmail account
   under **Test users**.
4. Under **Data Access**, add only:

   ```text
   https://www.googleapis.com/auth/gmail.send
   ```

Google can limit refresh-token lifetime while an External application is
in Testing. Move the real production integration to an appropriate
production/trusted state before depending on unattended long-term email.

## 4. Create the OAuth client

1. Open **Google Auth Platform → Clients**.
2. Create an OAuth client with application type **Web application**.
3. Add this authorized redirect URI:

   ```text
   https://developers.google.com/oauthplayground
   ```

4. Save the client ID and client secret in a password manager. Do not add
   either value to the repository.

## 5. Generate an offline refresh token

1. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Select the gear icon.
3. Enable **Use your own OAuth credentials**.
4. Enter the OAuth client ID and client secret from the previous step.
5. In Step 1, enter:

   ```text
   https://www.googleapis.com/auth/gmail.send
   ```

6. Select **Authorize APIs**.
7. Sign in as the exact sending mailbox selected in section 1.
8. Approve the requested send-only access.
9. In Step 2, select **Exchange authorization code for tokens**.
10. Copy the refresh token to the password manager.

OAuth Playground states that refresh tokens created with its default
credentials are automatically revoked after 24 hours. Enabling **Use
your own OAuth credentials** is therefore required.

If Google returns `403 access_denied`, check that:

- the signed-in Gmail address is listed as an OAuth test user;
- the OAuth application is not incorrectly restricted to another
  Workspace organization;
- the Gmail API is enabled in the same Cloud project as the client; and
- OAuth Playground is using the newly created client ID and secret.

If no refresh token is returned, revoke the app's old grant from the
Google account's connected-app settings and authorize again. Google may
omit a refresh token when it believes one has already been issued.

## 6. Configure the Convex development deployment

Run these commands from the project root. Each command prompts for the
value without adding it to a project file:

```bash
npx convex env set APP_BASE_URL
npx convex env set GMAIL_CLIENT_ID
npx convex env set GMAIL_CLIENT_SECRET
npx convex env set GMAIL_REFRESH_TOKEN
npx convex env set GMAIL_FROM_EMAIL
```

For local testing, `APP_BASE_URL` can be:

```text
http://localhost:3000
```

An approver opening that link on another device cannot reach your
computer's localhost. Use a deployed development URL when testing across
devices.

Restart or leave `npx convex dev` running after setting the values.

## 7. Configure the Convex production deployment

Repeat the five settings for production:

```bash
npx convex env --prod set APP_BASE_URL
npx convex env --prod set GMAIL_CLIENT_ID
npx convex env --prod set GMAIL_CLIENT_SECRET
npx convex env --prod set GMAIL_REFRESH_TOKEN
npx convex env --prod set GMAIL_FROM_EMAIL
```

Production `APP_BASE_URL` must be the public Vercel application origin,
for example:

```text
https://roomops.example.org
```

Do not include `/email-decision`, another path, a query string, or a
trailing slash. Gmail values do not need to be copied to Vercel because
the Gmail requests run inside Convex.

## 8. Add approval recipients

1. Sign in as the Head Administrator.
2. Open **Admin management**.
3. Add at least one address under **Approver email management**.
4. Confirm each intended recipient is Active.

Each active recipient gets an individual approval link. Deactivating an
address revokes its unused links.

## 9. Test the connection

1. Open **Head Administrator → Integrations**.
2. Under **Gmail**, select **Check Gmail connection**.
3. Confirm the expected sender and application URL are displayed.
4. Enter an address you can check and select **Send Gmail test**.
5. Confirm the test arrives, including its spam folder.

The connection check validates the refresh-token exchange without
sending mail. The test email validates the Gmail send scope and sender
identity.

## 10. Test the complete booking workflow

1. Submit a non-conflicting Jotform request.
2. Confirm the requester receives a submission-received email.
3. Confirm every active approver receives an individual review link.
4. Open one link without signing in.
5. Enter an approval comment and approve.
6. Confirm:
   - the booking becomes Approved;
   - the Google Calendar event is created; and
   - the requester receives the approval and comment.
7. Submit another request and reject it with a comment.
8. Confirm the requester receives the rejection and comment.
9. Create a conflicting Google Calendar event and submit an overlapping
   request.
10. Confirm the requester receives the received email followed by the
    unavailable email.

For a recurring request, confirm the approval email and review page show
the recurrence type, occurrence count, and final occurrence.

## Delivery recovery and logs

Each booking email is stored as one deduplicated delivery per recipient.
Transient failures retry after approximately 1 minute, 5 minutes, and
30 minutes. A successful recipient is not resent merely because another
recipient failed.

The requester submission-received delivery is a durable prerequisite for
every email that follows for that booking. This includes unavailable,
approver-request, urgent conflict, approval, and rejection messages.
Follow-ups remain blocked until Gmail confirms that the receipt for the
same booking was sent. If the receipt is missing, RoomOps creates it
before queueing the follow-up. If the receipt reaches a terminal failure,
fix the cause and use **Retry failed email deliveries**; sending the
receipt automatically releases its blocked follow-ups.

RoomOps persists the booking and queues this receipt before starting
Google Calendar FreeBusy. A Calendar configuration or network failure
therefore leaves a visible **Availability check pending** row and a
retryable Jotform receipt. It does not create approver links or an
unavailable follow-up until the availability retry completes.

Expired, revoked, used, and deactivated-approver decision links never
return booking or requester details. The public review page only receives
those details while its link remains authorized and actionable.

The Head Administrator can select **Retry failed email deliveries** after
fixing credentials or another terminal problem. The retry command queues
up to 50 failed deliveries at a time.

Open **System logs** and search for actions ending in:

- `_retry_scheduled` — a transient failure will retry automatically;
- `_failed` — retries were exhausted or the error was terminal;
- `_cancelled` — the booking or approval link became obsolete before
  delivery;
- `gmail_test_email_sent` or `gmail_test_email_failed`; and
- `approver_recipients_missing`.

Common error codes:

| Code | Meaning |
|---|---|
| `GMAIL_NOT_CONFIGURED` | One or more required Convex variables is missing. |
| `APP_BASE_URL_INVALID` | The application origin contains an invalid protocol, path, query, or fragment. |
| `GMAIL_TOKEN_FAILED:invalid_grant` | The refresh token was revoked, expired, belongs to another client, or was copied incorrectly. |
| `GMAIL_SEND_FAILED` with 403 | Gmail API, scope, OAuth policy, or sender authorization is incorrect. |
| `GMAIL_FROM_EMAIL_INVALID` | The configured sender is not a valid email address. |
| `GMAIL_RECIPIENT_INVALID` | The stored requester or approver email cannot be used safely. |

Official references:

- [Gmail API: Create and send messages](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Gmail API OAuth server-side authorization](https://developers.google.com/workspace/gmail/api/auth/web-server)
- [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
- [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
