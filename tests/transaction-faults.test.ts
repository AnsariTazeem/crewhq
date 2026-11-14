import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { MongoClient, type CommandStartedEvent } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { createTestHarness } from "./support/harness.js";
import type { Person } from "../src/membership.js";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
const faultUri =
  process.env.FAULT_MONGODB_URI ??
  "mongodb://127.0.0.1:27028/?replicaSet=rs0&directConnection=true";
const faultAddress = new URL(faultUri);
if (
  !["127.0.0.1", "localhost"].includes(faultAddress.hostname) ||
  faultAddress.port !== "27028"
) {
  throw new Error(
    "Fault commands are restricted to the isolated loopback test service on port 27028",
  );
}
let control: MongoClient;
beforeAll(async () => {
  control = await new MongoClient(faultUri, {
    appName: "h4h-fault-control",
    serverSelectionTimeoutMS: 3_000,
  }).connect();
});
beforeEach(async () => {
  harness = await createTestHarness({
    mongoUri: faultUri,
    monitorCommands: true,
  });
});
afterEach(async () => {
  await clearFailure();
  await harness.client.close();
  if (!harness.db.databaseName.startsWith("h4h_test_"))
    throw new Error("Unsafe fault-test cleanup target");
  await control.db(harness.db.databaseName).dropDatabase();
});
afterAll(async () => {
  await control?.close();
});

async function failCommands(
  commands: string[],
  times: number,
  errorCode: number,
  label: string,
) {
  await control.db("admin").command({
    configureFailPoint: "failCommand",
    mode: { times },
    data: {
      failCommands: commands,
      appName: harness.appName,
      errorCode,
      errorLabels: [label],
    },
  });
}
async function clearFailure() {
  await control
    .db("admin")
    .command({ configureFailPoint: "failCommand", mode: "off" });
}

test("unknown commit results retry the same database transaction and produce one durable effect", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Uncertain commit actor");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  const commits: string[] = [];
  const observe = (event: CommandStartedEvent) => {
    if (event.commandName === "commitTransaction")
      commits.push(
        `${JSON.stringify(event.command.lsid)}:${String(event.command.txnNumber)}`,
      );
  };
  harness.client.on("commandStarted", observe);
  let response;
  try {
    // Preserve the uncertainty label without the separate topology-reset effect of shutdown errors.
    await failCommands(
      ["commitTransaction"],
      2,
      50,
      "UnknownTransactionCommitResult",
    );
    response = await harness.command(`/api/events/${eventId}/teams`, actor, {
      name: "Uncertain commit",
    });
  } finally {
    await clearFailure();
    harness.client.off("commandStarted", observe);
  }
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/commit-fault-diagnostic.json",
    JSON.stringify(
      {
        injectedCode: 50,
        status: response.status,
        outcome: response.body.outcome,
        commitCommands: commits.length,
        distinctCommitTransactions: new Set(commits).size,
      },
      null,
      2,
    ),
  );
  expect(response.status).toBe(201);
  expect(commits.length).toBeGreaterThanOrEqual(3);
  expect(new Set(commits).size).toBe(1);
  expect(await harness.db.collection("teams").countDocuments({ eventId })).toBe(
    1,
  );
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "TEAM_CREATED" }),
  ).toBe(1);
});

test("a real transient write conflict replays the aborted transaction without duplicate effects", async () => {
  const eventId = await harness.event();
  const actor = await harness.person("Transient conflict actor");
  await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
  try {
    await failCommands(["update"], 1, 112, "TransientTransactionError");
    await harness
      .command(`/api/events/${eventId}/teams`, actor, {
        name: "Retried transaction",
      })
      .expect(201);
  } finally {
    await clearFailure();
  }
  expect(await harness.db.collection("teams").countDocuments({ eventId })).toBe(
    1,
  );
  expect(
    await harness.db
      .collection("audit")
      .countDocuments({ eventId, action: "TEAM_CREATED" }),
  ).toBe(1);
  expect(
    await harness.db
      .collection<Person>("people")
      .findOne({ eventId, userId: actor.id }),
  ).toMatchObject({ membershipEpoch: 1 });
});

test.each(["operations", "outbox"])(
  "a required %s write failure rolls back the entire domain change",
  async (collection) => {
    const eventId = await harness.event();
    const actor = await harness.person(`Rollback ${collection}`);
    await harness.command(`/api/events/${eventId}/enroll`, actor).expect(201);
    const key = randomUUID();
    const beforeOutbox = await harness.db
      .collection("outbox")
      .countDocuments({ eventId });
    const validator =
      collection === "operations"
        ? { decision: { $exists: false } }
        : { $jsonSchema: { required: ["testOnlyRequiredMissingField"] } };
    await harness.db.command({ collMod: collection, validator });
    try {
      await harness
        .command(
          `/api/events/${eventId}/teams`,
          actor,
          { name: "Atomic failure" },
          key,
        )
        .expect(503);
      expect(
        await harness.db.collection("teams").countDocuments({ eventId }),
      ).toBe(0);
      expect(
        await harness.db
          .collection<Person>("people")
          .findOne({ eventId, userId: actor.id }),
      ).toMatchObject({ teamId: null, membershipEpoch: 0 });
      expect(
        await harness.db
          .collection("operations")
          .countDocuments({ eventId, key }),
      ).toBe(0);
      expect(
        await harness.db.collection("audit").countDocuments({ eventId }),
      ).toBe(0);
      expect(
        await harness.db.collection("outbox").countDocuments({ eventId }),
      ).toBe(beforeOutbox);
    } finally {
      await harness.db.command({ collMod: collection, validator: {} });
    }
  },
);
