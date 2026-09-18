<div align="center">

# Bloom V2

**Connect verified food waste producers with trusted food collectors**

Use one responsive workspace to prepare closer to demand and move suitable surplus toward collection.

</div>

Bloom V2 is a private food-recovery network. Food Waste Producers, Food Collectors, and administrators have role-level workspaces backed by the same persisted pickup lifecycle.

## Install

```bash
npm install
```

Run this command from the `Bloom V2` directory with a current Node.js installation.

## Quickstart

Start the web application and API together:

```bash
npm run dev
```

Open [http://localhost:5175](http://localhost:5175). The API runs separately at [http://localhost:5002](http://localhost:5002).

Local file mode boots a separate presentation dataset with populated producer, collector, and administrator workspaces. Changes made while presenting persist in `apps/api/data/presentation.json`; the existing `dev.json` state is left untouched.

The presentation dataset uses these demo accounts:

- **Food Waste Producer:** access code `FWP-DEMO`, passphrase `bloom-producer`.
- **Food Waste Producer:** access code `FWP-SUNRISE`, passphrase `bloom-sunrise`.
- **Food Collector:** access code `FCL-DEMO`, passphrase `bloom-recovery`.
- **Administrator:** access code `ADMIN-BLOOM`, passphrase `bloom-admin`.

The Food Collector demo account is added only by the explicitly configured file repository. It is not seeded into PostgreSQL production data.

## What works today

- **Request access:** producers and collectors choose an administrator-managed category, provide structured operational details, and upload the configured verification documents.
- **Operate the network:** administrators review applicants, manage organization types, control account access, oversee pickup exceptions, and inspect a visible audit record.
- **Issue credentials safely:** local development can reveal a one-time passphrase; production approval and resets queue expiring single-use email links and never email plaintext passphrases.
- **Sign in securely:** approved accounts use role-based sessions and must replace their one-time passphrase after the first sign-in.
- **Plan servings:** Food Waste Producers enter attendance, service date, and meal to receive a transparent serving recommendation.
- **Manage meals:** Food Waste Producers maintain a searchable meal library and assign multiple meals to calendar dates.
- **Repeat schedules:** meal assignments can run once, weekly, or every two weeks with an optional end date.
- **Record each service:** Food Waste Producers can save more than one waste log on the same date, so a second service or a corrected operational count does not overwrite another record.
- **Correct records:** each waste log can be edited or deleted independently until a food collector accepts its related pickup.
- **Publish pickups:** Food Waste Producers choose a collection window and pickup instructions. Bloom snapshots the saved address so an active listing does not change later.
- **Recover surplus:** Food Collectors use one workspace for eligible listings, one active pickup, handoff progress, and confirmed history.
- **Reserve safely:** reservation is atomic, hides the pickup from others for 30 minutes, and releases it automatically when a partner does not start transit in time.
- **Use recorded insights:** the tracker calculates leftovers per 100 attendees, meal and cause breakdowns, and a 30-day trend once enough dated records exist.
- **Manage account details:** organization users can update the account-holder name and change their passphrase from Settings.
- **Request organization-name changes:** organization users submit a named change request; an administrator approves or rejects it before the account is updated.
- **Coordinate privately:** a provider and the food collector who reserves its pickup receive a shared conversation immediately. Every organization can open a private Admin support conversation; administrators can visibly join pickup conversations.
- **Share images safely:** chat accepts up to four browser-sanitized JPEG, PNG, or WebP images per message. Private objects are returned only through short-lived bearer links after an authorization check.

## Food Waste Producer workspace

The Home page flows directly into a source-backed Dashboard overview. Its three preview cards show today's waste-log state, the next scheduled service, and the active pickup state before linking to the full workspace.

The detailed Waste tracker keeps the serving calculator, service-record uploader, pickup publishing action, and recorded-data insights together. Meal calendar, Pickups, and Chat remain separate focused workspaces. Every producer category receives this same interface.

## Food Collector workspace

Food Collectors share the same Home, Available pickups, My pickup, History, and Settings experience. Available pickups are ordered by deadline and show the Food Waste Producer, exact address, weight, collection window, and instructions before reservation.

A collector can hold one pickup across Reserved, In transit, and Awaiting producer confirmation. Reserved pickups release after 30 minutes unless transit starts. Collectors can cancel Reserved or In-transit pickups with a reason; after handoff, only the Food Waste Producer can confirm collection.

## Administrator workspace

The administrator Home page prioritizes pending access decisions, active organizations, pickup exceptions, confirmed 30-day recovery, and recent activity. Requests, Organizations, Pickups, Activity, and Settings are focused workspaces rather than simulated analytics panels.

Administrators can add, rename, reorder, enable, archive, or remove signup organization types. Changes appear on the public request form immediately. They can also create accounts manually, change an account subtype, suspend or reactivate access, reset one-time credentials, and cancel, expire, or reopen eligible pickups with a required recorded reason.

Organization-name requests appear alongside access requests in the administrator Requests workspace and become part of the audit history. Email and phone editing remain read-only for now because contact verification and delivery are not yet configured.

### Administrator access

Administrator credentials are intentionally not created or shared from the ordinary organization-account screen. Production creates the first administrator once from `BOOTSTRAP_ADMIN_EMAIL`, sends that person an expiring setup link, and records the creation in the audit history. Additional administrators currently require an operator-managed database change; administrators must never share one access code or passphrase. A future in-app administrator invitation flow should issue a separate account by email, require the inviting administrator to re-authenticate, and audit both the inviter and recipient.

## Access and data

Local development uses the file-backed repository only when `DATA_DRIVER=file` is configured. Production is designed to use PostgreSQL and never falls back to a local file after a database error.

| Variable | Description | Required |
| --- | --- | --- |
| `DATA_DRIVER` | Selects `file` for local development or `postgres` for PostgreSQL. | Yes |
| `PORT` | Sets the API port. The local default is `5002`. | Yes |
| `WEB_ORIGINS` | Comma-separated production, preview, or staging frontend origins. | Yes |
| `DATABASE_URL` | Provides the PostgreSQL connection string when `DATA_DRIVER=postgres`. | PostgreSQL only |
| `CHAT_ENABLED` | Enables production chat after database, storage, email, and socket health checks pass. | Production chat |
| `EMAIL_ENABLED` | Enables queued transactional email. Keep `false` until Resend is configured. | Production email |
| `ATTACHMENT_DRIVER` | `file` locally or `r2` in production. Production access-request documents always require private R2 storage, even when chat is disabled. | Yes |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Private Cloudflare R2 object storage for verification documents and chat attachments. Never expose these to Vite. | Production |
| `ATTACHMENT_SIGNING_SECRET` | Signs five-minute image access links. | Production images |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional setup, recovery, and throttled chat notification email. | Production email |
| `BOOTSTRAP_ADMIN_EMAIL` | Receives the first administrator’s generated access code and setup link when production has no administrator yet. | First production deployment only |
| `API_PUBLIC_URL` | Public Railway API origin used in attachment links. | Production |
| `VITE_API_URL` | Public API origin compiled into the Vercel frontend. It is not a secret. | Vercel |

Passphrases use versioned salted scrypt hashes. Opaque sessions are stored durably as token hashes, use Secure HTTP-only SameSite cookies in production, expire after 12 hours, and are checked against current account status. State-changing production requests require a rotating CSRF token. Login, access request, recovery, message, and image endpoints are rate-limited.

Production starts with `CHAT_ENABLED=false` and `EMAIL_ENABLED=false` while those integrations are intentionally deferred; their routes remain unavailable rather than falling back to local storage or simulated delivery. Enabling chat requires the complete R2 and Resend configuration. On the first email-enabled production deployment, set `BOOTSTRAP_ADMIN_EMAIL` (and optionally `BOOTSTRAP_ADMIN_NAME` and `BOOTSTRAP_ADMIN_ORGANIZATION`). If no administrator exists, Bloom creates one and queues a 24-hour setup email containing its generated access code and one-time setup link. Restarting cannot create a second bootstrap administrator. The bootstrap email variable can be removed after the first administrator signs in.

PostgreSQL uses one table per entity group. On first production start, the idempotent importer reads a legacy schema-version-3 `bloom_state` document in one transaction, preserves its IDs and access codes, verifies normalization through repository reads, and leaves the old document untouched as rollback material. PostgreSQL failure is fatal; there is no file fallback.

Chat uses REST for every committed mutation and a standards-compliant authenticated WebSocket for immediate update notifications. If the socket disconnects, the UI continues sending through REST and polls every 15 seconds while reconnecting. Images are decoded and re-encoded as metadata-free WebP files by the API before private storage. Messages and attachments expire after one year; the API runs daily cleanup. Pickup conversations become read-only seven days after their terminal state.

The included `vercel.json` builds the Vite workspace as a single-page application. `railway.json` builds and runs the persistent Express/WebSocket service and checks `/api/health`. Configure separate databases, R2 buckets, Resend keys, and domains for development, staging, and production.

## Current scope

- **Available now:** Food Waste Producer, Food Collector, and administrator workspaces; role-aware authentication; dynamic access requests; service planning and logs; collection publishing; atomic reservation; handoff confirmation; and self-service account settings.
- **Still deferred:** Capacitor packaging, maps and geocoding, exports, SMS and push notifications, subtype-specific workflows, and deeper administrative analytics.
- **Not fabricated:** sparse datasets show an onboarding state instead of hard-coded trends, monetary claims, diversion figures, or reliability scores.

## License

No license file is currently included. All rights remain with the repository owner unless a license is added.
