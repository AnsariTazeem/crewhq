import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import type { JoinRequest } from "../src/requests.js";
import type { Event } from "../src/membership.js";
import { randomUUID } from "node:crypto";

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h?.close();
});

test("two leaders accepting the same applicant produce one membership and one accepted request", async () => {
  const event = await h.event(2);
  const a = await h.person("Concurrent A"),
    b = await h.person("Concurrent B"),
    p = await h.person("One applicant");
  const ta = await h.team(event, a),
    tb = await h.team(event, b);
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const pa = `/api/events/${event}/teams/${ta}/requests`,
    pb = `/api/events/${event}/teams/${tb}/requests`;
  const ra = await h.command(pa, p).expect(201),
    rb = await h.command(pb, p).expect(201);
  const responses = await Promise.all([
    h.command(`${pa}/${ra.body.result.requestId}/accept`, a),
    h.command(`${pb}/${rb.body.result.requestId}/accept`, b),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(responses.find((r) => r.status === 409)!.body.code).toBe(
    "REQUEST_CANCELLED",
  );
  for (const response of responses) {
    const receipt = await h.db
      .collection("operations")
      .findOne({ eventId: event, key: response.body.operationKey });
    expect(receipt?.decision.status).toBe(response.status);
    const expected = response.status === 201 ? 1 : 0;
    expect(
      await h.db.collection("audit").countDocuments({ _id: receipt!._id }),
    ).toBe(expected);
    expect(
      await h.db.collection("outbox").countDocuments({ _id: receipt!._id }),
    ).toBe(expected);
  }
  const teams = await h.db
    .collection("teams")
    .find({ eventId: event, members: p.id })
    .toArray();
  expect(teams).toHaveLength(1);
  expect(
    await h.db.collection("people").findOne({ eventId: event, userId: p.id }),
  ).toMatchObject({ teamId: teams[0]!._id, membershipEpoch: 1 });
  expect(
    await h.db
      .collection("requests")
      .countDocuments({ eventId: event, state: "accepted" }),
  ).toBe(1);
  expect(
    await h.db
      .collection("audit")
      .countDocuments({ eventId: event, action: "MEMBER_JOINED" }),
  ).toBe(1);
});

test("acceptance racing with leader departure cannot retain the former leader's authority", async () => {
  const event = await h.event();
  const leader = await h.person("Outgoing leader"),
    successor = await h.person("Chosen successor"),
    p = await h.person("Concurrent applicant");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`;
  const code = await h.sharedCode(event, team, leader);
  for (const actor of [successor, p])
    await h.command(`/api/events/${event}/enroll`, actor).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, successor, { code })
    .expect(201);
  const application = await h.command(`${base}/requests`, p).expect(201);
  const [accept, leave] = await Promise.all([
    h.command(
      `${base}/requests/${application.body.result.requestId}/accept`,
      leader,
    ),
    h.command(`${base}/leave`, leader, { successorId: successor.id }),
  ]);
  expect(leave.status).toBe(200);
  expect([201, 403]).toContain(accept.status);
  const current = await h.get(base, successor).expect(200);
  expect(current.body.leaderId).toBe(successor.id);
  expect(current.body.members).not.toContain(leader.id);
  expect(current.body.members.includes(p.id)).toBe(accept.status === 201);
  await h.get(`${base}/requests`, leader).expect(403);
  await h
    .command(
      `${base}/requests/${application.body.result.requestId}/decline`,
      leader,
    )
    .expect(403);
});

test("request creation overlapping shared admission leaves no actionable application after joining", async () => {
  const event = await h.event();
  const a = await h.person("Request target"),
    b = await h.person("Invite target"),
    p = await h.person("Contending applicant");
  const ta = await h.team(event, a),
    tb = await h.team(event, b);
  const code = await h.sharedCode(event, tb, b);
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const [application, admission] = await Promise.all([
    h.command(`/api/events/${event}/teams/${ta}/requests`, p),
    h.command(`/api/events/${event}/invitations/redeem`, p, { code }),
  ]);
  expect(admission.status).toBe(201);
  expect([201, 409]).toContain(application.status);
  const queue = await h
    .get(`/api/events/${event}/teams/${ta}/requests`, a)
    .expect(200);
  expect(queue.body.items).toEqual([]);
  expect(
    await h.db.collection("people").findOne({ eventId: event, userId: p.id }),
  ).toMatchObject({ teamId: tb, membershipEpoch: 1 });
});

test("a failed request-decision write rolls back admission and the same intent can recover after repair", async () => {
  const event = await h.event();
  const leader = await h.person("Atomic decision leader"),
    p = await h.person("Atomic decision applicant");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`;
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const application = await h.command(`${base}/requests`, p).expect(201);
  const path = `${base}/requests/${application.body.result.requestId}/accept`,
    key = randomUUID();
  await h.db.command({
    collMod: "requests",
    validator: { state: { $ne: "accepted" } },
    validationLevel: "strict",
    validationAction: "error",
  });
  try {
    await h.command(path, leader, {}, key).expect(503);
    expect(
      await h.db.collection("people").findOne({ eventId: event, userId: p.id }),
    ).toMatchObject({ teamId: null, membershipEpoch: 0 });
    expect(
      await h.db
        .collection("requests")
        .findOne({ _id: application.body.result.requestId }),
    ).toMatchObject({ state: "pending" });
    expect(
      await h.db
        .collection("audit")
        .countDocuments({ eventId: event, action: "MEMBER_JOINED" }),
    ).toBe(0);
    expect(
      await h.db
        .collection("operations")
        .countDocuments({ eventId: event, key }),
    ).toBe(0);
  } finally {
    await h.db.command({ collMod: "requests", validator: {} });
  }
  await h.command(path, leader, {}, key).expect(201);
});

test("pending queues filter cancelled history before limiting and return bounded stable cursors", async () => {
  const event = await h.event();
  const leader = await h.person("Queue leader"),
    p = await h.person("Current application");
  const team = await h.team(event, leader);
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const path = `/api/events/${event}/teams/${team}/requests`;
  const current = await h.command(path, p).expect(201);
  // Historical epochs model long-lived queues; these are not actionable pending rows.
  await h.db.collection<JoinRequest>("requests").insertMany(
    Array.from({ length: 25 }, (_, i) => ({
      _id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      eventId: event,
      teamId: team,
      applicantId: p.id,
      personId: `${event}:${p.id}`,
      epoch: -1 - i,
      state: "pending" as const,
      at: new Date(),
    })),
  );
  const page = await h.get(`${path}?limit=1`, leader).expect(200);
  expect(page.body.items).toEqual([
    expect.objectContaining({
      id: current.body.result.requestId,
      status: "pending",
    }),
  ]);
  expect(page.body.nextCursor).toBeNull();
  const first = await h.get(`${path}?state=all&limit=1`, leader).expect(200);
  expect(first.body.items[0].status).toBe("cancelled");
  const second = await h
    .get(`${path}?state=all&limit=1&after=${first.body.nextCursor}`, leader)
    .expect(200);
  expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  await h.get(`${path}?limit=51`, leader).expect(400);
});

test("new requests and decisions obey capacity, enrollment, event, and frozen-roster guards", async () => {
  const event = await h.event(2),
    otherEvent = await h.event();
  const leader = await h.person("Guard leader"),
    p = await h.person("Guard applicant"),
    q = await h.person("Taking seat");
  const team = await h.team(event, leader);
  const path = `/api/events/${event}/teams/${team}/requests`;
  expect((await h.command(path, p).expect(403)).body.code).toBe("NOT_ENROLLED");
  await h.command(`/api/events/${event}/enroll`, p).expect(201);
  await h.command(`/api/events/${otherEvent}/enroll`, p).expect(201);
  await h
    .command(`/api/events/${otherEvent}/teams/${team}/requests`, p)
    .expect(404);
  const application = await h.command(path, p).expect(201);
  const id = application.body.result.requestId;
  const code = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, q).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, q, { code })
    .expect(201);
  expect(
    (await h.command(`${path}/${id}/accept`, leader).expect(409)).body.code,
  ).toBe("TEAM_FULL");
  expect((await h.command(path, p).expect(409)).body.code).toBe("TEAM_FULL");
  await h.db
    .collection("teams")
    .updateOne(
      { eventId: event },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    );
  for (const [actor, action] of [
    [leader, "accept"],
    [leader, "decline"],
    [p, "withdraw"],
  ] as const) {
    expect(
      (await h.command(`${path}/${id}/${action}`, actor).expect(409)).body.code,
    ).toBe("ROSTER_FROZEN");
  }
  expect((await h.get(path, leader).expect(200)).body.items).toEqual([]);
  expect(
    (await h.get(`/api/events/${event}/requests`, p).expect(200)).body.items[0]
      .status,
  ).toBe("unavailable");
});

