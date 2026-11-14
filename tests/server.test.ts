import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";
import type { Event } from "../src/membership.js";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

function start(port: number, overrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      MONGODB_URI:
        process.env.TEST_MONGODB_URI ??
        "mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true",
      MONGODB_DATABASE: harness.db.databaseName,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      INVITATION_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      GOOGLE_CLIENT_ID: "isolated-startup.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "isolated-startup-fixture-only",
      DEMO_MIN_SIZE: "2",
      DEMO_MAX_SIZE: "4",
      DEMO_ADMISSIONS_CLOSES_AT: "2030-01-01T00:00:00.000Z",
      DEMO_EVENT_STARTS_AT: "2030-01-02T00:00:00.000Z",
      DEMO_EVENT_ENDS_AT: "2030-01-03T00:00:00.000Z",
      ...overrides,
    },
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8192);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  return { child, exited, output: () => output };
}
async function stop(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

test("the actual server entry starts with isolated fixture configuration and serves readiness", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => {
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  await new Promise<void>((resolve) => {
    reservation.close(() => resolve());
  });
  const instance = start(address.port);
  try {
    const deadline = Date.now() + 10_000;
    while (
      !instance.output().includes("core API listening") &&
      Date.now() < deadline &&
      instance.child.exitCode === null
    )
      await delay(50);
    expect(instance.output()).toContain("core API listening");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/health/ready`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(
      await harness.db
        .collection<Event>("events")
        .findOne({ name: "Team formation demo" }),
    ).toMatchObject({
      startsAt: new Date("2030-01-02T00:00:00.000Z"),
      endsAt: new Date("2030-01-03T00:00:00.000Z"),
    });
  } finally {
    await stop(instance.child, instance.exited);
  }
}, 15_000);

test("startup rejects an invalid ranking date range before listening", async () => {
  const instance = start(12345, {
    DEMO_EVENT_ENDS_AT: "2031-01-03T00:00:00.000Z",
  });
  const timeout = setTimeout(() => {
    instance.child.kill();
  }, 10_000);
  try {
    expect(await instance.exited).toBe(1);
    expect(instance.output()).toContain("DEMO_EVENT_STARTS_AT");
    expect(instance.output()).not.toContain("core API listening");
    expect(instance.output()).not.toContain("isolated-startup-fixture-only");
  } finally {
    clearTimeout(timeout);
    await stop(instance.child, instance.exited);
  }
}, 15_000);

test("startup refuses to replace the configured dates of an existing event", async () => {
  const instance = start(12345, {
    DEMO_EVENT_STARTS_AT: "2030-01-04T00:00:00.000Z",
    DEMO_EVENT_ENDS_AT: "2030-01-05T00:00:00.000Z",
  });
  const timeout = setTimeout(() => {
    instance.child.kill();
  }, 10_000);
  try {
    expect(await instance.exited).toBe(1);
    expect(instance.output()).toContain("startup failed");
    expect(instance.output()).not.toContain("core API listening");
    expect(
      await harness.db
        .collection<Event>("events")
        .findOne({ name: "Team formation demo" }),
    ).toMatchObject({
      startsAt: new Date("2030-01-02T00:00:00.000Z"),
      endsAt: new Date("2030-01-03T00:00:00.000Z"),
    });
  } finally {
    clearTimeout(timeout);
    await stop(instance.child, instance.exited);
  }
}, 15_000);

test("a port bind failure exits unsuccessfully instead of falsely announcing readiness", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => {
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  const instance = start(address.port);
  const timeout = setTimeout(() => {
    instance.child.kill();
  }, 10_000);
  try {
    expect(await instance.exited).toBe(1);
    expect(instance.output()).toContain("HTTP listen failed");
    expect(instance.output()).not.toContain("core API listening");
  } finally {
    clearTimeout(timeout);
    await stop(instance.child, instance.exited);
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve());
    });
  }
}, 15_000);
