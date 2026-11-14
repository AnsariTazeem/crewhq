import { beforeAll, afterAll, expect, test } from "vitest";
import {
  MongoClient,
  type CommandStartedEvent,
  type CommandSucceededEvent,
} from "mongodb";
import { createTestHarness } from "./support/harness.js";
import type { Person, Event } from "../src/membership.js";

const uri =
  process.env.FAULT_MONGODB_URI ??
  "mongodb://127.0.0.1:27028/?replicaSet=rs0&directConnection=true";
const address = new URL(uri);
if (
  !["127.0.0.1", "localhost"].includes(address.hostname) ||
  address.port !== "27028"
)
  throw new Error(
    "Ranking faults require isolated loopback test service 27028",
  );
let h: Awaited<ReturnType<typeof createTestHarness>>, control: MongoClient;
beforeAll(async () => {
  control = await new MongoClient(uri, {
    appName: "h4h-ranking-fault-control",
    serverSelectionTimeoutMS: 3_000,
  }).connect();
  h = await createTestHarness({ mongoUri: uri, monitorCommands: true });
});
afterAll(async () => {
  await control
    ?.db("admin")
    .command({ configureFailPoint: "failCommand", mode: "off" });
  await h?.client.close();
  if (h && !h.db.databaseName.startsWith("h4h_test_"))
    throw new Error("Unsafe ranking test cleanup");
  if (h) await control.db(h.db.databaseName).dropDatabase();
  await control?.close();
});

test("a handover committed while candidate retrieval is blocked denies the former leader's stale response", async () => {
  const event = await h.event();
  await h.db.collection<Event>("events").updateOne(
    { _id: event },
    {
      $set: {
        startsAt: new Date("2026-11-14T00:00:00Z"),
        endsAt: new Date("2026-11-16T00:00:00Z"),
      },
    },
  );
  const leader = await h.person("Blocked ranking leader"),
    successor = await h.person("New ranking leader");
  const team = await h.team(event, leader);
  await h.command(`/api/events/${event}/enroll`, successor).expect(201);
  const code = await h.sharedCode(event, team, leader);
  await h
    .command(`/api/events/${event}/invitations/redeem`, successor, { code })
    .expect(201);
  // More than the initial Mongo cursor batch, forcing a real getMore at the candidate-read seam.
  await h.db.collection<Person>("people").insertMany(
    Array.from({ length: 200 }, (_, i): Person => ({
      _id: `${event}:race-${i}`,
      eventId: event,
      userId: `race-${i}`,
      teamId: null,
      membershipEpoch: 0,
      revision: 0,
    })),
  );
  let requestId: number | undefined,
    released = false;
  const snapshotReads: { level: string | undefined; at: string | undefined }[] =
    [];
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const observe = (event: CommandStartedEvent) => {
    if (
      requestId === undefined &&
      event.commandName === "find" &&
      ["people", "teams", "events"].includes(event.command.find) &&
      event.command.readConcern?.level !== "linearizable"
    ) {
      snapshotReads.push({
        level: event.command.readConcern?.level,
        at: event.command.readConcern?.atClusterTime?.toString(),
      });
    }
    if (
      event.commandName === "getMore" &&
      event.command.collection === "people"
    ) {
      requestId = event.requestId;
      signal();
    }
  };
  const finished = (event: CommandSucceededEvent) => {
    if (event.requestId === requestId) released = true;
  };
  h.client.on("commandStarted", observe);
  h.client.on("commandSucceeded", finished);
  const armed = await control.db("admin").command({
    configureFailPoint: "failCommand",
    mode: { times: 1 },
    data: {
      failCommands: ["getMore"],
      appName: h.appName,
      blockConnection: true,
      blockTimeMS: 1_000,
    },
  });
  const pending = h
    .get(`/api/events/${event}/teammate-suggestions`, leader)
    .then((response) => response);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("No blocked candidate cursor observed")),
          5_000,
        );
      }),
    ]);
    await control.db("admin").command({
      waitForFailPoint: "failCommand",
      timesEntered: armed.count + 1,
      maxTimeMS: 1_000,
    });
    expect(snapshotReads.length).toBeGreaterThanOrEqual(4);
    expect(snapshotReads.every((read) => read.level === "snapshot")).toBe(true);
    expect(snapshotReads.slice(1).every((read) => Boolean(read.at))).toBe(true);
    expect(new Set(snapshotReads.slice(1).map((read) => read.at)).size).toBe(1);
    await h
      .command(`/api/events/${event}/teams/${team}/leave`, leader, {
        successorId: successor.id,
      })
      .expect(200);
    expect(released).toBe(false);
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("MEMBERSHIP_CHANGED");
    expect(response.body).not.toHaveProperty("items");
  } finally {
    clearTimeout(timeout);
    await control
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode: "off" });
    await pending.catch(() => undefined);
    h.client.off("commandStarted", observe);
    h.client.off("commandSucceeded", finished);
  }
});
