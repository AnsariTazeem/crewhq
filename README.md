# CrewHQ

A React and TypeScript workspace for event-based team formation. Find complementary skills, form a team and keep membership changes in sync.

## Features

- Transactional membership with team-size limits and one team per participant per event.
- Expiring shared invitations and recipient-bound return invitations for removed members.
- Leader-managed join requests, member removal and explicit leadership succession.
- Event profiles, filtered discovery and explained skill/time-zone suggestions.
- Durable operation receipts, attributable audit records and protected private views.
- Authenticated live refresh hints, signed read frontiers and reset/reconnect recovery.
- Responsive participant, leader and team views with keyboard-operable dialogs and explicit invitation confirmation.

Try the [live workspace](https://crewhq-mv4g.onrender.com). The Render Free service may take about a minute to wake. Hosted health, Google sign-in, enrollment, team creation and two-tab live updates have been checked. The synthetic seed and authenticated k6 workload are available; the [load report](docs/load-report.md) records passing Linux measurements and earlier failed trials. These checks do not establish hosted capacity, high availability or production readiness.

The [project overview](docs/submission.md) links the presentation, one-page design document and verification evidence.

## Requirements

- Node.js 24 and npm.
- Docker Engine 25.0 or later with Linux containers and Docker Compose 2.20.2 or later for the development replica set.
- A Google OAuth web client for interactive sign-in.

## Setup

```sh
npm ci
npm run db:up
npm run setup:local
```

The setup command creates `.env` with separate random secrets and preserves an existing file. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` there. The default callback is `http://localhost:3000/api/auth/callback/google`; configure the provider to match the application origin. Never commit credentials.

Configure the demo event's minimum/maximum size, admission close time and explicit start/end dates. Ranking requires both dates and a positive interval of at most 31 days. The admission-close setting seeds new events; changing that setting does not update a stored event. Startup rejects conflicting team-size or event start/end settings. Updating a stored admission deadline requires an explicit data change.

```sh
npm run dev
```

In a second terminal, run `npm run dev:web` and open `http://localhost:3000`. Development uses API port 3001 behind Vite's same-origin proxy. Set `PORT=3001` in an older `.env` file. Cookies, authentication callbacks and API mutations use the browser origin, not a separate cross-origin API.

For a compiled build, run `npm run build`, then `npm start`. The API serves the built frontend from `dist/web` on its configured port. For a single-process local preview set `PORT=3000` to match `APP_ORIGIN`. Production requires an HTTPS origin and an appropriate port/binding for the hosting environment. Do not deploy the Vite development server. Health endpoints are `/health/live` and `/health/ready`.

The default event ID matches the API configuration. A link can select an event with `?event=<UUID>`. For another default, set `VITE_EVENT_ID` when building the frontend; never put secrets in `VITE_*` variables. Invitations include the event ID and place the credential in a fragment, which the browser removes before explicit confirmation.

The development database binds to `127.0.0.1:27027`. It is unauthenticated and intended only for isolated local use. `npm run db:down` stops containers while preserving the normal database volume.

## Tests

```sh
npm run db:test:up
npm run typecheck
npm run format:check
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

The suite uses signed test sessions and real MongoDB transactions. It covers permissions, request/roster lifecycles, retry recovery, rollback, ranking and concurrency. The last-seat test releases 50 eligible contenders and checks one persisted admission, 49 capacity rejections and matching state/audit/receipts. Browser tests use compiled assets with isolated synthetic participants; their fixture login is confined to test code and is not part of the application build. `PLAYWRIGHT_CHANNEL=msedge` can select an installed browser on supported machines.

An ephemeral fault-injection database runs separately on `127.0.0.1:27028`. Only that test service enables database test commands. Run a single fault suite at a time, and never deploy the test override. Generated results stay in ignored `test-results/`.

GitHub Actions runs formatting, typechecking, build and tests on pull requests and pushes to `main`. A workflow definition is not evidence of a successful remote run; inspect the checks for the exact commit being reviewed.

See [seed and load testing](docs/load-testing.md) for the 10,000-user/2,000-team dataset, 100-user workload, strict gates and report limits.

## API conventions

Protected routes use a session cookie. Application mutations also require JSON, the exact allowed `Origin`, `X-App-Request: 1` and a UUID `Idempotency-Key`.

Use the same key and payload to retry an intent. A timeout is an unknown outcome; use actor-scoped operation lookup to reconcile it. A historical receipt does not describe current membership and cannot reapply an old action.

- [API reference](docs/api.md)
- [Architecture and invariants](docs/architecture.md)
- [One-page design document](docs/design.pdf)
- [Measured load report](docs/load-report.md)
- [Testing and limitations](docs/testing.md)
- [Live updates and freshness](docs/live-updates.md)
- [Browser behavior](docs/browser.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
