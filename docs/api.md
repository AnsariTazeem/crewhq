# API reference

All routes below are under `/api`. Authentication-provider routes under `/api/auth/*` are managed by Better Auth. Successful commands return an outcome, operation key and minimal result identifiers. Domain rejections include a machine-readable code; unresolved outcomes require reconciliation.

| Method | Route | Purpose |
|---|---|---|
| GET | `/me` | Current signed-in identity. |
| POST | `/events/:eventId/enroll` | Enroll the current participant, `{}`. |
| GET | `/events/:eventId/me` | Current event membership and size eligibility. |
| GET / POST | `/events/:eventId/profile` | Read or replace the current participant's event profile. |
| GET | `/events/:eventId/board` | Event-scoped people or recruiting-team discovery. |
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
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/accept` | Current leader accepts. |
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/decline` | Current leader declines. |
| POST | `/events/:eventId/teams/:teamId/requests/:requestId/withdraw` | Applicant withdraws. |
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