test("only the applicant may withdraw and only the current leader may decline; a fresh application is explicit", async () => {
  const event = await h.event();
  const leader = await h.person("Deciding leader"),
    applicant = await h.person("May withdraw"),
    outsider = await h.person("No authority");
  const team = await h.team(event, leader);
  await h.command(`/api/events/${event}/enroll`, applicant).expect(201);
  const path = `/api/events/${event}/teams/${team}/requests`;
  const r1 = await h.command(path, applicant).expect(201);
  await h
    .command(`${path}/${r1.body.result.requestId}/withdraw`, outsider)
    .expect(403);
  await h
    .command(`${path}/${r1.body.result.requestId}/withdraw`, applicant)
    .expect(200);
  await h
    .command(`${path}/${r1.body.result.requestId}/accept`, leader)
    .expect(409);
  const r2 = await h.command(path, applicant).expect(201);
  expect(r2.body.result.requestId).not.toBe(r1.body.result.requestId);
  await h
    .command(`${path}/${r2.body.result.requestId}/decline`, applicant)
    .expect(403);
  await h
    .command(`${path}/${r2.body.result.requestId}/decline`, leader)
    .expect(200);
  const own = (
    await h.get(`/api/events/${event}/requests`, applicant).expect(200)
  ).body.items;
  expect(own).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "withdrawn" }),
      expect.objectContaining({ status: "declined" }),
    ]),
  );
  const history = (
    await h
      .get(`/api/events/${event}/teams/${team}/history`, leader)
      .expect(200)
  ).body.items;
  expect(history.map((item: { action: string }) => item.action)).toEqual([
    "TEAM_CREATED",
  ]);
});

