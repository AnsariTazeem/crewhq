import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { origin } from "./support/harness.js";
import request from "supertest";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

test("invite guessing is limited per authenticated actor with Retry-After", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Guessing actor");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  for (let index = 0; index < 10; index++) {
    await harness
      .command(`/api/events/${eventId}/invitations/redeem`, actor, {
        code: "A".repeat(22),
      })
      .expect(404);
  }
  const response = await harness.command(
    `/api/events/${eventId}/invitations/redeem`,
    actor,
    { code: "A".repeat(22) },
  );
  expect(response.status).toBe(429);
  expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
});

test("unauthenticated and caller-supplied identities cannot read an authenticated profile", async () => {
  await request(harness.app).get("/api/me").expect(401);
  const person = await harness.person("Not an actor header");
  await request(harness.app)
    .get("/api/me")
    .set("X-User-Id", person.id)
    .expect(401);
});

test("logging out revokes the original cookie for later protected requests", async () => {
  const person = await harness.person("Logout participant");
  await request(harness.app)
    .post("/api/auth/sign-out")
    .set("Cookie", person.cookie)
    .set("Origin", origin)
    .send({})
    .expect(200);
  await harness.get("/api/me", person).expect(401);
});

test("an expired database session cannot authorize a protected request", async () => {
  const person = await harness.person("Expired participant");
  await harness.db
    .collection("session")
    .updateOne(
      { _id: new ObjectId(person.sessionId) },
      { $set: { expiresAt: new Date(0) } },
    );
  await harness.get("/api/me", person).expect(401);
});

test("cookie-authenticated mutations require both the trusted origin and application header", async () => {
  const person = await harness.person("CSRF participant");
  const eventId = await harness.event();
  const path = `/api/events/${eventId}/enroll`;
  await request(harness.app)
    .post(path)
    .set("Cookie", person.cookie)
    .set("Origin", origin)
    .set("Idempotency-Key", randomUUID())
    .send({})
    .expect(403);
  await request(harness.app)
    .post(path)
    .set("Cookie", person.cookie)
    .set("Origin", "https://untrusted.example")
    .set("X-App-Request", "1")
    .set("Idempotency-Key", randomUUID())
    .send({})
    .expect(403);
  expect(
    await harness.db.collection("people").countDocuments({ eventId }),
  ).toBe(0);
});

test("unknown privileged fields and object-shaped invitation codes are rejected", async () => {
  const person = await harness.person("Invalid input participant");
  const eventId = await harness.event();
  await harness.command(`/api/events/${eventId}/enroll`, person).expect(201);
  await harness
    .command(`/api/events/${eventId}/teams`, person, {
      name: "Injected",
      leaderId: "someone-else",
    })
    .expect(400);
  await harness
    .command(`/api/events/${eventId}/invitations/redeem`, person, {
      code: { $ne: null },
    })
    .expect(400);
  expect(await harness.db.collection("teams").countDocuments({ eventId })).toBe(
    0,
  );
});

test("oversized JSON is rejected before a domain operation is recorded", async () => {
  const person = await harness.person("Large input participant");
  const eventId = await harness.event();
  const response = await harness.command(
    `/api/events/${eventId}/teams`,
    person,
    { name: "x".repeat(20_000) },
  );
  expect(response.status).toBe(413);
  expect(response.body).toEqual({ code: "BODY_TOO_LARGE" });
  expect(
    await harness.db.collection("operations").countDocuments({ eventId }),
  ).toBe(0);
});

test("only the current leader can issue or retrieve a team's secret invitation", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Secret owner");
  const outsider = await harness.person("Secret outsider");
  const teamId = await harness.team(eventId, leader);
  const issue = await harness
    .command(`/api/events/${eventId}/teams/${teamId}/invitations`, leader, {})
    .expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, outsider).expect(201);
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/invitations`, outsider, {})
    .expect(403);
  const denied = await harness
    .get(
      `/api/events/${eventId}/teams/${teamId}/invitations/${issue.body.result.invitationId}`,
      outsider,
    )
    .expect(403);
  expect(denied.body).not.toHaveProperty("link");
});

test("a token from a different event is not an admission credential here", async () => {
  const firstEvent = await harness.event();
  const secondEvent = await harness.event();
  const leader = await harness.person("Event-scoped leader");
  const actor = await harness.person("Event-scoped applicant");
  const teamId = await harness.team(firstEvent, leader);
  const code = await harness.sharedCode(firstEvent, teamId, leader);
  await harness.command(`/api/events/${secondEvent}/enroll`, actor).expect(201);
  const response = await harness
    .command(`/api/events/${secondEvent}/invitations/redeem`, actor, { code })
    .expect(404);
  expect(response.body.code).toBe("INVITE_UNUSABLE");
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId: secondEvent, action: "MEMBER_JOINED" }),
  ).toBe(0);
});

test("expired invitation records are rejected even before database cleanup removes them", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Expiry leader");
  const actor = await harness.person("Expiry applicant");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db
    .collection("invitations")
    .updateOne({ eventId, teamId }, { $set: { expiresAt: new Date(0) } });
  expect(
    await harness.db
      .collection("invitations")
      .countDocuments({ eventId, teamId }),
  ).toBe(1);
  await harness
    .command(`/api/events/${eventId}/invitations/redeem`, actor, { code })
    .expect(404);
});

test("a frozen roster blocks both invitation admission and leader departure", async () => {
  const eventId = await harness.event(3, 1);
  const leader = await harness.person("Frozen leader");
  const actor = await harness.person("Frozen applicant");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db
    .collection<{ _id: string; frozen: boolean }>("teams")
    .updateOne({ _id: teamId }, { $set: { frozen: true } });
  const join = await harness
    .command(`/api/events/${eventId}/invitations/redeem`, actor, { code })
    .expect(409);
  const leave = await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, leader)
    .expect(409);
  expect(join.body.code).toBe("ROSTER_FROZEN");
  expect(leave.body.code).toBe("ROSTER_FROZEN");
});

test("a removal restriction cannot be bypassed with a retained shared code", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Readmission leader");
  const actor = await harness.person("Removed participant fixture");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db.collection("restrictions").insertOne({
    eventId,
    teamId,
    userId: actor.id,
    restricted: true,
    generation: 1,
  });
  const response = await harness
    .command(`/api/events/${eventId}/invitations/redeem`, actor, { code })
    .expect(403);
  expect(response.body.code).toBe("PERSONAL_REINVITE_REQUIRED");
});

test("limiter storage failure fails closed instead of admitting or reporting a rate limit", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Limiter-failure leader");
  const actor = await harness.person("Limiter-failure applicant");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db.command({
    collMod: "rate_limits",
    validator: { $jsonSchema: { required: ["testOnlyRequiredMissingField"] } },
  });
  try {
    const response = await harness
      .command(`/api/events/${eventId}/invitations/redeem`, actor, { code })
      .expect(503);
    expect(response.body.code).toBe("LIMITER_UNAVAILABLE");
    expect(
      await harness.db
        .collection("audit")
        .countDocuments({ eventId, action: "MEMBER_JOINED" }),
    ).toBe(0);
  } finally {
    await harness.db.command({ collMod: "rate_limits", validator: {} });
  }
});
