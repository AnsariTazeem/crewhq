import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import { connectLive } from "./support/live-client.js";
import { ObjectId, Timestamp, type CommandStartedEvent } from "mongodb";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let server: Server;
let origin: string;
beforeAll(async () => {
  harness = await createTestHarness({ live: true, monitorCommands: true });
  server = harness.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP test address");
  origin = `http://127.0.0.1:${address.port}`;
});

test("a committed team change emits an event-scoped refresh with no private action payload", async () => {
  const eventId = await harness.event();
  const viewer = await harness.person("Board viewer");
  const leader = await harness.person("Recruiting leader");
  await harness.command(`/api/events/${eventId}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const stream = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    viewer.cookie,
  );
  try {
    await stream.next("ready");
    const created = await harness
      .command(`/api/events/${eventId}/teams`, leader, {
        name: "Live recruiting team",
      })
      .expect(201);
    const hint = await stream.next("refresh");
    expect(Object.keys(hint).sort()).toEqual(["frontier", "generation"]);
    expect(JSON.stringify(hint)).not.toContain(leader.id);
    expect(JSON.stringify(hint)).not.toContain(created.body.result.teamId);
    expect(JSON.stringify(hint)).not.toContain("TEAM_CREATED");
  } finally {
    await stream.close();
  }
});

test("a refresh refetch reaches its signed minimum and confirms the authoritative board", async () => {
  const eventId = await harness.event();
  const viewer = await harness.person("Fresh board viewer");
  const leader = await harness.person("Fresh board leader");
  await harness.command(`/api/events/${eventId}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, leader).expect(201);
  const stream = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    viewer.cookie,
  );
  try {
    await stream.next("ready");
    const created = await harness
      .command(`/api/events/${eventId}/teams`, leader, { name: "Fresh team" })
      .expect(201);
    const hint = await stream.next("refresh");
    const starts: CommandStartedEvent["command"][] = [];
    const capture = (event: CommandStartedEvent) => {
      starts.push(event.command);
    };
    harness.client.on("commandStarted", capture);
    let response;
    try {
      response = await harness
        .get(`/api/events/${eventId}/board?kind=teams`, viewer)
        .set("X-Read-Frontier", String(hint.frontier))
        .expect(200);
    } finally {
      harness.client.off("commandStarted", capture);
    }
    expect(response.headers["x-read-frontier"]).toEqual(expect.any(String));
    expect(
      response.body.items.map((item: { id: string }) => item.id),
    ).toContain(created.body.result.teamId);
    const decoded = JSON.parse(
      Buffer.from(String(hint.frontier).split(".")[0]!, "base64url").toString(),
    );
    const floor = new Timestamp({ t: decoded.t, i: decoded.i });
    expect(
      starts.some(
        (command) =>
          command.readConcern?.afterClusterTime instanceof Timestamp &&
          command.readConcern.afterClusterTime.compare(floor) >= 0,
      ),
    ).toBe(true);
    expect(
      starts.some(
        (command) =>
          command.commitTransaction && command.writeConcern?.w === "majority",
      ),
    ).toBe(true);
  } finally {
    await stream.close();
  }
});

test("live admission requires current identity, event enrollment and an accepted browser origin", async () => {
  const eventId = await harness.event();
  const outsider = await harness.person("Live outsider");
  await harness.get(`/api/events/${eventId}/live`, { cookie: "" }).expect(401);
  await harness.get(`/api/events/${eventId}/live`, outsider).expect(403);
  await harness.command(`/api/events/${eventId}/enroll`, outsider).expect(201);
  await harness
    .get(`/api/events/${eventId}/live`, outsider)
    .set("Origin", "https://untrusted.example")
    .expect(403);
  await harness
    .get(`/api/events/${eventId}/live`, outsider)
    .set("Sec-Fetch-Site", "cross-site")
    .expect(403);
});

