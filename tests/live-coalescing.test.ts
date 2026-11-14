import { once } from "node:events";
import { MongoClient, type CommandStartedEvent } from "mongodb";
import { expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { connectLive } from "./support/live-client.js";

import { faultMongoUri as uri } from "./support/fault-service.js";

test("overlapping refreshes share a public projection while reset snapshots bypass sharing", async () => {
  const harness = await createTestHarness({
    mongoUri: uri,
    live: true,
    monitorCommands: true,
  });
  const control = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 3_000,
  }).connect();
  const server = harness.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing fixture port");
  const eventId = await harness.event(),
    actor = await harness.person("Shared refresh reader");
  const teamId = await harness.team(eventId, actor);
  const outsider = await harness.person("Unenrolled shared reader");
  const stream = await connectLive(
    `http://127.0.0.1:${bound.port}/api/events/${eventId}/live`,
    actor.cookie,
  );
  const capture: string[] = [];
  const listen = (event: CommandStartedEvent) => {
    if (event.command.find === "teams") capture.push("teams");
  };
  try {
    const ready = await stream.next("ready");
    await control.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: {
        failCommands: ["commitTransaction"],
        appName: harness.appName,
        blockConnection: true,
        blockTimeMS: 500,
      },
    });
    harness.client.on("commandStarted", listen);
    const requests = Promise.all(
      Array.from({ length: 8 }, () =>
        harness
          .get(`/api/events/${eventId}/board?kind=teams`, actor)
          .set("X-Read-Frontier", String(ready.frontier))
          .set("X-Snapshot-Mode", "refresh")
          .expect(200),
      ),
    );
    const [results, denied] = await Promise.all([
      requests,
      harness
        .get(`/api/events/${eventId}/board?kind=teams`, outsider)
        .set("X-Read-Frontier", String(ready.frontier))
        .set("X-Snapshot-Mode", "refresh")
        .expect(403),
    ]);
    expect(denied.headers["x-read-frontier"]).toBeUndefined();
    expect(capture).toHaveLength(1);
    for (const result of results) expect(result.body.items[0].id).toBe(teamId);
    capture.length = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        harness
          .get(`/api/events/${eventId}/board?kind=teams`, actor)
          .set("X-Read-Frontier", String(ready.frontier))
          .set("X-Snapshot-Mode", "reset")
          .expect(200),
      ),
    );
    expect(capture).toHaveLength(3);
  } finally {
    harness.client.off("commandStarted", listen);
    await control
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode: "off" });
    await stream.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    await control.close();
  }
});

test("a newer hint cannot reuse an older in-flight projection", async () => {
  const harness = await createTestHarness({
    mongoUri: uri,
    live: true,
    monitorCommands: true,
  });
  const control = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 3_000,
  }).connect();
  const server = harness.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing fixture port");
  const eventId = await harness.event();
  const viewer = await harness.person("Overlapping snapshot viewer"),
    leader = await harness.person("Later commit leader");
  await harness.command(`/api/events/${eventId}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const stream = await connectLive(
    `http://127.0.0.1:${bound.port}/api/events/${eventId}/live`,
    viewer.cookie,
  );
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listen = (event: CommandStartedEvent) => {
    if (event.command.commitTransaction) release();
  };
  try {
    const ready = await stream.next("ready");
    await control.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: {
        failCommands: ["commitTransaction"],
        appName: harness.appName,
        blockConnection: true,
        blockTimeMS: 1_000,
      },
    });
    harness.client.on("commandStarted", listen);
    const earlier = harness
      .get(`/api/events/${eventId}/board?kind=teams`, viewer)
      .set("X-Read-Frontier", String(ready.frontier))
      .set("X-Snapshot-Mode", "refresh")
      .expect(200)
      .then((result) => result);
    await started;
    const created = await harness
      .command(`/api/events/${eventId}/teams`, leader, {
        name: "Later committed team",
      })
      .expect(201);
    const hint = await stream.next("refresh");
    const newer = await harness
      .get(`/api/events/${eventId}/board?kind=teams`, viewer)
      .set("X-Read-Frontier", String(hint.frontier))
      .set("X-Snapshot-Mode", "refresh")
      .expect(200);
    expect(newer.body.items.map((item: { id: string }) => item.id)).toContain(
      created.body.result.teamId,
    );
    expect((await earlier).body.items).toEqual([]);
  } finally {
    harness.client.off("commandStarted", listen);
    await control
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode: "off" });
    await stream.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    await control.close();
  }
});
