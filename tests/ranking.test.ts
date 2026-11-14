import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import type { Event, Person } from "../src/membership.js";
import type { ParticipantProfile } from "../src/profiles.js";

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h?.close();
});

test("explicit represented needs still count and date-line equivalents measure clock phase, not dates", async () => {
  const event = await rankingEvent();
  const viewer = await person(
    event,
    "Already represented need",
    ["ui-design"],
    ["ui-design"],
    "Pacific/Kiritimati",
  );
  await person(
    event,
    "Same clock different day",
    ["ui-design"],
    [],
    "Pacific/Honolulu",
  );
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, viewer)
    .expect(200);
  expect(response.body.items[0]).toMatchObject({
    skillScore: 1,
    zoneScore: 1,
    matchedSkills: ["ui-design"],
  });
});

test("closed admissions and full teams do not receive actionable recruiting suggestions", async () => {
  const event = await rankingEvent();
  const leader = await person(
    event,
    "Full recruiting leader",
    ["typescript"],
    ["ui-design"],
    "UTC",
  );
  const team = (
    await h
      .command(`/api/events/${event}/teams`, leader, { name: "Full team" })
      .expect(201)
  ).body.result.teamId;
  const code = await h.sharedCode(event, team, leader);
  for (let i = 0; i < 3; i++) {
    const member = await person(
      event,
      `Full member ${i}`,
      ["ui-design"],
      [],
      "UTC",
    );
    await h
      .command(`/api/events/${event}/invitations/redeem`, member, { code })
      .expect(201);
  }
  expect(
    (
      await h
        .get(`/api/events/${event}/teammate-suggestions`, leader)
        .expect(409)
    ).body.code,
  ).toBe("TEAM_NOT_RECRUITING");
  const solo = await person(
    event,
    "Closed solo",
    ["typescript"],
    ["ui-design"],
    "UTC",
  );
  await h.db
    .collection<Event>("events")
    .updateOne({ _id: event }, { $set: { admissionClosesAt: new Date(0) } });
  expect(
    (await h.get(`/api/events/${event}/teammate-suggestions`, solo).expect(409))
      .body.code,
  ).toBe("ADMISSIONS_CLOSED");
});
async function rankingEvent() {
  const event = await h.event();
  await h.db
    .collection<Event & { startsAt: Date; endsAt: Date }>("events")
    .updateOne(
      { _id: event },
      {
        $set: {
          startsAt: new Date("2026-11-14T00:00:00Z"),
          endsAt: new Date("2026-11-16T00:00:00Z"),
        },
      },
    );
  return event;
}
async function person(
  event: string,
  name: string,
  offered: string[],
  wanted: string[],
  timeZone: string | null,
) {
  const p = await h.person(name);
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  await h
    .command(`/api/events/${event}/profile`, p, {
      expectedRevision: 0,
      displayName: name,
      offeredSkills: offered,
      wantedSkills: wanted,
      timeZone,
    })
    .expect(200);
  return p;
}

test("solo suggestions rank declared need coverage before zone convenience and label incomplete candidates", async () => {
  const event = await rankingEvent();
  const viewer = await person(
    event,
    "Recruiting solo",
    ["typescript"],
    ["ui-design", "testing"],
    "Asia/Kolkata",
  );
  const allNeeds = await person(
    event,
    "Both needs",
    ["ui-design", "testing"],
    [],
    "America/New_York",
  );
  const nearby = await person(
    event,
    "Nearby one need",
    ["ui-design"],
    [],
    "Asia/Kolkata",
  );
  const utc = await person(event, "UTC one need", ["testing"], [], "UTC");
  const missing = await person(event, "Missing zone", ["ui-design"], [], null);
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, viewer)
    .expect(200);
  expect(response.body).toMatchObject({
    version: "skills-zone-v1",
    context: { kind: "solo", mode: "needs" },
    eligibleCount: 4,
    rankedCount: 3,
    unrankedCount: 1,
  });
  expect(response.body.items.map((p: { id: string }) => p.id)).toEqual([
    allNeeds.id,
    nearby.id,
    utc.id,
  ]);
  expect(response.body.items[0]).toMatchObject({
    skillScore: 1,
    matchedSkills: ["testing", "ui-design"],
  });
  expect(response.body.explanation.skillRule).toEqual({
    mode: "needs",
    denominator: 2,
    cap: null,
  });
  expect(response.body.items[1].zoneScore).toBe(1);
  expect(response.body.items[2].zoneScore).toBeCloseTo(13 / 24, 10);
  expect(response.body.unranked).toEqual([
    expect.objectContaining({
      id: missing.id,
      skillScore: 0.5,
      zoneScore: null,
      missingInformation: ["candidate.timeZone"],
    }),
  ]);
  expect(JSON.stringify(response.body)).not.toContain("@example.test");
});

