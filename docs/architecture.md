# Architecture and invariants

The service uses Express, Better Auth and the MongoDB Node driver against a replica set. Identity comes from the server-verified session. Team roles, membership and capacity are checked against current domain state rather than client-supplied role fields.

## Membership consistency

Each participant has one event-specific person record with a team pointer, membership epoch and revision. Each team has a bounded roster, current leader, revision, active/deleted state and frozen flag. Admission writes both person and team guards inside a transaction with snapshot reads and majority write concern. Conflicting admissions retry against a fresh decision snapshot. The redundant roster/pointer representation coordinates both one-seat and cross-team races; tests check both directions.

Domain changes commit with their audit record, durable operation receipt and outbox entry. A required-write failure rolls back the transaction. Uncertain commits retry the commit rather than repeating the business action. Existing receipts are rechecked with an explicit primary majority read outside the transaction before replay. Receipt identity binds actor, event and idempotency key; its fingerprint prevents reuse for a different payload. Receipts have no automatic expiry, so late retries cannot recreate a team or rejoin a participant after a later departure.

Teams may form below the minimum size. Capacity remains enforced, and size eligibility is reported separately. A frozen roster rejects admissions, departures, removals and team-profile edits. The submission-to-freeze integration is not included. Leaders leaving nonempty teams explicitly nominate a remaining member; the final departure ends the active team while preserving audit and historical outcomes.

## Requests and invitations

Requests store the applicant's membership epoch. Admission advances that epoch, making other pending requests effectively cancelled for the same event. Departure advances it again; cancelled requests never reactivate. Query pipelines resolve effective state before filtering/pagination. Revision writes coordinate new requests with concurrent admission or target-team changes.

Removal increments a stable event/team/participant restriction generation. Shared codes and ordinary acceptance cannot clear that restriction. The current leader can issue a personal return credential for the exact recipient/current generation. Successful admission consumes the credential and clears the restriction atomically. Unrelated shared invitations remain valid until expiry/revocation.

Invitation codes contain 128 random bits, with a digest for lookup and an encrypted copy for authorized retrieval. Expiry is checked during the command decision. The shared limiter initially permits 10 redemption attempts per minute per actor and 300 per trusted source; storage failure fails closed. Proxy trust is disabled until the deployment topology is configured and verified.

## Reads and ranking

Current-permission checks use bounded linearizable primary reads. Multi-query private views recheck current authority/revision before releasing data. Private request/grant records, email addresses and usable credentials are excluded from general responses. Profile changes update the event person record and publish an event refresh entry without inventing a membership audit event.

Ranking uses an explicit snapshot concern on every projection read and independently rechecks current permissions. Version `skills-zone-v1` orders declared skill coverage first, then local-clock phase proximity, then stable participant ID. With wanted tags, skill coverage is the fraction matched. Without wanted tags, additional declared skills beyond the solo/team offered union are capped at three and divided by three.

Zone comparisons use explicit event boundaries and UTC-noon references inside an interval of at most 31 days. For each member/reference, let r be absolute offset difference modulo 1440 minutes; proximity is `1 - min(r,1440-r)/720`, averaged over members/references. This accounts for date-specific offsets and half-hour zones, but does not establish work-schedule overlap or reciprocal consent. Missing inputs stay labelled unranked rather than receiving invented zero scores.

The full eligible pool is scored within the supported 10,000-candidate scope. Larger pools return unavailable instead of silently truncating top-k. Output pages are bounded. Stable-ID ties are reproducible, not an exposure-fairness guarantee. Hosted performance and recommendation relevance still require measurement.