test("frontiers reject tampering, wrong event, excessive length and expired issuance without an acknowledgement", async () => {
  const eventId = await harness.event(),
    otherEvent = await harness.event();
  const actor = await harness.person("Frontier validator");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.command(`/api/events/${otherEvent}/enroll`, actor).expect(201);
  const stream = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    actor.cookie,
  );
  try {
    const ready = await stream.next("ready");
    const token = String(ready.frontier);
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString(),
    );
    decoded.t += 100_000;
    const invented = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${token.split(".")[1]}`;
    for (const invalid of ["x", "x".repeat(1_100), invented]) {
      const result = await harness
        .get(`/api/events/${eventId}/board`, actor)
        .set("X-Read-Frontier", invalid)
        .expect(400);
      expect(result.headers["x-read-frontier"]).toBeUndefined();
    }
    await harness
      .get(`/api/events/${otherEvent}/board`, actor)
      .set("X-Read-Frontier", token)
      .expect(400);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    try {
      await harness
        .get(`/api/events/${eventId}/board`, actor)
        .set("X-Read-Frontier", token)
        .expect(409);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await stream.close();
  }
});

test("lost session validity or event access resets existing streams", async () => {
  const eventId = await harness.event();
  for (const loss of ["session", "enrollment", "invalid-expiry"]) {
    const actor = await harness.person(`Revoked ${loss}`);
    await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
    const stream = await connectLive(
      `${origin}/api/events/${eventId}/live`,
      actor.cookie,
    );
    try {
      await stream.next("ready");
      if (loss === "session")
        await harness.command("/api/auth/sign-out", actor).expect(200);
      else if (loss === "invalid-expiry")
        await harness.db
          .collection("session")
          .updateOne(
            { _id: new ObjectId(actor.sessionId) },
            { $set: { expiresAt: "invalid" } },
          );
      else
        await harness.db
          .collection("people")
          .deleteOne({ eventId, userId: actor.id });
      expect(await stream.next("reset")).toEqual({
        reason: "REFRESH_REQUIRED",
      });
    } finally {
      await stream.close();
    }
  }
});

test("session expiry ends a subscription even while the source stays healthy", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Expiring stream");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.db
    .collection("session")
    .updateOne(
      { _id: new ObjectId(actor.sessionId) },
      { $set: { expiresAt: new Date(Date.now() + 1_500) } },
    );
  const stream = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    actor.cookie,
  );
  try {
    await stream.next("ready");
    expect(await stream.next("reset")).toEqual({ reason: "REFRESH_REQUIRED" });
  } finally {
    await stream.close();
  }
});

test("per-actor connection bounds release capacity after a client disconnects", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Two browser tabs");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const first = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    actor.cookie,
  );
  const second = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    actor.cookie,
  );
  try {
    await first.next("ready");
    await second.next("ready");
    await harness.get(`/api/events/${eventId}/live`, actor).expect(429);
    await first.close();
    await delay(30);
    const replacement = await connectLive(
      `${origin}/api/events/${eventId}/live`,
      actor.cookie,
    );
    try {
      expect(replacement.response.status).toBe(200);
      await replacement.next("ready");
    } finally {
      await replacement.close();
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test("connection attempts are limited across repeated short-lived streams", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Repeated live attempts");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  for (let i = 0; i < 20; i++) {
    const stream = await connectLive(
      `${origin}/api/events/${eventId}/live`,
      actor.cookie,
    );
    try {
      expect(stream.response.status).toBe(200);
      await stream.next("ready");
    } finally {
      await stream.close();
    }
  }
  const limited = await harness
    .get(`/api/events/${eventId}/live`, actor)
    .expect(429);
  expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
});

test("event-scoped streams exclude another event's committed changes", async () => {
  const eventId = await harness.event(),
    otherEvent = await harness.event();
  const viewer = await harness.person("Scoped stream viewer"),
    actor = await harness.person("Other event actor");
  await harness.command(`/api/events/${eventId}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${otherEvent}/enroll`, viewer).expect(201);
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  await harness.command(`/api/events/${otherEvent}/enroll`, actor).expect(201);
  const here = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    viewer.cookie,
  );
  const there = await connectLive(
    `${origin}/api/events/${otherEvent}/live`,
    viewer.cookie,
  );
  try {
    await here.next("ready");
    await there.next("ready");
    await harness
      .command(`/api/events/${otherEvent}/teams`, actor, {
        name: "Other event team",
      })
      .expect(201);
    await there.next("refresh");
    await expect(here.next("refresh", 1_500)).rejects.toThrow("Timed out");
    await harness
      .command(`/api/events/${eventId}/teams`, actor, {
        name: "This event team",
      })
      .expect(201);
    await here.next("refresh");
  } finally {
    await here.close();
    await there.close();
  }
});

test("a failed domain write does not publish a membership hint", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Failed live writer");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const stream = await connectLive(
    `${origin}/api/events/${eventId}/live`,
    actor.cookie,
  );
  try {
    await stream.next("ready");
    await harness.db.command({
      collMod: "audit",
      validator: { action: { $ne: "TEAM_CREATED" } },
      validationAction: "error",
    });
    await harness
      .command(`/api/events/${eventId}/teams`, actor, { name: "Rejected team" })
      .expect(503);
    expect(
      await harness.db.collection("teams").countDocuments({ eventId }),
    ).toBe(0);
    await expect(stream.next("refresh", 1_500)).rejects.toThrow("Timed out");
  } finally {
    await harness.db.command({ collMod: "audit", validator: {} });
    await stream.close();
  }
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness?.close();
});

test("an enrolled participant opens a neutral live stream and receives a read frontier", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Live participant");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${origin}/api/events/${eventId}/live`, {
      headers: { Cookie: actor.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream ended before ready");
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("event: ready\n");
    const frame = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(Object.keys(frame).sort()).toEqual(["frontier", "generation"]);
    expect(frame.generation).toMatch(/^[a-f0-9-]{36}$/);
    expect(frame.frontier).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(text).not.toContain(actor.id);
    expect(text).not.toContain("@example.test");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});
