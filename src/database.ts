import { randomUUID } from "node:crypto";
import { getAuthTables } from "better-auth/db";
import type { BetterAuthOptions } from "better-auth";
import { MongoServerError, type Db, type MongoClient } from "mongodb";

export async function ensureDatabaseReady(
  db: Db,
  client: MongoClient,
  auth: BetterAuthOptions,
) {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary)
    throw new Error("A writable MongoDB replica set is required");

  // Await the actual auth schema constraints instead of trusting its background index builds.
  for (const [logicalName, table] of Object.entries(getAuthTables(auth))) {
    if (table.disableMigrations) continue;
    if (table.indexes?.length)
      throw new Error(
        "Auth table indexes require an explicit readiness migration",
      );
    const model = table.modelName ?? logicalName;
    for (const [name, field] of Object.entries(table.fields)) {
      if (!field.unique && !field.index) continue;
      if (
        field.type === "json" ||
        Array.isArray(field.type) ||
        field.type === "string[]" ||
        field.type === "number[]"
      )
        continue;
      if (field.unique && field.required === false)
        throw new Error(
          "Optional auth uniqueness needs an explicit partial-index migration",
        );
      const column = field.fieldName ?? name;
      if (column === "id") continue;
      await db.collection(model).createIndex(
        { [column]: 1 },
        {
          name: `${model}_${column}_${field.unique ? "uidx" : "idx"}`,
          unique: field.unique === true,
        },
      );
    }
  }

  await db
    .collection("people")
    .createIndex({ eventId: 1, userId: 1 }, { unique: true });
  await db
    .collection("people")
    .createIndex({ eventId: 1, teamId: 1, userId: 1 });
  await db.collection("teams").createIndex({ eventId: 1, state: 1, _id: 1 });
  await db
    .collection("requests")
    .createIndex(
      { eventId: 1, teamId: 1, applicantId: 1, epoch: 1 },
      { unique: true, partialFilterExpression: { state: "pending" } },
    );
  await db
    .collection("requests")
    .createIndex({ eventId: 1, teamId: 1, _id: 1 });
  await db
    .collection("requests")
    .createIndex({ eventId: 1, applicantId: 1, _id: 1 });
  await db
    .collection("invitations")
    .createIndex({ digest: 1 }, { unique: true });
  await db
    .collection("restrictions")
    .createIndex({ eventId: 1, teamId: 1, userId: 1 }, { unique: true });
  await db
    .collection("operations")
    .createIndex({ actorId: 1, eventId: 1, key: 1 }, { unique: true });
  await db
    .collection("audit")
    .createIndex({ eventId: 1, teamId: 1, at: 1, _id: 1 });
  await db
    .collection("outbox")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db
    .collection("rate_limits")
    .createIndex({ expire: -1 }, { expireAfterSeconds: 0 });
  await db.collection("rate_limits").createIndex({ key: 1 }, { unique: true });
  try {
    await db.createCollection("readiness");
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === 48)) throw error;
  }
  const session = client.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    const marker = randomUUID();
    await db
      .collection<{ _id: string }>("readiness")
      .insertOne({ _id: marker }, { session });
    await db
      .collection<{ _id: string }>("readiness")
      .deleteOne({ _id: marker }, { session });
    await session.commitTransaction();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
}