test("missing team zones keep computable needs textual/numeric but never fabricate a full ranking", async () => {
  const event = await rankingEvent();
  const leader = await person(
    event,
    "Incomplete context leader",
    ["typescript"],
    [],
    "UTC",
  );
  const member = await person(event, "Incomplete context member", [], [], null);
  const candidate = await person(
    event,
    "Known needs",
    ["ui-design"],
    [],
    "UTC",
  );
  const team = (
    await h
      .command(`/api/events/${event}/teams`, leader, {
        name: "Incomplete ranking context",
      })
      .expect(201)
  ).body.result.teamId;
  await h
    .command(`/api/events/${event}/teams/${team}/profile`, leader, {
      expectedRevision: 1,
      name: "Incomplete ranking context",
      wantedSkills: ["ui-design"],
    })
    .expect(200);
  const code = await h.sharedCode(event, team, leader);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, leader)
    .expect(200);
  expect(response.body.items).toEqual([]);
  expect(response.body.unranked).toEqual([
    expect.objectContaining({
      id: candidate.id,
      skillScore: 1,
      zoneScore: null,
      matchedSkills: ["ui-design"],
      missingInformation: ["context.timeZone"],
    }),
  ]);
});

test("ranking enforces event eligibility, recruiting state, configured dates and current leadership", async () => {
  const event = await rankingEvent(),
    elsewhere = await rankingEvent();
  const leader = await person(
    event,
    "Scoped leader",
    ["typescript"],
    ["ui-design"],
    "UTC",
  );
  const candidate = await person(
    event,
    "Eligible candidate",
    ["ui-design"],
    [],
    "UTC",
  );
  const outsider = await person(
    elsewhere,
    "Other event",
    ["ui-design"],
    [],
    "UTC",
  );
  const path = `/api/events/${event}/teammate-suggestions`;
  await h.get(path, outsider).expect(403);
  expect((await h.get(path, leader).expect(200)).body.eligibleCount).toBe(1);
  const team = (
    await h
      .command(`/api/events/${event}/teams`, leader, { name: "Scoped team" })
      .expect(201)
  ).body.result.teamId;
  const code = await h.sharedCode(event, team, leader);
  await h
    .command(`/api/events/${event}/invitations/redeem`, candidate, { code })
    .expect(201);
  await h
    .command(`/api/events/${event}/teams/${team}/leave`, leader, {
      successorId: candidate.id,
    })
    .expect(200);
  await h
    .command(`/api/events/${event}/teams/${team}/requests`, leader)
    .expect(201);
  // Former leader is now a solo participant, not an authorized team-context caller.
  expect((await h.get(path, leader).expect(200)).body.context.kind).toBe(
    "solo",
  );
  await h.db
    .collection<Event>("events")
    .updateOne({ _id: event }, { $unset: { startsAt: "" } });
  expect((await h.get(path, candidate).expect(503)).body.code).toBe(
    "RANKING_DATES_UNCONFIGURED",
  );
  await h.db.collection<Event>("events").updateOne(
    { _id: event },
    {
      $set: {
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: new Date("2026-12-01T00:00:00Z"),
      },
    },
  );
  expect((await h.get(path, candidate).expect(503)).body.code).toBe(
    "RANKING_DATES_UNCONFIGURED",
  );
  await h.db
    .collection("teams")
    .updateOne(
      { eventId: event },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    );
  expect((await h.get(path, candidate).expect(409)).body.code).toBe(
    "TEAM_NOT_RECRUITING",
  );
});

test("novelty mode caps additional declared skills at three and resolves equal scores by stable ID", async () => {
  const event = await rankingEvent();
  const viewer = await person(
    event,
    "Novelty reference",
    ["typescript"],
    [],
    "UTC",
  );
  const three = await person(
    event,
    "Three new",
    ["python", "rust", "go"],
    [],
    "UTC",
  );
  const four = await person(
    event,
    "Four new",
    ["python", "rust", "go", "java"],
    [],
    "UTC",
  );
  const overlap = await person(
    event,
    "Repeated skill",
    ["typescript"],
    [],
    "UTC",
  );
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, viewer)
    .expect(200);
  expect(response.body.context.mode).toBe("additional-skills");
  expect(response.body.items.map((p: { id: string }) => p.id)).toEqual([
    ...[three.id, four.id].sort(),
    overlap.id,
  ]);
  expect(
    response.body.items.map((p: { skillScore: number }) => p.skillScore),
  ).toEqual([1, 1, 0]);
  expect(response.body.items[2].matchedSkills).toEqual([]);
});

test("zone comparisons use bounded event references across a DST transition rather than today's offset", async () => {
  const event = await rankingEvent();
  await h.db.collection<Event>("events").updateOne(
    { _id: event },
    {
      $set: {
        startsAt: new Date("2026-10-31T00:00:00Z"),
        endsAt: new Date("2026-11-02T00:00:00Z"),
      },
    },
  );
  const viewer = await person(
    event,
    "DST reference UTC",
    ["typescript"],
    ["ui-design"],
    "UTC",
  );
  await person(
    event,
    "DST candidate NY",
    ["ui-design"],
    [],
    "America/New_York",
  );
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, viewer)
    .expect(200);
  // Four references: NY is UTC-4 for the first two and UTC-5 for the latter two.
  expect(response.body.items[0].zoneScore).toBeCloseTo(0.625, 10);
  expect(response.body.explanation.referenceInstants).toEqual([
    "2026-10-31T00:00:00.000Z",
    "2026-10-31T12:00:00.000Z",
    "2026-11-01T12:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
  ]);
  expect(response.body.explanation.runtime).toMatchObject({
    node: process.versions.node,
    icu: process.versions.icu,
    tz: process.versions.tz,
  });
});

