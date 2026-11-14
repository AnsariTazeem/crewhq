# Team Formation API

A TypeScript service for event-based team formation. Participants create teams, invite teammates, apply to teams and discover people with complementary skills.

## Features

- Transactional membership with team-size limits and one team per participant per event.
- Expiring shared invitations and recipient-bound return invitations for removed members.
- Leader-managed join requests, member removal and explicit leadership succession.
- Event profiles, filtered discovery and explained skill/time-zone suggestions.
- Durable operation receipts, attributable audit records and protected private views.

Live transport, the browser interface, the full seed dataset and hosted load-test results are not included. Google OAuth needs provider configuration and end-to-end verification. Local tests do not establish hosted performance or production readiness.

## Requirements

- Node.js 24 and npm.
- Docker with Linux containers for the development replica set.
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

The default origin is `http://localhost:3000`. Health endpoints are `/health/live` and `/health/ready`. For a compiled build, run `npm run build` followed by `npm start`.

The development database binds to `127.0.0.1:27027`. It is unauthenticated and intended only for isolated local use. `npm run db:down` stops containers while preserving the normal database volume.

## Tests

```sh
npm run db:test:up
npm run typecheck
npm run format:check
npm run build
npm test
```

The suite uses signed test sessions and real MongoDB transactions. It covers permissions, request/roster lifecycles, retry recovery, rollback, ranking and concurrency. The last-seat test releases 50 eligible contenders and checks one persisted admission, 49 capacity rejections and matching state/audit/receipts.

An ephemeral fault-injection database runs separately on `127.0.0.1:27028`. Only that test service enables database test commands. Run a single fault suite at a time, and never deploy the test override. Generated results stay in ignored `test-results/`.

GitHub Actions runs formatting, typechecking, build and tests on pull requests and pushes to `main`. A workflow definition is not evidence of a successful remote run; inspect the checks for the exact commit being reviewed.
