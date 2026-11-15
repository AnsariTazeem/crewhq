import { randomUUID, randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { seedDataset, verifyDataset } from "../scripts/seed-data.js";
import { authOptions } from "../src/auth.js";
import { ensureDatabaseReady } from "../src/database.js";
import { createApp } from "../src/app.js";

const client = new MongoClient(
  process.env.TEST_MONGODB_URI ??
    "mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true",
);
const db = client.db(`h4h_bench_${randomUUID().replaceAll("-", "")}`);
beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

test("the seed creates exactly 10000 identities and 2000 consistent teams with a usable discovery board", async () => {
  const options = authOptions({
    db,
    client,
    origin: "http://localhost:3000",
    secret: randomBytes(32).toString("base64url"),
    googleClientId: "fixture.apps.googleusercontent.com",
    googleClientSecret: "fixture-only",
  });
  const auth = betterAuth(options);
  await auth.$context;
  await ensureDatabaseReady(db, client, options);
  const seeded = await seedDataset(db);
  expect(seeded).toMatchObject({
    users: 10_000,
    people: 10_000,
    teams: 2_000,
    unteamed: 5_000,
    recruiting: 1_500,
    incomplete: 500,
  });
  expect(await db.collection("user").countDocuments()).toBe(10_000);
  expect(await db.collection("teams").countDocuments()).toBe(2_000);
  const rosterMismatch = await db
    .collection("teams")
    .aggregate([
      { $unwind: "$members" },
      {
        $lookup: {
          from: "people",
          let: { user: "$members", team: "$_id" },
          pipeline: [
            {
              $match: {
                eventId: seeded.eventId,
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$user"] },
                    { $eq: ["$teamId", "$$team"] },
                  ],
                },
              },
            },
          ],
          as: "linked",
        },
      },
      { $match: { "linked.0": { $exists: false } } },
    ])
    .toArray();
  expect(rosterMismatch).toHaveLength(0);
  const fixtureAuth = betterAuth({
    ...options,
    plugins: [...(options.plugins ?? []), testUtils()],
  });
  const { test: fixtures } = await fixtureAuth.$context;
  const solo = await db.collection("people").findOne({ teamId: null });
  const login = await fixtures.login({ userId: solo!.userId });
  const app = createApp({
    db,
    client,
    auth,
    origin: "http://localhost:3000",
    invitationKey: randomBytes(32).toString("base64url"),
  });
  for (const kind of ["people", "teams"]) {
    const response = await request(app)
      .get(`/api/events/${seeded.eventId}/board?kind=${kind}&limit=20`)
      .set("Cookie", login.headers.get("cookie")!)
      .expect(200);
    expect(response.body.items).toHaveLength(20);
    expect(typeof response.body.nextCursor).toBe("string");
  }
  await request(app).get(`/api/events/${seeded.eventId}/board`).expect(401);
}, 30_000);

test("repeating a completed seed validates it without adding or rewriting records", async () => {
  const before = await db.collection("user").findOne();
  await seedDataset(db);
  expect(await db.collection("user").countDocuments()).toBe(10_000);
  expect(await db.collection("user").findOne({ _id: before!._id })).toEqual(
    before,
  );
});

test("verification detects a membership pointer that disagrees with its roster", async () => {
  const solo = await db.collection("people").findOne({ teamId: { $ne: null } });
  await db
    .collection("people")
    .updateOne({ _id: solo!._id }, { $set: { teamId: randomUUID() } });
  await expect(verifyDataset(db)).rejects.toThrow("membership");
  await db
    .collection("people")
    .updateOne({ _id: solo!._id }, { $set: { teamId: solo!.teamId } });
});

test("an unrelated database name is refused before writing", async () => {
  await expect(seedDataset(client.db("admin"))).rejects.toThrow(
    "benchmark database",
  );
});

test("a nonempty unmarked benchmark database is preserved", async () => {
  const other = client.db(`h4h_bench_${randomUUID().replaceAll("-", "")}`);
  try {
    const id = new ObjectId();
    await other
      .collection("user")
      .insertOne({ _id: id, name: "Existing identity" });
    await expect(seedDataset(other)).rejects.toThrow("not empty");
    await other.collection("outbox").insertOne({ expiresAt: new Date(0) });
    const beforeIndexes = await other
      .collection("outbox")
      .listIndexes()
      .toArray();
    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/seed.ts", "--database", other.databaseName],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(cli.status).not.toBe(0);
    expect(await other.collection("outbox").listIndexes().toArray()).toEqual(
      beforeIndexes,
    );
    expect(await other.collection("user").findOne({ _id: id })).toMatchObject({
      name: "Existing identity",
    });
    expect(await other.collection("people").countDocuments()).toBe(0);
  } finally {
    await other.dropDatabase();
  }
});
