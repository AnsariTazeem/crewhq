# Live updates and read freshness

`GET /api/events/:eventId/live` requires a current signed session and enrollment in that event. A browser connection starts with `ready`. Committed outbox insertions produce coalesced `refresh` hints; loss of source or authorization produces a best-effort `reset` and closes the connection. Each new connection requires complete authorized snapshots. `Last-Event-ID` does not replay packets.

Ready and refresh data contain only `generation` and `frontier`. They carry no actor, team, applicant, action, credential or private request body. A hint is a reason to fetch permitted state, not evidence that a command succeeded and not permission to read a private view.

## Source and connection lifecycle

Each API process uses one outbox observer on a dedicated MongoDB client with a two-connection pool. Startup completes the initial cursor read, writes a majority-acknowledged control marker, and observes that marker before becoming ready. A returned `watch()` object alone does not establish readiness. Failed observers reset existing connections, open a new source generation and repeat the marker handshake. The source watchdog detects missing cursor progress; `/health/ready` also requires a writable primary.

The stream sends heartbeat comments every 15 seconds, checking the session and event enrollment before further output. Every refresh flush also rechecks access; the original session expiry has its own timer. Logout or access loss can remain unnoticed until that next check. Bytes already sent cannot be recalled. A heartbeat indicates transport/source activity, not a successful snapshot refresh.

There are at most two streams per actor and 512 total streams per process. Connection attempts are limited to 20 per minute per actor through MongoDB shared storage; limiter failure rejects admission. These connection caps are per process, while the attempt budget is shared. Replies include a retry hint on known limits. Slow writes terminate the subscription instead of growing a queue; at most one latest refresh frame waits while authorization or transport work is in progress. Reset delivery itself is best-effort.

## Snapshot protocol

Pass a ready/refresh `frontier` as `X-Read-Frontier` when fetching event views. The token authenticates an event-scoped minimum operation time, a source generation and a ten-minute lifetime. Its signing key is derived with a separate HMAC purpose and database name from the invitation encryption secret. Instances serving the same database must share that secret. Key rotation invalidates outstanding frontiers. Tokens from an earlier generation remain valid minimums until expiry; they never grant authorization.

A refresh opens a new causally consistent session, advances it to the required operation time, and starts a snapshot transaction. An initial barrier read establishes the minimum. Board, ranking, request, history and invitation projection queries share that snapshot. Event membership, profile and team summaries retain current primary linearizable reads after the barrier and may be newer than the projection snapshot. Identity and permission guards also remain separate current reads. Successful read-only commit with majority concern precedes the response's `X-Read-Frontier` acknowledgement. Invalid, expired, unavailable or denied results carry no acknowledgement. Historical operation lookup remains distinct from current event views.

`X-Snapshot-Mode: reset` is the default and always executes a fresh read. Use it for initial connection, reconnection, focus recovery and periodic reconciliation. `refresh` requires a valid frontier. Overlapping refresh-mode public board reads with the same normalized query, generation and minimum can share one in-flight projection after each caller's enrollment is checked. The table holds at most 64 keys and removes completed work. A newer minimum starts different work. Private views are never shared; no completed projection cache is retained. Responses use `Cache-Control: no-store`.

Clients must track generation and successful snapshot completion separately from heartbeat arrival. A hint during a fetch marks the view dirty so another refresh follows it. Reconnects require a fresh snapshot; old in-flight responses must not overwrite newer state. Time-based eligibility and missed hints also require periodic reconciliation, for example every 30 seconds with jitter while visible and online. The React client implements these rules; see [browser behavior](browser.md). Hosted proxy behavior remains unverified.

## Verification limits

Local tests cover source interruption, a write made during the gap, reconnect with a different generation, minimum reads, controlled commit uncertainty, session loss, limits, backpressure and refresh coalescing. They do not establish multi-node failover, production throughput, browser behavior or proxy idle/buffering behavior. Deployment must verify streaming end to end and configure trusted proxy handling deliberately. The local database is not an internet-facing deployment configuration.
