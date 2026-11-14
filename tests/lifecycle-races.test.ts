import { afterAll, beforeAll, expect, test } from "vitest";
import type { Person, Team } from "../src/membership.js";
import { createTestHarness } from "./support/harness.js";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

test("final departure racing admission either deletes first or requires an explicit successor", async () => {
  const eventId = await harness.event(2);
  const leader = await harness.person("Final departing leader");
  const actor = await harness.person("Concurrent newcomer");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const [leave, join] = await Promise.all([
    harness.command(`/api/events/${eventId}/teams/${teamId}/leave`, leader),
    harness.command(`/api/events/${eventId}/invitations/redeem`, actor, {
      code,
    }),
  ]);
  const team = (await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId }))!;
  if (team.state === "deleted") {
    expect([leave.status, join.status]).toEqual([200, 404]);
    expect(team.members).toEqual([]);
  } else {
    expect([leave.status, join.status]).toEqual([409, 201]);
    expect(leave.body.code).toBe("SUCCESSOR_REQUIRED");
    expect(team.leaderId).toBe(leader.id);
    expect(new Set(team.members)).toEqual(new Set([leader.id, actor.id]));
  }
  const pointers = await harness.db
    .collection<Person>("people")
    .find({ eventId, teamId })
    .toArray();
  expect(pointers.map((person) => person.userId).sort()).toEqual(
    [...team.members].sort(),
  );
});

test("a nominated successor racing their own departure never creates a leaderless active team", async () => {
  const eventId = await harness.event(3);
  const leader = await harness.person("Handover leader");
  const nominee = await harness.person("Departing nominee");
  const remaining = await harness.person("Remaining member");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  for (const actor of [nominee, remaining]) {
    await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
    await harness
      .command(`/api/events/${eventId}/invitations/redeem`, actor, { code })
      .expect(201);
  }
  const [handover, departure] = await Promise.all([
    harness.command(`/api/events/${eventId}/teams/${teamId}/leave`, leader, {
      successorId: nominee.id,
    }),
    harness.command(`/api/events/${eventId}/teams/${teamId}/leave`, nominee),
  ]);
  const team = (await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId }))!;
  expect(team.state).toBe("active");
  expect(team.members).toHaveLength(2);
  expect(team.members).toContain(team.leaderId);
  if (handover.status === 200) {
    expect(departure.status).toBe(409);
    expect(departure.body.code).toBe("SUCCESSOR_REQUIRED");
    expect(team.leaderId).toBe(nominee.id);
  } else {
    expect(handover.status).toBe(409);
    expect(handover.body.code).toBe("SUCCESSOR_CHANGED");
    expect(departure.status).toBe(200);
    expect(team.leaderId).toBe(leader.id);
  }
});

test("a simulated eligibility-checked submission freeze racing departure preserves the valid ordering", async () => {
  const eventId = await harness.event(3, 2);
  const leader = await harness.person("Freeze race leader");
  const member = await harness.person("Freeze race member");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, member).expect(201);
  await harness
    .command(`/api/events/${eventId}/invitations/redeem`, member, { code })
    .expect(201);
  // Only the external team-guard primitive is simulated; no submission API is claimed.
  const [freeze, leave] = await Promise.all([
    harness.db.collection<Team>("teams").updateOne(
      {
        _id: teamId,
        frozen: false,
        $expr: { $gte: [{ $size: "$members" }, "$minSize"] },
      },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    ),
    harness.command(`/api/events/${eventId}/teams/${teamId}/leave`, member),
  ]);
  const team = (await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId }))!;
  if (freeze.modifiedCount === 1) {
    expect(leave.status).toBe(409);
    expect(leave.body.code).toBe("ROSTER_FROZEN");
    expect(team.members).toHaveLength(2);
  } else {
    expect(leave.status).toBe(200);
    expect(team.frozen).toBe(false);
    expect(team.members).toEqual([leader.id]);
  }
});
