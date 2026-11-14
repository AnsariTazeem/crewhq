import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { createHash, randomUUID } from "node:crypto";

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h?.close();
});

test("current leaders may explicitly revoke invitations without opening a removed person's return", async () => {
  const event = await h.event();
  const leader = await h.person("Revoking leader"),
    member = await h.person("Revoked return"),
    outsider = await h.person("Cannot revoke");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`;
  const code = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, member).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  await h.command(`${base}/members/${member.id}/remove`, leader).expect(200);
  const issued = await h
    .command(`${base}/invitations`, leader, {
      kind: "personal",
      subjectId: member.id,
    })
    .expect(201);
  const id = issued.body.result.invitationId;
  const personal = (
    await h.get(`${base}/invitations/${id}`, leader).expect(200)
  ).body.code;
  const path = `${base}/invitations/${id}/revoke`,
    key = randomUUID();
  await h.command(path, outsider).expect(403);
  await h.command(path, leader, {}, key).expect(200);
  await h.command(path, leader, {}, key).expect(200);
  await h.get(`${base}/invitations/${id}`, leader).expect(404);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, {
      code: personal,
    })
    .expect(404);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(403);
  expect(
    await h.db
      .collection("restrictions")
      .findOne({ eventId: event, userId: member.id }),
  ).toMatchObject({ restricted: true, generation: 1 });
  expect(
    await h.db.collection("audit").countDocuments({
      eventId: event,
      action: "PERSONAL_INVITATION_REVOKED",
    }),
  ).toBe(1);
});

test("personal permission is bound to the removed person, survives a full-team rejection, and cannot bypass a later removal", async () => {
  const event = await h.event(2);
  const leader = await h.person("Return leader"),
    member = await h.person("Return subject"),
    stranger = await h.person("Not the subject");
  const team = await h.team(event, leader);
  const shared = await h.sharedCode(event, team, leader);
  for (const p of [member, stranger])
    await h.command(`/api/events/${event}/enroll`, p).expect(201);
  const redeem = `/api/events/${event}/invitations/redeem`,
    base = `/api/events/${event}/teams/${team}`;
  await h.command(redeem, member, { code: shared }).expect(201);
  await h.command(`${base}/members/${member.id}/remove`, leader).expect(200);
  const grant = await h
    .command(`${base}/invitations`, leader, {
      kind: "personal",
      subjectId: member.id,
    })
    .expect(201);
  const reveal = await h
    .get(`${base}/invitations/${grant.body.result.invitationId}`, leader)
    .expect(200);
  const personal = reveal.body.code;
  const history = (await h.get(`${base}/history`, leader).expect(200)).body
    .items;
  expect(
    history.some(
      (item: { action: string }) =>
        item.action === "PERSONAL_INVITATION_ISSUED",
    ),
  ).toBe(false);
  const audit = await h.db
    .collection("audit")
    .findOne({ eventId: event, action: "PERSONAL_INVITATION_ISSUED" });
  expect(
    await h.db.collection("outbox").findOne({ _id: audit!._id }),
  ).not.toHaveProperty("teamId");
  await h.command(redeem, stranger, { code: personal }).expect(403);
  await h.command(redeem, stranger, { code: shared }).expect(201);
  expect(
    (await h.command(redeem, member, { code: personal }).expect(409)).body.code,
  ).toBe("TEAM_FULL");
  await h.command(`${base}/leave`, stranger).expect(200);
  await h.command(redeem, member, { code: personal }).expect(201);
  expect(
    await h.db
      .collection("restrictions")
      .findOne({ eventId: event, teamId: team, userId: member.id }),
  ).toMatchObject({ restricted: false, generation: 1 });
  await h.command(`${base}/members/${member.id}/remove`, leader).expect(200);
  // Defense in depth: even if an old consumed row remains unrevoked, generation fencing rejects it.
  await h.db.collection("invitations").updateOne(
    {
      eventId: event,
      digest: createHash("sha256").update(personal).digest("hex"),
    },
    { $set: { revoked: false } },
  );
  expect((await h.command(redeem, member, { code: personal })).status).not.toBe(
    201,
  );
  await h.command(redeem, member, { code: shared }).expect(403);
  const fresh = await h
    .command(`${base}/invitations`, leader, {
      kind: "personal",
      subjectId: member.id,
    })
    .expect(201);
  const freshCode = (
    await h
      .get(`${base}/invitations/${fresh.body.result.invitationId}`, leader)
      .expect(200)
  ).body.code;
  expect(freshCode).not.toBe(personal);
  await h.command(redeem, member, { code: freshCode }).expect(201);
  await h.command(`${base}/leave`, member).expect(200);
  await h.command(redeem, member, { code: shared }).expect(201);
  expect(
    await h.db
      .collection("restrictions")
      .findOne({ eventId: event, teamId: team, userId: member.id }),
  ).toMatchObject({ restricted: false, generation: 2 });
});

test("a failed restriction write cannot partially remove a member", async () => {
  const event = await h.event();
  const leader = await h.person("Atomic removal leader"),
    member = await h.person("Atomic removal member");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`;
  const code = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, member).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  const key = randomUUID(),
    path = `${base}/members/${member.id}/remove`;
  const outboxBefore = await h.db
    .collection("outbox")
    .countDocuments({ eventId: event });
  await h.db.command({
    collMod: "restrictions",
    validator: { restricted: false },
    validationAction: "error",
  });
  try {
    await h.command(path, leader, {}, key).expect(503);
    expect(
      await h.db
        .collection("people")
        .findOne({ eventId: event, userId: member.id }),
    ).toMatchObject({ teamId: team, membershipEpoch: 1 });
    expect((await h.get(base, leader).expect(200)).body.members).toContain(
      member.id,
    );
    expect(
      await h.db.collection("restrictions").countDocuments({ eventId: event }),
    ).toBe(0);
    expect(
      await h.db
        .collection("audit")
        .countDocuments({ eventId: event, action: "MEMBER_REMOVED" }),
    ).toBe(0);
    expect(
      await h.db
        .collection("operations")
        .countDocuments({ eventId: event, key }),
    ).toBe(0);
    expect(
      await h.db.collection("outbox").countDocuments({ eventId: event }),
    ).toBe(outboxBefore);
  } finally {
    await h.db.command({ collMod: "restrictions", validator: {} });
  }
  await h.command(path, leader, {}, key).expect(200);
});

