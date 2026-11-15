# Board load report

Measured 15 November 2026 against revision `5a172250ccdb65347fde1f32ad7e3bbad2bf989a`, with a clean checkout. [GitHub Actions run](https://github.com/AnsariTazeem/crewhq/actions/runs/43714456222) passed the load gate, 144 API/client tests and 13 browser scenarios. The benchmark establishes a bounded CI result, not a hosted capacity guarantee.

## Result

| Metric | Measured result | Required gate |
|---|---:|---:|
| Participating signed-in users | 100 | 100 |
| Valid measured board responses | 5,635 / 5,635 | 100% valid |
| Overall p95 | 141.34 ms | Strictly below 200 ms |
| People p95 | 138.86 ms | Strictly below 200 ms |
| Teams p95 | 143.71 ms | Strictly below 200 ms |
| Measured samples | 5,635 | At least 1,000 |
| Achieved request rate | 92.52 requests/second | Reported; no arbitrary rate claim |
| Actual measured elapsed time | 60.91 seconds | 60-second scenario plus final iterations |

The zero-invalid-response result includes HTTP errors and content validation: each response must identify the requested event and board, contain 20 distinct matching public items in the correct cursor order, and confirm a read frontier. Empty, denied, malformed or credential-bearing responses cannot pass. Dataset counts and membership invariants also passed after the workload.

## Reproduction and environment

Run `npm ci`, `npm run db:up`, then `npm run test:load`. Prerequisites, query checks and cleanup safeguards are documented in [load testing](load-testing.md). The runner creates a fresh owned benchmark database; it does not load-test an arbitrary supplied production URL.

- Dataset: 10,000 synthetic auth identities and event participants; 2,000 teams, with 500 at each roster size from one through four; 5,000 unteamed participants, 1,500 recruiting teams and 500 below minimum size. Skills/time zones vary, and 10% lack ranking inputs.
- Workload: k6 2.4.0, 100 constant virtual users, 10-second warm-up, 60 measured seconds and one second of thinking time per request. People and teams each receive half the traffic, including first pages, skill filters, literal name search and next pages.
- Identity: 100 distinct genuine signed sessions, created outside timed traffic. The served API uses the ordinary production auth configuration; no test login route, authorization cache or permission bypass is enabled.
- Runtime: Linux GitHub-hosted runner, four allocated logical CPUs, approximately 15.6 GiB RAM; reported processor model AMD EPYC 9V45. Node v24.22.2; MongoDB 8.0.38 replica set; application pool maximum 100 connections, separate two-connection observer pool.
- Topology: generator container, single API process and database on the same machine over loopback. The run retains linearizable identity/enrollment guards, snapshot reads, majority commit and live-source readiness. It exercises reset snapshots without shared refresh projection reuse.
- Generator image: `grafana/k6@sha256:d41bb79cd8de5a7ad619b53570e3712633e8bff0937010a5c6c57a4747e7a276`.

## Earlier trials and variation

All trials below used 100 participating users and returned 100% valid measured responses. Failed latency trials are retained rather than counted as successful capacity evidence. This table covers development measurements through the cited main run; later Actions runs are separate experiments.

| Environment / Actions run | Source revision | Samples | p95 (ms) | Latency gate |
|---|---|---:|---:|---|
| Windows exploratory, 07:30 UTC | Dirty working tree | 3,410 | 1,892.66 | Failed |
| Windows exploratory, 07:35 UTC | Dirty working tree | 3,652 | 1,308.58 | Failed |
| [Linux 43691890992](https://github.com/AnsariTazeem/crewhq/actions/runs/43691890992) | `187b87c` PR checkout | 5,000 | 274.77 | Failed |
| Windows exploratory, 08:04 UTC | Dirty working tree | 2,582 | 3,022.69 | Failed |
| [Linux 43693364648](https://github.com/AnsariTazeem/crewhq/actions/runs/43693364648) | `a9e791c` PR checkout | 5,367 | 222.48 | Failed |
| [Linux 43694347099](https://github.com/AnsariTazeem/crewhq/actions/runs/43694347099) | `feb3ca4` PR checkout | 5,456 | 153.30 | Passed |
| [Linux 43711675478](https://github.com/AnsariTazeem/crewhq/actions/runs/43711675478) | `4fa1f04` PR checkout | 5,339 | 241.97 | Failed |
| [Linux 43713623384](https://github.com/AnsariTazeem/crewhq/actions/runs/43713623384) | `3392e2c` PR checkout | 5,511 | 168.10 | Passed |
| [Linux 43714456222](https://github.com/AnsariTazeem/crewhq/actions/runs/43714456222) | `5a17225` main | 5,635 | 141.34 | Passed |

PR runs execute GitHub's merge checkout; the retained reports record its complete SHA. Earlier runs are not all the same source tree. The final two rows have identical application trees. Shared-runner CPU models and timing vary, so these observations do not isolate a causal speedup or establish long-term stability. Earlier passing load jobs also do not imply their entire workflow passed: an uncertain-commit fixture cleanup failure was subsequently corrected.

## Retained evidence

- [Main report](evidence/board-main-report.json) and [k6 summary](evidence/board-main-k6-summary.json), retained from artifact `14162245057`. Downloaded ZIP SHA-256: `5a15d5a3e7f3b696dfd43d6149bcad99f50919512a30640622706dc8b63d9114`.
- [Pre-merge report](evidence/board-pr-report.json) and [k6 summary](evidence/board-pr-k6-summary.json), retained from artifact `14160858745`. ZIP SHA-256: `6a610f47a4d946bae3e8427e322ce5495e8cffb3a1c46f468212b615cf6a9e21`.
- [Last-seat race result](evidence/last-seat-race.json), retained from the same main run's API artifact. This is separate correctness evidence, not a simultaneous write component of the board workload.
- [All nine trial reports](evidence/board-trials.json), including failed Linux and exploratory Windows measurements, retain the complete reported environments, revisions and diagnostics.

The hashes identify the downloaded artifact ZIPs, not individual extracted JSON files. Actions artifacts expire after 14 days; the files linked here retain all nine trial reports and the two final k6 summaries beyond that retention window.

## Interpretation limits

k6 HTTP duration measures sending, waiting and receiving; it excludes initial DNS/TCP/TLS establishment and rendered UI latency. This closed-loop workload reduces request arrival rate as responses slow. External Google consent, concurrent membership writes, internet latency, multi-instance failover, sustained soak behavior, free-tier throttling and hosted SSE/proxy behavior are outside this result. Connection-pool and driver diagnostics include warm-up and are clues, not standalone causal explanations.

Hosted deployment remains a separate acceptance check. In particular, a local/CI pass must not be represented as proof that a free database tier can sustain this workload.
