import { once } from "node:events";
import { createServer } from "node:http";
import request from "supertest";
import { afterEach, expect, test } from "vitest";
import { createTestHarness, origin } from "./support/harness.js";
import { connectLive } from "./support/live-client.js";
import { createApp } from "../src/app.js";
import { LiveSource } from "../src/live-source.js";
import type { Event } from "../src/membership.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fromNodeHeaders } from "better-auth/node";
import { openLive } from "../src/live-http.js";

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("a source that cannot observe its startup marker stays unavailable", async () => {
  harness = await createTestHarness();
  const eventId = await harness.event();
  const actor = await harness.person("Startup observer");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db.command({
    collMod: "outbox",
    validator: { category: { $ne: "control" } },
    validationAction: "error",
  });
  const source = new LiveSource(harness.db, harness.invitationKey);
  const app = createApp({
    db: harness.db,
    client: harness.client,
    auth: harness.auth,
    origin,
    invitationKey: harness.invitationKey,
    live: source,
  });
  try {
    await expect(source.start()).rejects.toThrow();
    await request(app).get("/health/ready").expect(503);
    await request(app)
      .get(`/api/events/${eventId}/live`)
      .set("Cookie", actor.cookie)
      .expect(503);
    const board = await request(app)
      .get(`/api/events/${eventId}/board`)
      .set("Cookie", actor.cookie)
      .expect(503);
    expect(board.headers["x-read-frontier"]).toBeUndefined();
  } finally {
    await source.close();
  }
});

test("a different API observer accepts a signed minimum from an earlier generation", async () => {
  harness = await createTestHarness({ live: true });
  const eventId = await harness.event();
  const actor = await harness.person("Cross-process refresh");
  const teamId = await harness.team(eventId, actor);
  const old = harness.live!.frame(eventId);
  const peer = new LiveSource(harness.db, harness.invitationKey);
  try {
    await peer.start();
    expect(peer.frame(eventId).generation).not.toBe(old.generation);
    const app = createApp({
      db: harness.db,
      client: harness.client,
      auth: harness.auth,
      origin,
      invitationKey: harness.invitationKey,
      live: peer,
    });
    const board = await request(app)
      .get(`/api/events/${eventId}/board?kind=teams`)
      .set("Cookie", actor.cookie)
      .set("X-Read-Frontier", old.frontier)
      .expect(200);
    expect(board.body.items.map((item: { id: string }) => item.id)).toContain(
      teamId,
    );
    expect(board.headers["x-read-frontier"]).toEqual(expect.any(String));
  } finally {
    await peer.close();
  }
});

test("response backpressure closes the connection and releases its subscription", async () => {
  harness = await createTestHarness({ live: true, diagnostics: true });
  const eventId = await harness.event();
  const actor = await harness.person("Slow transport");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const server = createServer({ highWaterMark: 1 }, harness.app).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/events/${eventId}/live`,
      { headers: { Cookie: actor.cookie }, signal: controller.signal },
    );
    const body = await response.text();
    expect(body).toContain("event: reset");
    expect(harness.live!.connections).toBe(0);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live projection reads retain private-view authorization and ranking behavior", async () => {
  harness = await createTestHarness({ live: true, diagnostics: true });
  const eventId = await harness.event();
  await harness.db.collection<Event>("events").updateOne(
    { _id: eventId },
    {
      $set: {
        startsAt: new Date("2030-01-02"),
        endsAt: new Date("2030-01-03"),
      },
    },
  );
  const leader = await harness.person("Live projection leader");
  const applicant = await harness.person("Private applicant");
  const teamId = await harness.team(eventId, leader);
  await harness.command(`/api/events/${eventId}/enroll`, applicant).expect(201);
  await harness
    .command(`/api/events/${eventId}/teams/${teamId}/requests`, applicant)
    .expect(201);
  const token = harness.live!.frame(eventId).frontier;
  for (const route of [
    "me",
    "profile",
    `teams/${teamId}`,
    `teams/${teamId}/history`,
    `teams/${teamId}/requests`,
    "requests",
    "teammate-suggestions",
  ]) {
    const result = await harness
      .get(`/api/events/${eventId}/${route}`, leader)
      .set("X-Read-Frontier", token)
      .expect(200);
    expect(result.headers["x-read-frontier"]).toEqual(expect.any(String));
    expect(JSON.stringify(result.body)).not.toContain("@example.test");
  }
  const denied = await harness
    .get(`/api/events/${eventId}/teams/${teamId}/requests`, applicant)
    .set("X-Read-Frontier", token)
    .expect(403);
  expect(denied.headers["x-read-frontier"]).toBeUndefined();
});

test("heartbeat comments survive sustained refreshes and an overlapping authorization check", async () => {
  harness = await createTestHarness({ live: true });
  const current = harness;
  const eventId = await current.event(),
    actor = await current.person("Busy heartbeat viewer");
  await current.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const app = express();
  app.get("/live", async (incoming, outgoing) => {
    const check = async () => {
      const identity = await current.auth.api.getSession({
        headers: fromNodeHeaders(incoming.headers),
      });
      if (identity?.user.id !== actor.id)
        throw new Error("Fixture session lost");
    };
    await check();
    openLive(
      outgoing,
      current.live!,
      eventId,
      actor.id,
      new Date(Date.now() + 10_000),
      async () => {
        await delay(150);
        await check();
      },
    );
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing fixture port");
  const controller = new AbortController();
  let active: Promise<void> | undefined,
    writes = 0,
    writeError: unknown;
  let producer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${bound.port}/live`, {
      headers: { Cookie: actor.cookie },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    producer = setInterval(() => {
      if (active) return;
      active = current.db
        .collection<{
          _id: string;
          eventId: string;
          category: string;
          expiresAt: Date;
        }>("outbox")
        .insertOne({
          _id: randomUUID(),
          eventId,
          category: "event",
          expiresAt: new Date(Date.now() + 60_000),
        })
        .then(() => {
          writes++;
        })
        .catch((error) => {
          writeError = error;
        })
        .finally(() => {
          active = undefined;
        });
    }, 25);
    deadline = setTimeout(() => controller.abort(), 1_200);
    let heartbeat = false;
    try {
      while (!heartbeat) {
        const chunk = await reader.read();
        if (chunk.done) break;
        heartbeat = new TextDecoder()
          .decode(chunk.value)
          .includes(": heartbeat");
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    if (writeError) throw writeError;
    expect(writes).toBeGreaterThanOrEqual(5);
    expect(heartbeat).toBe(true);
  } finally {
    clearInterval(producer);
    clearTimeout(deadline);
    controller.abort();
    await active;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
