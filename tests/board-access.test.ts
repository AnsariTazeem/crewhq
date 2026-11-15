import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
let h: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  h = await createTestHarness({ monitorCommands: true });
});
afterAll(async () => {
  await h.close();
});

test("board reads retain both linearizable guards and isolate event enrollment", async () => {
  const enrolled = await h.person("Board participant"),
    outsider = await h.person("Board outsider");
  const event = await h.event(),
    otherEvent = await h.event();
  await h.command(`/api/events/${event}/enroll`, enrolled).expect(201);
  const guardedCollections: string[] = [];
  const observe = (event: {
    commandName: string;
    command: Record<string, unknown>;
  }) => {
    const concern = event.command.readConcern as { level?: string } | undefined;
    if (event.commandName === "find" && concern?.level === "linearizable")
      guardedCollections.push(String(event.command.find));
  };
  h.client.on("commandStarted", observe);
  await h.get(`/api/events/${event}/board`, enrolled).expect(200);
  h.client.off("commandStarted", observe);
  expect(guardedCollections).toContain("session");
  expect(guardedCollections).toContain("people");
  await h.get(`/api/events/${otherEvent}/board`, enrolled).expect(403);
  await h.get(`/api/events/${event}/board`, outsider).expect(403);
  await h.get(`/api/events/${event}/board?kind=invalid`, outsider).expect(400);
  await h
    .get(`/api/events/${event}/board`, outsider)
    .set("X-Snapshot-Mode", "invalid")
    .expect(400);
  await h
    .get(`/api/events/${event}/board`, outsider)
    .set("X-Snapshot-Mode", "refresh")
    .expect(400);
  await h
    .get(`/api/events/${event}/board`, outsider)
    .set("X-Actor-Id", enrolled.id)
    .expect(409);
  await h.db
    .collection("session")
    .deleteOne({ _id: new ObjectId(enrolled.sessionId) });
  await h.get(`/api/events/${event}/board`, enrolled).expect(401);
});
