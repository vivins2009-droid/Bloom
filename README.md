<div align="center">

# Bloom V2

**Plan food service, track leftovers, and coordinate local recovery**

Use one responsive workspace to prepare closer to demand and move suitable surplus toward collection.

</div>

Bloom V2 is the current food-provider-first rebuild of Bloom. It is an active application, not the final product. The food-provider workflow and administrator operations console work locally today, while recovery-partner portals remain intentionally deferred.

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

Use either local demo account:

- **School:** access code `SCH-DEMO`, passphrase `bloom-school`.
- **Administrator:** access code `ADMIN-BLOOM`, passphrase `bloom-admin`.

## What works today

- **Request access:** food providers, farmer/collectors, and composters choose an administrator-managed organization type and submit an account request without exposing the administrator role.
- **Operate the network:** administrators review applicants, manage organization types, control account access, oversee pickup exceptions, and inspect a visible audit record.
- **Issue credentials safely:** approval, manual account creation, and passphrase resets reveal a generated access code and one-time passphrase once.
- **Sign in securely:** approved accounts use role-based sessions and must replace their one-time passphrase after the first sign-in.
- **Plan servings:** school operators enter attendance, service date, and meal to receive a transparent serving recommendation.
- **Manage meals:** schools maintain a searchable meal library and assign multiple meals to calendar dates.
- **Repeat schedules:** meal assignments can run once, weekly, or every two weeks with an optional end date.
- **Record each service:** schools can save more than one waste log on the same date, so a second service or a corrected operational count does not overwrite another record.
- **Correct records:** each waste log can be edited or deleted independently until a recovery partner accepts its related pickup.
- **Publish pickups:** suitable leftovers can be published separately from the daily log and tracked through the collection lifecycle.
- **Use recorded insights:** the tracker calculates leftovers per 100 attendees, meal and cause breakdowns, and a 30-day trend once enough dated records exist.
- **Manage account details:** organization users can update the account-holder name and change their passphrase from Settings.
- **Request organization-name changes:** organization users submit a named change request; an administrator approves or rejects it before the account is updated.

## Food-provider workspace

The Home page flows directly into a source-backed Dashboard overview. Its three preview cards show today's waste-log state, the next scheduled service, and the active pickup state before linking to the full workspace.

The detailed Waste tracker keeps the serving calculator, daily waste uploader, pickup publishing action, and recorded-data insights together. Meal calendar and Pickups remain separate focused workspaces. Schools use this workflow today; later food-provider variants will adapt its language and operational details.

## Administrator workspace

The administrator Home page prioritizes pending access decisions, active organizations, pickup exceptions, confirmed 30-day recovery, and recent activity. Requests, Organizations, Pickups, Activity, and Settings are focused workspaces rather than simulated analytics panels.

Administrators can add, rename, reorder, enable, archive, or remove signup organization types. Changes appear on the public request form immediately. They can also create accounts manually, change an account subtype, suspend or reactivate access, reset one-time credentials, and cancel, expire, or reopen eligible pickups with a required recorded reason.

Organization-name requests appear alongside access requests in the administrator Requests workspace and become part of the audit history. Email and phone editing remain read-only for now because contact verification and delivery are not yet configured.

## Access and data

Local development uses the file-backed repository only when `DATA_DRIVER=file` is configured. Production is designed to use PostgreSQL and never falls back to a local file after a database error.

| Variable | Description | Required |
| --- | --- | --- |
| `DATA_DRIVER` | Selects `file` for local development or `postgres` for PostgreSQL. | Yes |
| `PORT` | Sets the API port. The local default is `5002`. | Yes |
| `WEB_ORIGIN` | Sets the permitted frontend origin. | Yes |
| `DATABASE_URL` | Provides the PostgreSQL connection string when `DATA_DRIVER=postgres`. | PostgreSQL only |

Passphrases are hashed. Sessions use HTTP-only cookies, expire automatically, and are checked against role authorization on protected API routes.

## Current scope

- **Available now:** food-provider Home, Dashboard overview, Waste tracker, Meal calendar, Pickups, Settings, authentication, dynamic access requests, and the administrator operations console.
- **Still limited:** farmer/collector and composter accounts can sign in, but their operational portals are deferred.
- **Still deferred:** automatic credential delivery, Capacitor packaging, recovery-partner portals, maps, exports, SMS integrations, and deeper administrative analytics.
- **Not fabricated:** sparse datasets show an onboarding state instead of hard-coded trends, monetary claims, diversion figures, or reliability scores.

## License

No license file is currently included. All rights remain with the repository owner unless a license is added.