test("top-k scores the whole eligible pool and incomplete browse has independent bounded pagination", async () => {
  const event = await rankingEvent();
  const viewer = await person(
    event,
    "Whole-pool viewer",
    ["typescript"],
    ["ui-design", "testing"],
    "UTC",
  );
  const fixture = (
    id: string,
    offeredSkills: ParticipantProfile["offeredSkills"],
    timeZone: string | null,
  ): Person => ({
    _id: `${event}:${id}`,
    eventId: event,
    userId: id,
    teamId: null,
    membershipEpoch: 0,
    revision: 0,
    profile: {
      displayName: id,
      bio: "",
      offeredSkills,
      wantedSkills: [],
      timeZone,
      profileRevision: 1,
    },
  });
  // Controlled candidate-input fixtures, not a claim of creating 104 externally authenticated users.
  await h.db
    .collection<Person>("people")
    .insertMany([
      ...Array.from({ length: 100 }, (_, i) =>
        fixture(`fixture-${String(i).padStart(3, "0")}`, ["typescript"], "UTC"),
      ),
      fixture("zz-best", ["ui-design", "testing"], "Pacific/Auckland"),
      ...Array.from({ length: 3 }, (_, i) =>
        fixture(`unranked-${i}`, ["ui-design"], null),
      ),
    ]);
  const base = `/api/events/${event}/teammate-suggestions?limit=1&unrankedLimit=2`;
  const first = await h.get(base, viewer).expect(200);
  expect(first.body).toMatchObject({
    eligibleCount: 104,
    rankedCount: 101,
    unrankedCount: 3,
  });
  expect(first.body.items.map((p: { id: string }) => p.id)).toEqual([
    "zz-best",
  ]);
  expect(first.body.unranked).toHaveLength(2);
  const second = await h
    .get(`${base}&unrankedAfter=${first.body.unrankedNextCursor}`, viewer)
    .expect(200);
  expect(second.body.unranked.map((p: { id: string }) => p.id)).toEqual([
    "unranked-2",
  ]);
  expect(second.body.unrankedNextCursor).toBeNull();
  for (const suffix of [
    "?limit=26",
    "?context=another-user",
    "?unrankedAfter[$gt]=x",
  ])
    await h
      .get(`/api/events/${event}/teammate-suggestions${suffix}`, viewer)
      .expect(400);
});

test("missing reference skills in novelty mode do not fabricate new-skill coverage", async () => {
  const event = await rankingEvent();
  const viewer = await person(event, "Unknown reference offers", [], [], "UTC");
  const candidate = await person(
    event,
    "Known candidate",
    ["ui-design"],
    [],
    "UTC",
  );
  const response = await h
    .get(`/api/events/${event}/teammate-suggestions`, viewer)
    .expect(200);
  expect(response.body.items).toEqual([]);
  expect(response.body.unranked).toEqual([
    expect.objectContaining({
      id: candidate.id,
      skillScore: null,
      matchedSkills: [],
      missingInformation: ["context.offeredSkills"],
    }),
  ]);
});

test("a recruiting leader's suggestions use team wants and every member's time zone; ordinary members cannot recruit", async () => {
  const event = await rankingEvent();
  const leader = await person(
    event,
    "Team reference",
    ["typescript"],
    [],
    "UTC",
  );
  const member = await person(
    event,
    "Team reference India",
    ["python"],
    [],
    "Asia/Kolkata",
  );
  const wanted = await person(
    event,
    "Wanted designer",
    ["ui-design"],
    [],
    "UTC",
  );
  const overlap = await person(
    event,
    "Already represented",
    ["typescript", "python"],
    [],
    "UTC",
  );
  const teamResponse = await h
    .command(`/api/events/${event}/teams`, leader, { name: "Recruiting crew" })
    .expect(201);
  const team = teamResponse.body.result.teamId;
  await h
    .command(`/api/events/${event}/teams/${team}/profile`, leader, {
      expectedRevision: 1,
      name: "Recruiting crew",
      wantedSkills: ["ui-design"],
    })
    .expect(200);
  const code = await h.sharedCode(event, team, leader);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  const path = `/api/events/${event}/teammate-suggestions`;
  const response = await h.get(path, leader).expect(200);
  expect(response.body.context).toMatchObject({
    kind: "team",
    mode: "needs",
    teamId: team,
  });
  expect(response.body.items.map((p: { id: string }) => p.id)).toEqual([
    wanted.id,
    overlap.id,
  ]);
  expect(response.body.items[0].zoneScore).toBeCloseTo(37 / 48, 10);
  expect(response.body.explanation.contextMembers).toBe(2);
  expect((await h.get(path, member).expect(403)).body.code).toBe(
    "LEADER_REQUIRED",
  );
});
