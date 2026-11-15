import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestHarness } from "./support/harness.js";

let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness();
});
afterAll(async () => {
  await h.close();
});

it("provides authenticated event rules before enrollment without participant data", async () => {
  const eventId = await h.event(5, 3);
  const person = await h.person("Participant");
  const response = await h.get(`/api/events/${eventId}`, person).expect(200);
  expect(response.body).toMatchObject({
    id: eventId,
    name: "Test event",
    minSize: 3,
    maxSize: 5,
    admissionsOpen: true,
  });
  expect(Object.keys(response.body).sort()).toEqual([
    "admissionClosesAt",
    "admissionsOpen",
    "endsAt",
    "id",
    "maxSize",
    "minSize",
    "name",
    "startsAt",
  ]);
});

it("shows roster display names only to current team members", async () => {
  const eventId = await h.event();
  const leader = await h.person("Team Leader");
  const outsider = await h.person("Visitor");
  const teamId = await h.team(eventId, leader);
  await h.command(`/api/events/${eventId}/enroll`, outsider).expect(201);
  const own = await h.get(`/api/events/${eventId}/me`, leader).expect(200);
  expect(own.body.team.roster).toEqual([
    { id: leader.id, displayName: "Team Leader" },
  ]);
  const other = await h
    .get(`/api/events/${eventId}/teams/${teamId}`, outsider)
    .expect(200);
  expect(other.body).not.toHaveProperty("roster");
  expect(other.body).not.toHaveProperty("members");
});

it("rejects a browser command and receipt lookup bound to a different signed-in actor", async () => {
  const eventId = await h.event();
  const a = await h.person("Original actor");
  const b = await h.person("New actor");
  await h.command(`/api/events/${eventId}/enroll`, b).expect(201);
  const key = crypto.randomUUID();
  await h
    .command(
      `/api/events/${eventId}/teams`,
      b,
      { name: "Must not be created" },
      key,
    )
    .set("X-Actor-Id", a.id)
    .expect(409);
  const mine = await h.get(`/api/events/${eventId}/me`, b).expect(200);
  expect(mine.body.team).toBeNull();
  const lookup = await h
    .get(`/api/events/${eventId}/operations/${key}`, b)
    .set("X-Actor-Id", a.id)
    .expect(409);
  expect(lookup.body.code).toBe("ACTOR_CHANGED");
});
