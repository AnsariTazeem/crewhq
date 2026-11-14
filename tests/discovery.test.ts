import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { randomUUID } from "node:crypto";
import type { Person } from "../src/membership.js";

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h?.close();
});

test("profile edits preserve request eligibility and their own revision remains independent of roster changes", async () => {
  const event = await h.event(),
    leader = await h.person("Profile interaction leader"),
    p = await h.person("Profile interaction applicant");
  const team = await h.team(event, leader),
    base = `/api/events/${event}`;
  await h.command(`${base}/enroll`, p).expect(201);
  await h.command(`${base}/teams/${team}/requests`, p).expect(201);
  const body = {
    expectedRevision: 0,
    displayName: "Updated while pending",
    offeredSkills: ["typescript"],
    wantedSkills: [],
    timeZone: "UTC",
  };
  await h.command(`${base}/profile`, p, body).expect(200);
  expect(
    await h.db
      .collection<Person>("people")
      .findOne({ eventId: event, userId: p.id }),
  ).toMatchObject({ membershipEpoch: 0 });
  expect(
    (await h.get(`${base}/requests`, p).expect(200)).body.items[0].status,
  ).toBe("pending");
  const code = await h.sharedCode(event, team, leader);
  await h.command(`${base}/invitations/redeem`, p, { code }).expect(201);
  await h
    .command(`${base}/profile`, p, {
      ...body,
      expectedRevision: 1,
      displayName: "Updated after joining",
    })
    .expect(200);
  expect(
    await h.db
      .collection<Person>("people")
      .findOne({ eventId: event, userId: p.id }),
  ).toMatchObject({
    teamId: team,
    membershipEpoch: 1,
    profile: { profileRevision: 2 },
  });
});

