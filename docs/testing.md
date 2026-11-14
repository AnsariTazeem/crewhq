# Testing and limitations

Run `npm run db:test:up`, `npm run typecheck`, `npm run format:check`, `npm run build` and `npm test`. The test configuration runs files sequentially because fault-injection control state is shared. Each file uses a separate disposable database and validates its cleanup prefix.

The suite exercises authenticated HTTP with signed Better Auth test sessions and real MongoDB transactions. It covers:

- The 50-contender last-seat race, including persisted roster/person, audit and receipt invariants.
- Cross-team exclusivity, event isolation, retries, response loss and historical receipt replay.
- Session expiry/logout, permissions, input limits, invitation entropy/expiry and limiter failure.
- Requests, cancellation, removal generations, recipient-bound return and leadership changes.
- Atomic rollback when required audit, receipt, outbox or restriction writes fail.
- Profile edits, discovery filtering/pagination, ranking boundaries, DST and incomplete inputs.
- Snapshot pinning and a controlled handover during a blocked candidate read.
- Actual server startup, database readiness, invalid dates and occupied-port failure.

The last-seat test writes `test-results/last-seat-race.json`. JUnit can be generated with:

```sh
npm test -- --reporter=default --reporter=junit --outputFile.junit=test-results/api.xml
```

Results are generated for the machine and commit being tested; local reports are not checked in. CI uploads its own reports. Test fixtures are synthetic and are not production login endpoints.

The live tests exercise real HTTP streams and replica sets: marker-gated readiness, neutral event hints, signed minimum reads, logout/expiry, connection limits, response backpressure, source failure/reconnect and overlapping refreshes. Fault commands are restricted to the separate loopback service. No application endpoint exposes them.

A passing run does not establish Google's external OAuth flow, every distributed failure, browser accessibility, full-dataset performance or hosted capacity. Injected uncertain-commit labels, majority-read command checks and response-loss cases have deliberately bounded scope. Local HTTP/source recovery tests do not establish browser or hosted proxy behavior. The required 10,000-user/2,000-team seed and 100-concurrent-user board benchmark still need results; no p95 figure is claimed here.
