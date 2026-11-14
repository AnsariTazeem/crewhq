import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness, origin } from "./support/harness.js";
import type { Person, Team } from "../src/membership.js";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

test("a lost create response is reconciled through its durable actor-owned receipt", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Lost-response creator");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const key = randomUUID();
  // Transport fault outside production code: destroy the response after the real handler commits.
  const server = createServer((incoming, outgoing) => {
    outgoing.end = () => {
      outgoing.destroy();
      return outgoing;
    };
    harness.app(incoming, outgoing);
  });
  try {
    await expect(
      request(server)
        .post(`/api/events/${eventId}/teams`)
        .set("Cookie", actor.cookie)
        .set("Origin", origin)
        .set("X-App-Request", "1")
        .set("Idempotency-Key", key)
        .send({ name: "Committed without a response" }),
    ).rejects.toThrow(/socket|reset|aborted/i);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  const recovered = await harness.get(
    `/api/events/${eventId}/operations/${key}`,
    actor,
  );
  expect(recovered.status).toBe(200);
  expect(recovered.body).toMatchObject({
    outcome: "committed",
    originalStatus: 201,
  });
  await harness
    .command(
      `/api/events/${eventId}/teams`,
      actor,
      { name: "Committed without a response" },
      key,
    )
    .expect(201);
  expect(await harness.db.collection("teams").countDocuments({ eventId })).toBe(
    1,
  );
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "TEAM_CREATED" }),
  ).toBe(1);
});

test("concurrent retries of one create intent return one team and one attributed change", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Repeated creator");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      harness.command(
        `/api/events/${eventId}/teams`,
        actor,
        { name: "One intent" },
        key,
      ),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual(
    Array(10).fill(201),
  );
  expect(
    new Set(responses.map((response) => response.body.result.teamId)).size,
  ).toBe(1);
  expect(await harness.db.collection("teams").countDocuments({ eventId })).toBe(
    1,
  );
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "TEAM_CREATED" }),
  ).toBe(1);
});

test("the same key cannot be reused for a different create payload", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Key owner");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const key = randomUUID();
  await harness
    .command(`/api/events/${eventId}/teams`, actor, { name: "Original" }, key)
    .expect(201);
  const response = await harness
    .command(`/api/events/${eventId}/teams`, actor, { name: "Changed" }, key)
    .expect(409);
  expect(response.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  expect(
    await harness.db.collection("teams").findOne({ eventId }),
  ).toMatchObject({ name: "Original" });
});

test("concurrent retries of one join intent do not duplicate membership or its audit", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Retry leader");
  const actor = await harness.person("Retry applicant");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      harness.command(
        `/api/events/${eventId}/invitations/redeem`,
        actor,
        { code },
        key,
      ),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual(
    Array(5).fill(201),
  );
  const team = await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId });
  expect(team!.members.filter((id) => id === actor.id)).toHaveLength(1);
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "MEMBER_JOINED" }),
  ).toBe(1);
});

test("replaying a historical join after leaving does not rejoin the person", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Late-retry leader");
  const actor = await harness.person("Late-retry member");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const key = randomUUID();
  const first = await harness
    .command(`/api/events/${eventId}/invitations/redeem`, actor, { code }, key)
    .expect(201);
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, actor)
    .expect(200);
  const replay = await harness
    .command(`/api/events/${eventId}/invitations/redeem`, actor, { code }, key)
    .expect(201);
  expect(replay.body).toEqual(first.body);
  const current = await harness
    .get(`/api/events/${eventId}/me`, actor)
    .expect(200);
  expect(current.body.team).toBeNull();
  expect(
    await harness.db
      .collection<Person>("people")
      .findOne({ eventId, userId: actor.id }),
  ).toMatchObject({ teamId: null, membershipEpoch: 2 });
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "MEMBER_JOINED" }),
  ).toBe(1);
});

test("required audit-write failure aborts team, person, receipt and notification effects together", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Audit rollback creator");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const beforeOutbox = await harness.db
    .collection("outbox")
    .countDocuments({ eventId });
  const key = randomUUID();
  await harness.db.command({
    collMod: "audit",
    validator: { $jsonSchema: { required: ["testOnlyRequiredMissingField"] } },
  });
  try {
    const response = await harness
      .command(
        `/api/events/${eventId}/teams`,
        actor,
        { name: "Must roll back" },
        key,
      )
      .expect(503);
    expect(response.body.code).toBe("STORAGE_UNAVAILABLE");
    expect(
      await harness.db.collection("teams").countDocuments({ eventId }),
    ).toBe(0);
    expect(
      await harness.db
        .collection<Person>("people")
        .findOne({ eventId, userId: actor.id }),
    ).toMatchObject({ teamId: null, membershipEpoch: 0 });
    expect(
      await harness.db
        .collection("operations")
        .countDocuments({ eventId, key }),
    ).toBe(0);
    expect(
      await harness.db.collection("outbox").countDocuments({ eventId }),
    ).toBe(beforeOutbox);
  } finally {
    await harness.db.command({ collMod: "audit", validator: {} });
  }
});

test("a different actor cannot retrieve someone else's historical operation result", async () => {
  const eventId = await harness.event();
  const owner = await harness.person("Receipt owner");
  const outsider = await harness.person("Receipt outsider");
  await harness.command(`/api/events/${eventId}/enroll`, owner).expect(201);
  const key = randomUUID();
  await harness
    .command(
      `/api/events/${eventId}/teams`,
      owner,
      { name: "Private receipt" },
      key,
    )
    .expect(201);
  const response = await harness
    .get(`/api/events/${eventId}/operations/${key}`, outsider)
    .expect(202);
  expect(response.body).not.toHaveProperty("result");
  expect(response.body.outcome).toBe("unresolved");
});

test("different teams competing for one unteamed person yield one exclusive admission", async () => {
  const eventId = await harness.event();
  const leaderA = await harness.person("Leader A");
  const leaderB = await harness.person("Leader B");
  const actor = await harness.person("Shared applicant");
  const teamA = await harness.team(eventId, leaderA, "A");
  const teamB = await harness.team(eventId, leaderB, "B");
  const codeA = await harness.sharedCode(eventId, teamA, leaderA);
  const codeB = await harness.sharedCode(eventId, teamB, leaderB);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const responses = await Promise.all(
    [codeA, codeB].map((code) =>
      harness.command(`/api/events/${eventId}/invitations/redeem`, actor, {
        code,
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  expect(responses.find((response) => response.status === 409)!.body.code).toBe(
    "ALREADY_TEAMED",
  );
  expect(
    await harness.db
      .collection("teams")
      .countDocuments({ eventId, members: actor.id }),
  ).toBe(1);
});
