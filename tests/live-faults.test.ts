import { once } from "node:events";
import { MongoClient } from "mongodb";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { connectLive } from "./support/live-client.js";

import { faultMongoUri as uri } from "./support/fault-service.js";

test("source failure resets streams and reconnect snapshots recover a write made during the gap", async () => {
  const harness = await createTestHarness({ mongoUri: uri, live: true });
  const control = await new MongoClient(uri, {
    appName: "h4h-live-fault-control",
    serverSelectionTimeoutMS: 3_000,
  }).connect();
  const server = harness.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing HTTP port");
  const eventId = await harness.event();
  const viewer = await harness.person("Gap viewer"),
    leader = await harness.person("Gap leader");
  await harness.command(`/api/events/${eventId}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const stream = await connectLive(
    `http://127.0.0.1:${bound.port}/api/events/${eventId}/live`,
    viewer.cookie,
  );
  try {
    const before = await stream.next("ready");
    await harness.db.command({
      collMod: "outbox",
      validator: { category: { $ne: "control" } },
      validationAction: "error",
    });
    await control.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: {
        failCommands: ["getMore"],
        appName: `${harness.appName}-observer`,
        errorCode: 286,
      },
    });
    expect(await stream.next("reset")).toEqual({ reason: "REFRESH_REQUIRED" });
    await harness.get("/health/ready", viewer).expect(503);
    const created = await harness
      .command(`/api/events/${eventId}/teams`, leader, {
        name: "Created during source gap",
      })
      .expect(201);
    const unavailable = await harness
      .get(`/api/events/${eventId}/board?kind=teams`, viewer)
      .set("X-Read-Frontier", String(before.frontier))
      .expect(503);
    expect(unavailable.headers["x-read-frontier"]).toBeUndefined();
    await harness.db.command({ collMod: "outbox", validator: {} });
    const deadline = performance.now() + 5_000;
    while (!harness.live!.ready && performance.now() < deadline)
      await delay(50);
    expect(harness.live!.ready).toBe(true);
    const reconnect = await connectLive(
      `http://127.0.0.1:${bound.port}/api/events/${eventId}/live`,
      viewer.cookie,
    );
    try {
      expect((await reconnect.next("ready")).generation).not.toBe(
        before.generation,
      );
      const board = await harness
        .get(`/api/events/${eventId}/board?kind=teams`, viewer)
        .set("X-Read-Frontier", String(before.frontier))
        .expect(200);
      expect(board.body.items.map((item: { id: string }) => item.id)).toContain(
        created.body.result.teamId,
      );
    } finally {
      await reconnect.close();
    }
  } finally {
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

test("an uncertain refresh commit fails closed without acknowledging its read frontier", async () => {
  const harness = await createTestHarness({ mongoUri: uri, live: true });
  const control = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 3_000,
  }).connect();
  try {
    const eventId = await harness.event(),
      actor = await harness.person("Uncertain refresh reader");
    await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
    const token = harness.live!.frame(eventId).frontier;
    await control.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 3 },
      data: {
        failCommands: ["commitTransaction"],
        appName: harness.appName,
        errorCode: 50,
        errorLabels: ["UnknownTransactionCommitResult"],
      },
    });
    const unavailable = await harness
      .get(`/api/events/${eventId}/board`, actor)
      .set("X-Read-Frontier", token)
      .expect(503);
    expect(unavailable.body.code).toBe("READ_FRESHNESS_UNAVAILABLE");
    expect(unavailable.headers["x-read-frontier"]).toBeUndefined();
    await control
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode: "off" });
    await harness
      .get(`/api/events/${eventId}/board`, actor)
      .set("X-Read-Frontier", token)
      .expect(200);
  } finally {
    await control
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode: "off" });
    await harness.close();
    await control.close();
  }
});
