import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import type { Person, Team } from "../src/membership.js";
import { randomUUID } from "node:crypto";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

test("an authenticated participant can enroll in a configured event", async () => {
  const eventId = await harness.event();
  const person = await harness.person("Lin");
  const response = await harness.command(
    `/api/events/${eventId}/enroll`,
    person,
  );
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({
    outcome: "committed",
    result: { eventId, participantId: person.id },
  });
});

test("an enrolled participant creates an incomplete team with themselves as its leader", async () => {
  const eventId = await harness.event(4, 3);
  const person = await harness.person("Team creator");
  await harness.command(`/api/events/${eventId}/enroll`, person).expect(201);
  const response = await harness.command(
    `/api/events/${eventId}/teams`,
    person,
    { name: "Team Apex" },
  );
  expect(response.status).toBe(201);
  const team = await harness.db.collection("teams").findOne({ eventId });
  expect(team).toMatchObject({
    name: "Team Apex",
    leaderId: person.id,
    members: [person.id],
    minSize: 3,
    maxSize: 4,
    state: "active",
  });
  expect(response.body.result.teamId).toBe(team!._id);
});

test("the leader issues an expiring shared code without placing plaintext in its operation receipt", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Invitation leader");
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const creation = await harness
    .command(`/api/events/${eventId}/teams`, leader, { name: "Invite team" })
    .expect(201);
  const teamId = creation.body.result.teamId as string;
  const issued = await harness.command(
    `/api/events/${eventId}/teams/${teamId}/invitations`,
    leader,
    { kind: "shared" },
  );
  expect(issued.status).toBe(201);
  const revealed = await harness
    .get(
      `/api/events/${eventId}/teams/${teamId}/invitations/${issued.body.result.invitationId}`,
      leader,
    )
    .expect(200);
  expect(revealed.body.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(new Date(revealed.body.expiresAt).getTime()).toBeGreaterThan(
    Date.now(),
  );
  const receipt = await harness.db
    .collection("operations")
    .findOne({ key: issued.body.operationKey });
  expect(JSON.stringify(receipt)).not.toContain(revealed.body.code);
});

test("an invitation directly admits an eligible person and persists exclusive membership with audit", async () => {
  const eventId = await harness.event(2);
  const leader = await harness.person("Leader");
  const member = await harness.person("Invited person");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, member).expect(201);
  const response = await harness.command(
    `/api/events/${eventId}/invitations/redeem`,
    member,
    { code },
  );
  expect(response.status).toBe(201);
  const team = await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId });
  const person = await harness.db
    .collection<Person>("people")
    .findOne({ eventId, userId: member.id });
  expect(team!.members).toEqual([leader.id, member.id]);
  expect(person).toMatchObject({ teamId, membershipEpoch: 1 });
  expect(
    await harness.db.collection("audit").countDocuments({
      eventId,
      teamId,
      action: "MEMBER_JOINED",
      actorId: member.id,
    }),
  ).toBe(1);
});

test("a final departure deletes the operational team and an old create retry cannot recreate it", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("Final member");
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const key = randomUUID();
  const first = await harness
    .command(
      `/api/events/${eventId}/teams`,
      leader,
      { name: "Historical team" },
      key,
    )
    .expect(201);
  const teamId = first.body.result.teamId as string;
  const departed = await harness.command(
    `/api/events/${eventId}/teams/${teamId}/leave`,
    leader,
  );
  expect(departed.status).toBe(200);
  const retried = await harness
    .command(
      `/api/events/${eventId}/teams`,
      leader,
      { name: "Historical team" },
      key,
    )
    .expect(201);
  expect(retried.body).toEqual(first.body);
  expect(
    await harness.db
      .collection("teams")
      .countDocuments({ eventId, state: "active" }),
  ).toBe(0);
  expect(
    await harness.db.collection<Team>("teams").findOne({ _id: teamId }),
  ).toMatchObject({ state: "deleted", members: [], leaderId: null });
  expect(
    await harness.db
      .collection<Person>("people")
      .findOne({ eventId, userId: leader.id }),
  ).toMatchObject({ teamId: null, membershipEpoch: 2 });
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, teamId, action: "TEAM_DELETED" }),
  ).toBe(1);
});