test("an unteamed participant requests a team once, with private applicant and leader views", async () => {
  const event = await h.event();
  const leader = await h.person("Request leader");
  const applicant = await h.person("Applicant");
  const outsider = await h.person("Unrelated participant");
  const team = await h.team(event, leader);
  await h.command(`/api/events/${event}/enroll`, applicant).expect(201);
  await h.command(`/api/events/${event}/enroll`, outsider).expect(201);
  const path = `/api/events/${event}/teams/${team}/requests`;
  const first = await h.command(path, applicant).expect(201);
  const duplicate = await h.command(path, applicant).expect(200);
  expect(duplicate.body.result.requestId).toBe(first.body.result.requestId);
  const mine = await h
    .get(`/api/events/${event}/requests`, applicant)
    .expect(200);
  expect(mine.body.items).toEqual([
    expect.objectContaining({
      id: first.body.result.requestId,
      status: "pending",
      teamId: team,
    }),
  ]);
  const queue = await h.get(path, leader).expect(200);
  const audit = await h.db
    .collection("audit")
    .findOne({ eventId: event, action: "REQUEST_CREATED" });
  const hint = await h.db.collection("outbox").findOne({ _id: audit!._id });
  expect(hint).toMatchObject({ category: "event", eventId: event });
  expect(hint).not.toHaveProperty("teamId");
  expect(hint).not.toHaveProperty("revision");
  expect(queue.body.items).toEqual([
    expect.objectContaining({ applicantId: applicant.id, status: "pending" }),
  ]);
  expect(JSON.stringify(queue.body)).not.toContain("@example.test");
  await h.get(path, outsider).expect(403);
  const theirs = await h
    .get(`/api/events/${event}/requests`, outsider)
    .expect(200);
  expect(theirs.body.items).toEqual([]);
});

