<div align="center">

# Bloom V2

**Plan school meals, track leftovers, and coordinate food recovery**

Use one responsive workspace to prepare closer to demand and move suitable surplus toward collection.

</div>

Bloom V2 is the current school-first rebuild of Bloom. It is an active phase-one application, not the final product. The school workflow and access approval system work locally today, while the recovery-partner portals and broader admin analytics remain intentionally limited.

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

- **Request access:** schools, farmer/collectors, and composters can submit an account request without selecting an administrator role.
- **Review applicants:** administrators can approve or reject requests and reveal a generated access code and one-time passphrase.
- **Sign in securely:** approved accounts use role-based sessions and must replace their one-time passphrase after the first sign-in.
- **Plan servings:** school operators enter attendance, service date, and meal to receive a transparent serving recommendation.
- **Manage meals:** schools maintain a searchable meal library and assign multiple meals to calendar dates.
- **Repeat schedules:** meal assignments can run once, weekly, or every two weeks with an optional end date.
- **Record leftovers:** schools log attendance, servings prepared, leftover weight, cause, collection suitability, and notes.
- **Correct records:** waste logs can be edited or deleted until a recovery partner accepts the related pickup.
- **Publish pickups:** suitable leftovers can be published separately from the daily log and tracked through the collection lifecycle.
- **Use recorded insights:** the tracker calculates leftovers per 100 attendees, meal and cause breakdowns, and a 30-day trend once enough dated records exist.

## School workspace

The Home page flows directly into a source-backed Dashboard overview. Its three preview cards show today's waste-log state, the next scheduled service, and the active pickup state before linking to the full workspace.

The detailed Waste tracker keeps the serving calculator, daily waste uploader, pickup publishing action, and recorded-data insights together. Meal calendar and Pickups remain separate focused workspaces. The interface supports light and dark themes, responsive layouts, keyboard navigation, and in-app confirmation dialogs.

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

- **Available now:** school Home, Dashboard overview, Waste tracker, Meal calendar, Pickups, Settings, authentication, access requests, and the administrator approval inbox.
- **Still limited:** farmer/collector and composter accounts can sign in, but their operational portals are deferred.
- **Still deferred:** automatic credential delivery, Capacitor packaging, and verified admin analytics beyond access approval.
- **Not fabricated:** sparse datasets show an onboarding state instead of hard-coded trends, monetary claims, diversion figures, or reliability scores.

## License

No license file is currently included. All rights remain with the repository owner unless a license is added.
