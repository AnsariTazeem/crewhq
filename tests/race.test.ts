import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

test("50 distinct eligible participants competing for the last seat yield exactly one persisted admission", async () => {
  const eventId = await harness.event(2);
  const leader = await harness.person("Race leader");
  const teamId = await harness.team(eventId, leader);
  const code = await harness.sharedCode(eventId, teamId, leader);
  const people = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      harness.person(`Contender ${index + 1}`),
    ),
  );
  await Promise.all(
    people.map((person) =>
      harness.command(`/api/events/${eventId}/enroll`, person).expect(201),
    ),
  );
  expect(new Set(people.map((person) => person.id)).size).toBe(50);
  expect(
    await harness.db
      .collection("people")
      .countDocuments({ eventId, teamId: null }),
  ).toBe(50);
  const keys = people.map(() => randomUUID());
  const starts: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts = people.map(async (person, index) => {
    await barrier;
    starts.push(performance.now());
    return harness.command(
      `/api/events/${eventId}/invitations/redeem`,
      person,
      { code },
      keys[index]!,
    );
  });
  release();
  const responses = await Promise.all(attempts);
  const winners = responses.filter((response) => response.status === 201);
  const full = responses.filter(
    (response) => response.status === 409 && response.body.code === "TEAM_FULL",
  );
  expect(winners).toHaveLength(1);
  expect(full).toHaveLength(49);
  const team = await harness.db
    .collection<Team>("teams")
    .findOne({ _id: teamId });
  const memberships = await harness.db
    .collection<Person>("people")
    .find({ eventId, teamId })
    .toArray();
  expect(team!.members).toHaveLength(2);
  expect(new Set(team!.members).size).toBe(2);
  expect(memberships.map((person) => person.userId).sort()).toEqual(
    [...team!.members].sort(),
  );
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, teamId, action: "MEMBER_JOINED" }),
  ).toBe(1);
  const receipts = await harness.db
    .collection("operations")
    .find({ eventId, key: { $in: keys } })
    .toArray();
  expect(receipts).toHaveLength(50);
  expect(
    receipts.filter((receipt) => receipt.decision?.outcome === "committed"),
  ).toHaveLength(1);
  expect(
    receipts.filter((receipt) => receipt.decision?.code === "TEAM_FULL"),
  ).toHaveLength(49);
  const evidence = {
    timestamp: new Date().toISOString(),
    node: process.version,
    contenders: 50,
    successfulAdmissions: winners.length,
    knownCapacityRejections: full.length,
    finalRoster: team!.members.length,
    matchingPersonPointers: memberships.length,
    joinAuditRecords: 1,
    terminalReceipts: receipts.length,
    clientDispatchSpreadMs: Math.max(...starts) - Math.min(...starts),
    scope:
      "Local real MongoDB replica set; client-side release barrier; actual authenticated HTTP. Not a hosted capacity/latency result.",
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/last-seat-race.json",
    JSON.stringify(evidence, null, 2),
  );
}, 45_000);