test("unavailable requests explain whether their team was deleted, frozen or admissions closed", async () => {
  for (const reason of [
    "TEAM_DELETED",
    "ROSTER_FROZEN",
    "ADMISSIONS_CLOSED",
  ] as const) {
    const event = await h.event(),
      leader = await h.person(reason),
      p = await h.person("Needs a clear status");
    const team = await h.team(event, leader);
    await h.command(`/api/events/${event}/enroll`, p).expect(201);
    await h
      .command(`/api/events/${event}/teams/${team}/requests`, p)
      .expect(201);
    if (reason === "TEAM_DELETED")
      await h
        .command(`/api/events/${event}/teams/${team}/leave`, leader)
        .expect(200);
    if (reason === "ROSTER_FROZEN")
      await h.db
        .collection("teams")
        .updateOne(
          { eventId: event },
          { $set: { frozen: true }, $inc: { revision: 1 } },
        );
    if (reason === "ADMISSIONS_CLOSED")
      await h.db
        .collection<Event>("events")
        .updateOne(
          { _id: event },
          { $set: { admissionClosesAt: new Date(0) } },
        );
    const own = await h.get(`/api/events/${event}/requests`, p).expect(200);
    expect(own.body.items).toEqual([
      expect.objectContaining({ status: "unavailable", reason }),
    ]);
  }
});

test("acceptance cancels only this event's other requests permanently, even after leave", async () => {
  const event = await h.event();
  const otherEvent = await h.event();
  const a = await h.person("Leader A"),
    b = await h.person("Leader B"),
    c = await h.person("Other event leader");
  const applicant = await h.person("Several requests");
  const ta = await h.team(event, a),
    tb = await h.team(event, b),
    tc = await h.team(otherEvent, c);
  await h.command(`/api/events/${event}/enroll`, applicant).expect(201);
  await h.command(`/api/events/${otherEvent}/enroll`, applicant).expect(201);
  const pa = `/api/events/${event}/teams/${ta}/requests`,
    pb = `/api/events/${event}/teams/${tb}/requests`;
  const ra = await h.command(pa, applicant).expect(201);
  const rb = await h.command(pb, applicant).expect(201);
  await h
    .command(`/api/events/${otherEvent}/teams/${tc}/requests`, applicant)
    .expect(201);
  const accept = `${pa}/${ra.body.result.requestId}/accept`;
  await h.command(accept, applicant).expect(403);
  await h.command(accept, a).expect(201);
  expect((await h.command(pb, applicant)).body.code).toBe("ALREADY_TEAMED");
  expect((await h.get(pb, b).expect(200)).body.items).toEqual([]);
  const own = (
    await h.get(`/api/events/${event}/requests`, applicant).expect(200)
  ).body.items;
  expect(own).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: ra.body.result.requestId,
        status: "accepted",
      }),
      expect.objectContaining({
        id: rb.body.result.requestId,
        status: "cancelled",
      }),
    ]),
  );
  expect(
    (await h.get(`/api/events/${otherEvent}/requests`, applicant).expect(200))
      .body.items[0].status,
  ).toBe("pending");
  await h
    .command(`/api/events/${event}/teams/${ta}/leave`, applicant)
    .expect(200);
  expect((await h.get(pb, b).expect(200)).body.items).toEqual([]);
  const stale = await h
    .command(`${pb}/${rb.body.result.requestId}/accept`, b)
    .expect(409);
  expect(stale.body.code).toBe("REQUEST_CANCELLED");
  const fresh = await h.command(pb, applicant).expect(201);
  expect(fresh.body.result.requestId).not.toBe(rb.body.result.requestId);
});
