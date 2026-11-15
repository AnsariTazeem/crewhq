# Seed and board load testing

Use Node.js 24, the development MongoDB replica set and Docker Engine 25 or later. The runner pins Grafana k6 2.4.0 by image digest; no cloud load-testing service is used.

## Seed

Run npm run db:up, then npm run seed -- --database h4h_bench_demo. The database name must start with h4h_bench_. Seed data is synthetic: 10,000 auth identities and event participants, 2,000 teams, 500 teams at each roster size from one through four, and 5,000 unteamed people. Skills and six named time zones vary; ten percent of profiles intentionally lack ranking inputs. Initial roster audit entries are explicitly labelled seed-team rather than represented as API commands.

The command never resets an application database. It refuses nonempty unmarked databases. A completed repeat validates existing data without rewriting it. A partial seed remains marked incomplete; use a fresh benchmark database rather than silently overwrite it. Validation checks exact counts, identity references, unique rosters, leader membership and both directions of person/team membership. Schema indexes are initialized by the CLI. Benchmark data does not create real Google accounts or credentials for production access.

## Measured workload

Run npm run test:load. The runner creates a fresh isolated database, seeds and validates it, issues 100 distinct real signed sessions outside timed traffic, and serves the ordinary API/auth implementation on loopback. Fixture helpers are confined to session setup, with no test login endpoint on the target. Cookie/session caching stays disabled; current authorization checks, live-source readiness and reset snapshot transactions remain enabled.

The predeclared k6 profile uses 100 constant virtual users: 10 seconds of warm-up, then 60 measured seconds, with one second of thinking time after each request. The query mix is evenly split between people and recruiting teams, including first pages, skill filters, literal name search and subsequent pages. Responses must contain 20 distinct matching items, correct event/kind metadata, expected public fields and a confirmed read frontier. Authentication denials, invalid JSON, empty pages and private credential fields cannot count as successful board responses.

Required gates are p95 strictly below 200 ms overall and for each board kind, 100 percent valid measured responses, at least 1,000 measured samples and 100 participating virtual users. The supplementary validity/sample/per-kind gates are stricter engineering checks, not additional organizer rules. Threshold failure produces a nonzero exit and retains the report. A zero tool exit without complete passing metrics is rejected.

k6 HTTP duration covers sending, waiting and receiving; it excludes initial DNS/TCP/TLS setup and is not rendered UI latency. This is a closed-loop workload: users slow their request arrival rate when responses slow. Achieved throughput and actual elapsed time are reported. It does not establish arbitrary request-rate capacity or a hosted free-tier result.

## Evidence and cleanup

Each invocation writes a new directory under ignored test-results/load/ with report.json and k6-summary.json. Reports identify the revision and dirty-worktree state, workload, dataset, environment, latency, response validity, sample count, throughput and bounded diagnostics. Driver timing/event-loop diagnostics include the generator interval and warm-up; they are diagnostic clues rather than a standalone root-cause proof. No machine name, home path, session cookie or auth secret is written to reports. Session material is passed through an ephemeral file outside the repository and removed during cleanup. The runner removes only its own newly created database/container; the standalone seed command retains its named dataset.

GitHub Actions runs a separate load job and uploads its reports, including failed results, for 14 days. Download evidence needed for longer retention. Benchmark traffic excludes Google's external consent/login latency and concurrent membership writes. The generator, API and database share one machine; report that topology when interpreting results. Windows Docker networking adds a host/VM path. Use controlled comparisons before attributing latency to a particular component.

The exploratory Windows trials did not meet the latency target. Two final Linux CI runs passed under the documented workload; see the [measured report and retained failed trials](load-report.md). These measurements do not establish hosted capacity.