test("failed personal-permission consumption rolls back admission, audit, receipt and outbox", async () => {
  const event = await h.event();
  const leader = await h.person("Atomic return leader"),
    member = await h.person("Atomic return member");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`,
    redeem = `/api/events/${event}/invitations/redeem`;
  const shared = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, member).expect(201);
  await h.command(redeem, member, { code: shared }).expect(201);
  await h.command(`${base}/members/${member.id}/remove`, leader).expect(200);
  const issued = await h
    .command(`${base}/invitations`, leader, {
      kind: "personal",
      subjectId: member.id,
    })
    .expect(201);
  const code = (
    await h
      .get(`${base}/invitations/${issued.body.result.invitationId}`, leader)
      .expect(200)
  ).body.code;
  const key = randomUUID(),
    outboxBefore = await h.db
      .collection("outbox")
      .countDocuments({ eventId: event });
  await h.db.command({
    collMod: "restrictions",
    validator: { restricted: true },
    validationAction: "error",
  });
  try {
    await h.command(redeem, member, { code }, key).expect(503);
    expect(
      await h.db
        .collection("people")
        .findOne({ eventId: event, userId: member.id }),
    ).toMatchObject({ teamId: null, membershipEpoch: 2 });
    expect((await h.get(base, leader).expect(200)).body.members).not.toContain(
      member.id,
    );
    expect(
      await h.db
        .collection("restrictions")
        .findOne({ eventId: event, userId: member.id }),
    ).toMatchObject({
      restricted: true,
      generation: 1,
      grantId: issued.body.result.invitationId,
    });
    expect(
      await h.db
        .collection("invitations")
        .findOne({ _id: issued.body.result.invitationId }),
    ).toMatchObject({ revoked: false });
    expect(
      await h.db
        .collection("audit")
        .countDocuments({ eventId: event, action: "MEMBER_JOINED" }),
    ).toBe(1);
    expect(
      await h.db
        .collection("operations")
        .countDocuments({ eventId: event, key }),
    ).toBe(0);
    expect(
      await h.db.collection("outbox").countDocuments({ eventId: event }),
    ).toBe(outboxBefore);
  } finally {
    await h.db.command({ collMod: "restrictions", validator: {} });
  }
  await h.command(redeem, member, { code }, key).expect(201);
});

test("a frozen roster rejects removal and issuance, and leaders must leave through succession", async () => {
  const event = await h.event();
  const leader = await h.person("Frozen leader"),
    member = await h.person("Frozen member");
  const team = await h.team(event, leader),
    base = `/api/events/${event}/teams/${team}`;
  const code = await h.sharedCode(event, team, leader);
  await h.command(`/api/events/${event}/enroll`, member).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  expect(
    (await h.command(`${base}/members/${leader.id}/remove`, leader).expect(409))
      .body.code,
  ).toBe("USE_LEAVE_FOR_SELF");
  await h.db
    .collection("teams")
    .updateOne(
      { eventId: event },
      { $set: { frozen: true }, $inc: { revision: 1 } },
    );
  expect(
    (await h.command(`${base}/members/${member.id}/remove`, leader).expect(409))
      .body.code,
  ).toBe("ROSTER_FROZEN");
  expect(
    (
      await h
        .command(`${base}/invitations`, leader, {
          kind: "personal",
          subjectId: member.id,
        })
        .expect(409)
    ).body.code,
  ).toBe("ROSTER_FROZEN");
});

test("removal ends membership and blocks shared-code and ordinary-request return without changing other invitations", async () => {
  const event = await h.event(3);
  const leader = await h.person("Removing leader"),
    member = await h.person("Removed member"),
    other = await h.person("Other invitee");
  const team = await h.team(event, leader);
  const code = await h.sharedCode(event, team, leader);
  for (const p of [member, other])
    await h.command(`/api/events/${event}/enroll`, p).expect(201);
  await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(201);
  const remove = `/api/events/${event}/teams/${team}/members/${member.id}/remove`;
  await h.command(remove, member).expect(403);
  await h.command(remove, leader).expect(200);
  expect(
    (await h.get(`/api/events/${event}/me`, member).expect(200)).body.team,
  ).toBeNull();
  const denied = await h
    .command(`/api/events/${event}/invitations/redeem`, member, { code })
    .expect(403);
  expect(denied.body.code).toBe("PERSONAL_REINVITE_REQUIRED");
  const request = await h
    .command(`/api/events/${event}/teams/${team}/requests`, member)
    .expect(403);
  expect(request.body.code).toBe("PERSONAL_REINVITE_REQUIRED");
  await h
    .command(`/api/events/${event}/invitations/redeem`, other, { code })
    .expect(201);
  expect(await h.sharedCode(event, team, leader)).toBe(code);
  const restriction = await h.db
    .collection("restrictions")
    .findOne({ eventId: event, teamId: team, userId: member.id });
  expect(restriction).toMatchObject({ restricted: true, generation: 1 });
  expect(
    await h.db.collection("audit").countDocuments({
      eventId: event,
      teamId: team,
      action: "MEMBER_REMOVED",
    }),
  ).toBe(1);
});