test("team edits replay historically, reject lost authority/freeze and roll back if refresh publication fails", async () => {
  const event = await h.event(),
    leader = await h.person("Metadata outgoing"),
    successor = await h.person("Metadata successor");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`,
    key = randomUUID();
  const original = {
    expectedRevision: 1,
    name: "Initial edit",
    wantedSkills: ["ui-design"],
  };
  await h.command(`${base}/profile`, leader, original, key).expect(200);
  await h.command(`${base}/profile`, leader, original, key).expect(200);
  expect((await h.get(base, leader).expect(200)).body.revision).toBe(2);
  const code = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, successor).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, successor, { code })
    .expect(201);
  await h
    .command(`${base}/leave`, leader, { successorId: successor.id })
    .expect(200);
  const revision = (await h.get(base, successor).expect(200)).body.revision;
  const edit = {
    expectedRevision: revision,
    name: "Repaired edit",
    wantedSkills: [],
  };
  await h.command(`${base}/profile`, leader, edit).expect(403);
  const repairKey = randomUUID();
  await h.db.command({
    collMod: "outbox",
    validator: { denied: { $exists: true } },
    validationAction: "error",
  });
  try {
    await h.command(`${base}/profile`, successor, edit, repairKey).expect(503);
    expect((await h.get(base, successor).expect(200)).body).toMatchObject({
      name: "Initial edit",
      revision,
    });
    expect(
      await h.db
        .collection("audit")
        .countDocuments({ eventId: event, action: "TEAM_PROFILE_UPDATED" }),
    ).toBe(1);
    expect(
      await h.db
        .collection("operations")
        .countDocuments({ eventId: event, key: repairKey }),
    ).toBe(0);
  } finally {
    await h.db.command({ collMod: "outbox", validator: {} });
  }
  await h.command(`${base}/profile`, successor, edit, repairKey).expect(200);
  await h.db
    .collection("teams")
    .updateOne(
      { eventId: event },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    );
  expect(
    (
      await h
        .command(`${base}/profile`, successor, {
          ...edit,
          expectedRevision: revision + 2,
        })
        .expect(409)
    ).body.code,
  ).toBe("ROSTER_FROZEN");
});

test("an enrolled participant edits a bounded event profile with deduplicated skills and a named time zone", async () => {
  const event = await h.event(),
    p = await h.person("Profile participant");
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const path = `/api/events/${event}/profile`;
  const response = await h
    .command(path, p, {
      expectedRevision: 0,
      displayName: "Lin",
      bio: "Backend and testing",
      offeredSkills: ["TypeScript", "ts", "postgresql"],
      wantedSkills: ["ui-design"],
      timeZone: "Asia/Kolkata",
    })
    .expect(200);
  expect(response.body.result.profileRevision).toBe(1);
  const profile = await h.get(path, p).expect(200);
  expect(profile.body).toMatchObject({
    displayName: "Lin",
    offeredSkills: ["postgresql", "typescript"],
    wantedSkills: ["ui-design"],
    profileRevision: 1,
    rankingReady: true,
  });
  expect(profile.body.timeZone).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
  const receipt = await h.db
    .collection("operations")
    .findOne({ eventId: event, key: response.body.operationKey });
  expect(
    await h.db.collection("outbox").findOne({ _id: receipt!._id }),
  ).toMatchObject({ category: "event", eventId: event });
  expect(
    await h.db.collection("audit").countDocuments({ eventId: event }),
  ).toBe(0);
});

test("board filters and keyset pages remain bounded, literal and free of duplicate IDs", async () => {
  const event = await h.event(),
    viewer = await h.person("Paging viewer");
  await h.command(`/api/events/${event}/enroll`, viewer).expect(201);
  const candidates = await Promise.all([
    h.person("One"),
    h.person("Two"),
    h.person("Three"),
  ]);
  for (const p of candidates) {
    await h.command(`/api/events/${event}/enroll`, p).expect(201);
    await h
      .command(`/api/events/${event}/profile`, p, {
        expectedRevision: 0,
        displayName: p === candidates[0] ? "TypeScript builder" : "Designer",
        offeredSkills: p === candidates[0] ? ["typescript"] : ["ui-design"],
        wantedSkills: [],
        timeZone: "UTC",
      })
      .expect(200);
  }
  const base = `/api/events/${event}/board?kind=people`;
  const first = await h.get(`${base}&limit=2`, viewer).expect(200);
  const second = await h
    .get(`${base}&limit=2&after=${first.body.nextCursor}`, viewer)
    .expect(200);
  const ids = [...first.body.items, ...second.body.items].map(
    (p: { id: string }) => p.id,
  );
  expect(new Set(ids).size).toBe(4);
  expect(second.body.nextCursor).toBeNull();
  const filtered = await h
    .get(`${base}&skill=ts&search=builder`, viewer)
    .expect(200);
  expect(filtered.body.items.map((p: { id: string }) => p.id)).toEqual([
    candidates[0]!.id,
  ]);
  expect(
    (
      await h
        .get(`${base}&search=${encodeURIComponent(".*")}`, viewer)
        .expect(200)
    ).body.items,
  ).toEqual([]);
  for (const suffix of [
    "&limit=51",
    "&skill[$ne]=typescript",
    "&sort=anything",
    "&after[$gt]=x",
  ])
    await h.get(`${base}${suffix}`, viewer).expect(400);
});

test("only active teams with space and an unfrozen roster appear as recruiting", async () => {
  const event = await h.event(2),
    viewer = await h.person("Eligibility viewer");
  await h.command(`/api/events/${event}/enroll`, viewer).expect(201);
  const fullLeader = await h.person("Full"),
    frozenLeader = await h.person("Frozen"),
    deletedLeader = await h.person("Deleted"),
    openLeader = await h.person("Open");
  const full = await h.team(event, fullLeader),
    frozen = await h.team(event, frozenLeader),
    deleted = await h.team(event, deletedLeader),
    open = await h.team(event, openLeader);
  const extra = await h.person("Takes last seat");
  await h.command(`/api/events/${event}/enroll`, extra).expect(201);
  const code = await h.sharedCode(event, full, fullLeader);
  await h
    .command(`/api/events/${event}/invitations/redeem`, extra, { code })
    .expect(201);
  await h.db
    .collection("teams")
    .updateOne(
      { eventId: event, leaderId: frozenLeader.id },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    );
  await h
    .command(`/api/events/${event}/teams/${deleted}/leave`, deletedLeader)
    .expect(200);
  const board = await h
    .get(`/api/events/${event}/board?kind=teams`, viewer)
    .expect(200);
  expect(board.body.items.map((t: { id: string }) => t.id)).toEqual([open]);
  expect(board.body.items[0].id).not.toBe(frozen);
});

test("a failed profile refresh write rolls back the edit and allows same-intent repair", async () => {
  const event = await h.event(),
    p = await h.person("Atomic profile");
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const path = `/api/events/${event}/profile`,
    key = randomUUID();
  const body = {
    expectedRevision: 0,
    displayName: "Should not partly save",
    offeredSkills: ["typescript"],
    wantedSkills: [],
    timeZone: "UTC",
  };
  await h.db.command({
    collMod: "outbox",
    validator: { denied: { $exists: true } },
    validationAction: "error",
  });
  try {
    await h.command(path, p, body, key).expect(503);
    expect((await h.get(path, p).expect(200)).body).toMatchObject({
      displayName: "Atomic profile",
      profileRevision: 0,
    });
    expect(
      await h.db
        .collection("operations")
        .countDocuments({ eventId: event, key }),
    ).toBe(0);
  } finally {
    await h.db.command({ collMod: "outbox", validator: {} });
  }
  await h.command(path, p, body, key).expect(200);
});

test("profile intents resist stale edits, invalid inputs and cross-event changes without blocking incomplete participants", async () => {
  const event = await h.event(),
    other = await h.event(),
    p = await h.person("Bounded profile");
  for (const id of [event, other])
    await h.command(`/api/events/${id}/enroll`, p).expect(201);
  const path = `/api/events/${event}/profile`,
    key = randomUUID();
  const body = {
    expectedRevision: 0,
    displayName: "Learner",
    offeredSkills: [],
    wantedSkills: [],
    timeZone: null,
  };
  await h.command(path, p, body, key).expect(200);
  await h.command(path, p, body, key).expect(200);
  expect((await h.get(path, p).expect(200)).body).toMatchObject({
    profileRevision: 1,
    rankingReady: false,
    timeZone: null,
  });
  expect(
    (await h.get(`/api/events/${other}/profile`, p).expect(200)).body,
  ).toMatchObject({ profileRevision: 0, displayName: "Bounded profile" });
  expect(
    (await h.command(path, p, { ...body, displayName: "Stale" }).expect(409))
      .body.code,
  ).toBe("PROFILE_CHANGED");
  for (const patch of [
    { timeZone: "Mars/Olympus" },
    { timeZone: "+05:30" },
    { offeredSkills: ["made-up-skill"] },
    { wantedSkills: Array(6).fill("typescript") },
    { leaderId: p.id },
    { expectedRevision: { $gt: 0 } },
  ])
    await h.command(path, p, { ...body, ...patch }).expect(400);
  await h
    .command(`/api/events/${event}/teams`, p, {
      name: "Incomplete profile can participate",
    })
    .expect(201);
});

test("only a current leader can edit public team details, using its expected revision", async () => {
  const event = await h.event();
  const leader = await h.person("Editable leader"),
    outsider = await h.person("No management rights");
  const team = await h.team(event, leader),
    path = `/api/events/${event}/teams/${team}`;
  await h.command(`/api/events/${event}/enroll`, outsider).expect(201);
  const body = {
    expectedRevision: 1,
    name: "Backend crew",
    wantedSkills: ["TypeScript", "ts", "ui-design"],
  };
  await h.command(`${path}/profile`, outsider, body).expect(403);
  await h.command(`${path}/profile`, leader, body).expect(200);
  const current = await h.get(path, outsider).expect(200);
  expect(current.body).toMatchObject({
    name: "Backend crew",
    wantedSkills: ["typescript", "ui-design"],
    revision: 2,
  });
  expect(
    (
      await h
        .command(`${path}/profile`, leader, {
          ...body,
          name: "Stale confirmation",
        })
        .expect(409)
    ).body.code,
  ).toBe("TEAM_CHANGED");
  const board = await h
    .get(`/api/events/${event}/board?kind=teams&skill=typescript`, outsider)
    .expect(200);
  expect(board.body.items.map((item: { id: string }) => item.id)).toEqual([
    team,
  ]);
  expect(
    await h.db
      .collection("audit")
      .findOne({ eventId: event, action: "TEAM_PROFILE_UPDATED" }),
  ).toMatchObject({ actorId: leader.id, revision: 2 });
});

test("the board is event-scoped, hides teamed people, labels incomplete profiles and exposes no private fields", async () => {
  const event = await h.event(),
    otherEvent = await h.event();
  const viewer = await h.person("Board viewer"),
    incomplete = await h.person("Still discoverable"),
    elsewhere = await h.person("Other event only"),
    leader = await h.person("Already teamed");
  for (const p of [viewer, incomplete])
    await h.command(`/api/events/${event}/enroll`, p).expect(201);
  await h.command(`/api/events/${otherEvent}/enroll`, elsewhere).expect(201);
  const team = await h.team(event, leader);
  const path = `/api/events/${event}/board`;
  await h.get(path, elsewhere).expect(403);
  const people = await h.get(`${path}?kind=people`, viewer).expect(200);
  expect(people.body.items.map((p: { id: string }) => p.id).sort()).toEqual(
    [viewer.id, incomplete.id].sort(),
  );
  expect(
    people.body.items.find((p: { id: string }) => p.id === incomplete.id),
  ).toMatchObject({
    displayName: "Still discoverable",
    rankingReady: false,
    rankingLabel: "Insufficient information to rank",
    timeZone: null,
  });
  const serialized = JSON.stringify(people.body);
  for (const field of [
    "@example.test",
    "membershipEpoch",
    "encryptedCode",
    "restricted",
    "session",
    "cookie",
  ])
    expect(serialized).not.toContain(field);
  const teams = await h.get(`${path}?kind=teams`, viewer).expect(200);
  expect(teams.body.items).toEqual([
    expect.objectContaining({ id: team, memberCount: 1, sizeEligible: false }),
  ]);
  expect(teams.body.items[0]).not.toHaveProperty("members");
  expect(teams.body.items[0]).not.toHaveProperty("invitation");
});
