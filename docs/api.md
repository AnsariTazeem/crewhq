# API reference

All routes below are under `/api`. Authentication-provider routes under `/api/auth/*` are managed by Better Auth. Successful commands return an outcome, operation key and minimal result identifiers. Domain rejections include a machine-readable code; unresolved outcomes require reconciliation.

| Method | Route | Purpose |
|---|---|---|
| GET | `/me` | Current signed-in identity. |
| GET | `/events/:eventId` | Authenticated event name, team-size rules, formation deadline and optional dates, including before enrollment. |
| POST | `/events/:eventId/enroll` | Enroll the current participant, `{}`. |
| GET | `/events/:eventId/me` | Current event membership and size eligibility. |
| GET / POST | `/events/:eventId/profile` | Read or replace the current participant's event profile. |
| GET | `/events/:eventId/board` | Event-scoped people or recruiting-team discovery. |
| GET | `/events/:eventId/live` | Authenticated event-scoped SSE ready/refresh/reset hints. |
| GET | `/events/:eventId/teammate-suggestions` | Explained solo or recruiting-leader suggestions. |
| POST | `/events/:eventId/teams` | Create a team with `{ "name": "Apex" }`. |
| GET | `/events/:eventId/teams/:teamId` | Safe team summary; roster IDs require current membership. |
| POST | `/events/:eventId/teams/:teamId/profile` | Leader edits name/wanted skills with `expectedRevision`. |
| POST | `/events/:eventId/teams/:teamId/invitations` | Issue/reuse a shared invitation or personal return invitation. |
| GET | `/events/:eventId/teams/:teamId/invitations/:invitationId` | Current leader retrieves an active code and equivalent fragment link. |
| POST | `/events/:eventId/teams/:teamId/invitations/:invitationId/revoke` | Leader revokes an invitation, `{}`. |
| POST | `/events/:eventId/invitations/redeem` | Redeem `{ "code": "..." }` without an additional approval. |
| POST | `/events/:eventId/teams/:teamId/requests` | Eligible unteamed participant applies, `{}`. |
| GET | `/events/:eventId/requests` | Applicant's own request statuses. |
| GET | `/events/:eventId/teams/:teamId/requests` | Current leader's private request queue. |
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/accept` | Current leader accepts, `{}`. |
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/decline` | Current leader declines, `{}`. |
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/withdraw` | Applicant withdraws, `{}`. |
| POST | `/events/:eventId/teams/:teamId/members/:userId/remove` | Current leader removes another member. |
| POST | `/events/:eventId/teams/:teamId/leave` | Leave; a leader with remaining members supplies `successorId`. |
| GET | `/events/:eventId/teams/:teamId/history` | Current members read permitted change history. |
| GET | `/events/:eventId/operations/:key` | Actor-owned historical outcome or unresolved observation. |

Profile replacement accepts `expectedRevision` (initially 0), `displayName`, optional `bio`, `offeredSkills` (maximum 10), `wantedSkills` (maximum 5) and nullable named `timeZone`. Tags use the controlled catalog in `src/profiles.ts`, with explicit aliases and deduplication. Missing skills or zone remain valid for participation.

Board query fields: `kind=people|teams`, `limit` (1–50), `after` from `nextCursor`, optional controlled `skill` and literal `search`. People are unteamed event participants. Recruiting teams must be active, unfrozen and have capacity. Discovery output does not authorize admission.

Request lists accept `state=all|pending`, `limit` (1–50) and `after` from `nextCursor`. Own requests default to all; leader queues default to effective pending. Effective state is resolved before pagination. Unavailable entries explain deletion, freeze or closed admissions. History uses `limit` (1–50) and its separate encoded `cursor`.

Shared invitation input is `{ "kind": "shared" }`. Personal return input is `{ "kind": "personal", "subjectId": "..." }` and requires an active removal restriction. A personal credential is bound to its recipient and removal generation; forwarding it does not admit another person. A full-team rejection leaves permission unconsumed.

Suggestions accept `limit` and `unrankedLimit` (1–25, default 10), plus `unrankedAfter`. Context comes from the current participant or their recruiting team when they are its leader. The response explains the versioned scoring rule and separates incomplete results. Ordinary members cannot obtain team-management suggestions.

Typical statuses: 400 invalid input, 401 no valid session, 403 forbidden, 404 unavailable resource, 409 domain conflict, 429 known rate limit and 503 required infrastructure unavailable. Operation lookup uses 202 for unresolved observations and 200 with `originalStatus` for a terminal historical result.

Event view reads accept `X-Read-Frontier` from a live frame. A successful read returns an acknowledgement in the same header only after confirming its minimum snapshot with majority durability. This applies to board, suggestions, event membership/profile, team, history, requests and invitation views. Historical operation lookup has its own reconciliation semantics. `X-Snapshot-Mode` defaults to `reset`; `refresh` requires a frontier and allows overlapping public board projections to share work. Private projections are not shared. See [live updates](live-updates.md) for connection and recovery behavior.

Current member team summaries include a roster of participant IDs and display names. Outsiders receive no roster or member-ID array. Request lists include basic applicant/team display names alongside their authorized statuses. No email addresses or authentication credentials are included.

Browser requests can send `X-Actor-Id` with their expected identity. A mismatch with the signed session returns `409 ACTOR_CHANGED` before any handler runs. Receipt lookups use the same guard, preventing an unresolved intent from being retried under a different shared browser session.
