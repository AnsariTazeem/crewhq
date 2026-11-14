# Browser behavior

CrewHQ uses React, Vite, Tailwind CSS, Radix dialogs and locally bundled DM Sans fonts. The workspace includes registration, participant profiles, people/team discovery, explained suggestions, request queues and team management. It has no analytics or third-party scripts.

## Membership and permissions

An unteamed participant can create a team, redeem a credential or send join requests. A participant already in a team must leave before applying elsewhere. The current leader manages requests, invitations and removal. A departing leader explicitly chooses a current successor when others remain. Frozen rosters expose their fixed status and disable roster controls. Event submission itself belongs to the organizer's workflow; the workspace does not invent a separate project-submission interface.

The server remains authoritative. A displayed open seat is not a reservation. Membership, permissions and capacity are checked again inside commands. A removed participant needs a fresh recipient-bound return invitation; a shared code or ordinary request does not restore access.

## Commands and recovery

Mutations use an actor/event-bound UUID idempotency key and send the expected actor identity. The API rejects a mismatch with the signed session before running a command or receipt lookup. A changed shared session refreshes the identity and quarantines the previous actor’s pending metadata. A synchronous guard blocks repeated clicks while a command is active. A confirmed domain rejection ends that intent; a later deliberate attempt uses a new key. A timeout, lost response or server uncertainty retains the current intent and blocks new commands in that tab/event until reconciliation.

Minimal unresolved metadata and non-secret payload fields are retained in session storage, separately by actor and event. Status lookup checks the historical receipt. An explicit retry reuses the original key and payload. Invitation credentials are excluded from generic command persistence; after reload, retrying unresolved redemption requires the original credential to be re-entered. The browser does not enqueue offline mutations or issue a compensating opposite action.

## Invitations

Codes and links represent the same credential. Links contain an event ID and a credential fragment. The browser removes the credential from the address bar without redeeming it. Opening the same link again also requires explicit confirmation. Short-lived tab-local context can retain the invitation through sign-in for at most five minutes; it is cleared on expiry, successful use or logout. This context is accessible to same-origin JavaScript and does not protect against XSS. Session credentials remain in HttpOnly cookies.

## Live views

One event-scoped EventSource carries neutral hints. Each active view serializes reads, records hints received during a fetch and fetches again before applying an older response. Signed minimum frontiers and reset/refresh read modes integrate with the API's snapshot contract. Private query results are not shared between participants.

Reconnect, generation change, focus recovery and periodic reconciliation require a new reset read. While visible and online, reconciliation runs approximately every 30–33 seconds. Offline/hidden tabs suspend the stream; resuming opens a connection with bounded exponential retry. Denied reads clear that view's private data. A connected transport alone does not certify a successful snapshot: loading, stale and read-error states remain separate.

## Accessibility and limits

Forms have visible labels, controlled skill checkboxes and keyboard-operable dialogs with focus containment, Escape dismissal and focus restoration. The page includes a skip link, responsive navigation and reduced-motion support. Browser tests exercise real signed sessions and API behavior, with automated accessibility checks on selected desktop and phone states. Such checks supplement manual keyboard and visual inspection; they do not certify accessibility across every browser or assistive technology.

Google's external consent flow requires configured credentials and separate verification. Browser fixtures do not prove that integration. Hosted HTTPS, reverse-proxy buffering, idle timeouts and cross-node failover need deployment-specific evidence.
