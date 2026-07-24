# Migrate users from the earlier authentication starter

Use this procedure when `npx convex dev` reports that a `users` document
is missing `clerkUserId` or `displayName` and shows the older
`identitySubject`, `name`, or `requestedAt` fields.

The compatibility release accepts both shapes temporarily, reads both
identity indexes, and includes an internal migration that is callable
from the Convex CLI or Dashboard but not from the web application.
It preserves every user document ID, email, role, status, timestamp, and
review field.

Do not delete the `users` table and do not disable schema validation.

## Development deployment

The commands below target the personal development deployment selected
by `CONVEX_DEPLOYMENT`. Do not add `--prod`.

### 1. Back up the deployment

Stop the failed watcher with `Ctrl+C`, then export the data to a new
filename:

```bash
npx convex export --path room-booking-before-user-migration.zip
```

Keep this ZIP outside source control.

### 2. Install the compatibility code

Replace the affected project files with the corrected starter, or apply
its patch. In particular, the compatibility release must include:

- optional canonical and legacy user fields in `convex/schema.ts`
- both `by_clerk_user_id` and `by_identity_subject` indexes
- dual-read normalization in `convex/lib/auth.ts`
- `users:inspectLegacyUsers` and `users:migrateLegacyUsers`

Start the watcher again:

```bash
npx convex dev
```

Wait until it reports that the Convex functions are ready. The schema
now accepts the existing legacy records, so the push can finish.

The informational `Convex AI files are not installed` message is
unrelated to this migration. It can be left alone.

### 3. Run the read-only preflight

In a second terminal, from the same project directory:

```bash
npx convex run users:inspectLegacyUsers
```

A safe result resembles:

```json
{
  "totalUsers": 2,
  "usersNeedingMigration": 2,
  "safeToMigrate": true,
  "issues": []
}
```

Stop if `safeToMigrate` is `false`. The reported issue identifies a
missing identity, missing display name, conflicting old/new identity, or
duplicate Clerk identity. Fix that record in the Convex Dashboard before
continuing. The migration deliberately refuses to guess which identity
is correct.

### 4. Migrate atomically

When preflight is safe, run:

```bash
npx convex run users:migrateLegacyUsers
```

For each legacy record, this performs one in-place patch:

- `identitySubject` becomes `clerkUserId`
- `name` becomes `displayName`
- `identitySubject`, `name`, and `requestedAt` are removed

It does not delete or reinsert the user. A collision aborts the entire
mutation, so no partial migration is committed. Re-running it is safe
and should report `migrated: 0`.

### 5. Verify

Run:

```bash
npx convex run users:inspectLegacyUsers
npx convex data users --limit 100 --format json
```

The preflight should now report:

```json
{
  "usersNeedingMigration": 0,
  "safeToMigrate": true,
  "issues": []
}
```

Every user row should contain non-empty `clerkUserId` and
`displayName`. No row should retain `identitySubject`, `name`, or
`requestedAt`.

### 6. Restore Head Administrator access

Confirm that Convex contains the exact Clerk user ID:

```bash
npx convex env get HEAD_ADMIN_CLERK_USER_ID
```

Sign in to Clerk as that user. If its migrated database row still has a
lower role such as `booking_manager`, open:

```text
http://localhost:3000/register
```

Submit the registration once. Only the exact configured Clerk ID is
promoted to `head_admin`. Then open:

```text
http://localhost:3000/admin/integrations
```

If the direct URL returns a 404, the Next.js source is still the older
starter. If it shows an authorization screen, the signed-in Clerk user
does not match `HEAD_ADMIN_CLERK_USER_ID`, its status is not active, or
the registration promotion has not been completed.

## Production deployment

Development and production are separate migrations. Do not assume that
success in development changed production.

1. Export production:

```bash
npx convex export --prod --path room-booking-production-before-user-migration.zip
```

2. Deploy the compatibility release.
3. Preflight production:

```bash
npx convex run users:inspectLegacyUsers --prod
```

4. If and only if it reports `safeToMigrate: true`, run:

```bash
npx convex run users:migrateLegacyUsers --prod
```

5. Verify:

```bash
npx convex run users:inspectLegacyUsers --prod
npx convex data users --prod --limit 100 --format json
```

6. Sign in with the production Clerk account whose production `user_...`
   ID is stored in the production `HEAD_ADMIN_CLERK_USER_ID`.

## Final schema contraction

The corrected starter intentionally keeps the compatibility fields
optional until every deployment has been migrated. After development
and production both report zero users needing migration:

1. Make `clerkUserId` and `displayName` required in
   `convex/schema.ts`.
2. Remove `identitySubject`, `name`, and `requestedAt` from the schema.
3. Remove the `by_identity_subject` index and legacy lookup fallback.
4. Deploy this strict schema as a separate release.

This is Convex's supported expand, migrate, then contract sequence:

- [Safe schema changes](https://docs.convex.dev/production/overview#making-safe-changes)
- [Schema validation](https://docs.convex.dev/database/schemas#schema-validation)
- [Internal functions](https://docs.convex.dev/functions/internal-functions)
- [`db.patch` field removal](https://docs.convex.dev/database/writing-data#updating-existing-documents)