test("current members see their team and basic history while event outsiders cannot read that history", async () => {
  const eventId = await harness.event();
  const leader = await harness.person("History leader");
  const outsider = await harness.person("Event outsider");
  const teamId = await harness.team(eventId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, outsider).expect(201);
  const mine = await harness.get(`/api/events/${eventId}/me`, leader);
  expect(mine.status).toBe(200);
  expect(mine.body.team).toMatchObject({
    id: teamId,
    memberCount: 1,
    sizeEligible: false,
    members: [leader.id],
  });
  const history = await harness
    .get(`/api/events/${eventId}/teams/${teamId}/history`, leader)
    .expect(200);
  expect(history.body.items).toEqual([
    expect.objectContaining({ action: "TEAM_CREATED", actorId: leader.id }),
  ]);
  await harness
    .get(`/api/events/${eventId}/teams/${teamId}/history`, outsider)
    .expect(403);
});

test("leader departure requires an explicit current successor and preserves the existing invitation", async () => {
  const eventId = await harness.event(3);
  const leader = await harness.person("Outgoing leader");
  const successor = await harness.person("Explicit successor");
  const newcomer = await harness.person("Later invited member");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, successor).expect(201);
  await harness
    .command(`/api/events/${eventId}/invitations/redeem`, successor, { code })
    .expect(201);
  const missing = await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, leader)
    .expect(409);
  expect(missing.body.code).toBe("SUCCESSOR_REQUIRED");
  const invalid = await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, leader, {
      successorId: newcomer.id,
    })
    .expect(409);
  expect(invalid.body.code).toBe("SUCCESSOR_CHANGED");
  const invitation = await harness.db
    .collection("invitations")
    .findOne({ eventId, teamId });
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, leader, {
      successorId: successor.id,
    })
    .expect(200);
  const team = await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId });
  expect(team).toMatchObject({
    leaderId: successor.id,
    members: [successor.id],
  });
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/invitations`, leader, {})
    .expect(403);
  await harness
    .get(
      `/api/events/${eventId}/teams/${teamId}/invitations/${invitation!._id}`,
      leader,
    )
    .expect(403);
  await harness.command(`/api/events/${eventId}/enroll`, newcomer).expect(201);
  await harness
    .command(`/api/events/${eventId}/invitations/redeem`, newcomer, { code })
    .expect(201);
  const retained = await harness.db
    .collection("invitations")
    .findOne({ eventId, teamId });
  expect(retained!.expiresAt).toEqual(invitation!.expiresAt);
});

test("an ordinary member can leave even when that makes the team incomplete", async () => {
  const eventId = await harness.event(4, 3);
  const leader = await harness.person("Minimum-size leader");
  const first = await harness.person("Departing ordinary member");
  const second = await harness.person("Remaining ordinary member");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  for (const person of [first, second]) {
    await harness.command(`/api/events/${eventId}/enroll`, person).expect(201);
    await harness
      .command(`/api/events/${eventId}/invitations/redeem`, person, { code })
      .expect(201);
  }
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/leave`, first)
    .expect(200);
  const current = await harness
    .get(`/api/events/${eventId}/me`, leader)
    .expect(200);
  expect(current.body.team).toMatchObject({
    memberCount: 2,
    minSize: 3,
    sizeEligible: false,
    leaderId: leader.id,
  });
});

test("membership exclusivity is per event rather than global", async () => {
  const firstEvent = await harness.event();
  const secondEvent = await harness.event();
  const actor = await harness.person("Multi-event participant");
  const teamA = await harness.team(firstEvent, actor, "First event");
  const teamB = await harness.team(secondEvent, actor, "Second event");
  expect(teamA).not.toBe(teamB);
  expect(
    await harness.db
      .collection("people")
      .countDocuments({ userId: actor.id, teamId: { $ne: null } }),
  ).toBe(2);
});
