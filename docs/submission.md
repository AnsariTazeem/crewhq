# CrewHQ

Race-proof team formation with complementary-skill discovery and live membership updates.

- [Live application](https://crewhq-mv4g.onrender.com)
- [Source repository](https://github.com/AnsariTazeem/crewhq)
- [Presentation](presentation.pptx)
- [One-page design document](design.pdf)
- [Load-test report](load-report.md)
- [Concurrency result](evidence/last-seat-race.json)

CrewHQ supports event profiles, skill-filtered discovery, explained teammate suggestions, team creation, expiring invitations and leader-managed join requests. MongoDB transactions coordinate capacity, participant exclusivity, audit records and durable operation receipts. Authenticated SSE refreshes the workspace after committed changes.

The stack is React, TypeScript, Express, Better Auth, MongoDB and Docker Compose, with Playwright/Vitest tests and an authenticated k6 workload in GitHub Actions. The hosted application runs on Render Free with MongoDB Atlas Free.

## Demonstration notes

Sign in with Google and register in the demo event. It permits teams of two to four members and remains open after the challenge deadline. New users can create their own team or explore profiles and teams. The Google flow requests basic identity only. No shared test-account password is required.

Render Free cold starts can take about a minute. A team below the minimum can form but remains ineligible until it has enough members. The external organizer submission-to-roster-freeze connection is not included. High availability, hosted load capacity and backup recovery remain unverified. The load report distinguishes reproducible CI results from the separate hosted checks.
