import { randomBytes, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { MongoClient } from "mongodb";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { authOptions } from "../../src/auth.js";
import { ensureDatabaseReady } from "../../src/database.js";
import type { Event } from "../../src/membership.js";

export const origin = "http://localhost:3000";

export async function createTestHarness(
  settings: { mongoUri?: string; monitorCommands?: boolean } = {},
) {
  const appName = `h4h-test-${randomUUID()}`;
  const client = new MongoClient(
    settings.mongoUri ??
      process.env.TEST_MONGODB_URI ??
      "mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true",
    {
      serverSelectionTimeoutMS: 3_000,
      socketTimeoutMS: 2_000,
      waitQueueTimeoutMS: 2_000,
      maxPoolSize: 100,
      appName,
      monitorCommands: settings.monitorCommands ?? false,
      readPreference: "primary",
      readConcern: { level: "majority" },
      writeConcern: { w: "majority" },
    },
  );
  await client.connect();
  const db = client.db(`h4h_test_${randomUUID().replaceAll("-", "")}`);
  const options = authOptions({
    db,
    client,
    origin,
    secret: randomBytes(32).toString("base64url"),
    googleClientId: "isolated-test.apps.googleusercontent.com",
    googleClientSecret: "isolated-test-only",
  });
  // The official fixture plugin is registered only here, never in production auth options.
  const auth = betterAuth({
    ...options,
    plugins: [...(options.plugins ?? []), testUtils()],
  });
  await auth.$context;
  await ensureDatabaseReady(db, client, options);
  const app = createApp({
    auth,
    db,
    client,
    origin,
    invitationKey: randomBytes(32).toString("base64url"),
  });
  const command = (
    path: string,
    person: { cookie: string },
    body: string | object = {},
    key: string = randomUUID(),
  ) =>
    request(app)
      .post(path)
      .set("Cookie", person.cookie)
      .set("Origin", origin)
      .set("X-App-Request", "1")
      .set("Idempotency-Key", key)
      .send(body);
  return {
    app,
    appName,
    db,
    client,
    auth,
    command,
    async team(eventId: string, leader: { cookie: string }, name = "Apex") {
      await command(`/api/events/${eventId}/enroll`, leader).expect(201);
      const response = await command(`/api/events/${eventId}/teams`, leader, {
        name,
      }).expect(201);
      return response.body.result.teamId as string;
    },
    async sharedCode(
      eventId: string,
      teamId: string,
      leader: { cookie: string },
    ) {
      const issued = await command(
        `/api/events/${eventId}/teams/${teamId}/invitations`,
        leader,
        { kind: "shared" },
      );
      const revealed = await request(app)
        .get(
          `/api/events/${eventId}/teams/${teamId}/invitations/${issued.body.result.invitationId}`,
        )
        .set("Cookie", leader.cookie)
        .expect(200);
      return revealed.body.code as string;
    },
    get(path: string, person: { cookie: string }) {
      return request(app).get(path).set("Cookie", person.cookie);
    },
    async event(maxSize = 4, minSize = 2) {
      const id = randomUUID();
      await db.collection<Event>("events").insertOne({
        _id: id,
        name: "Test event",
        minSize,
        maxSize,
        admissionClosesAt: new Date(Date.now() + 86_400_000),
      });
      return id;
    },
    async person(name: string) {
      const { test: fixtures } = await auth.$context;
      const user = await fixtures.saveUser(
        fixtures.createUser({ name, email: `${randomUUID()}@example.test` }),
      );
      const login = await fixtures.login({ userId: user.id });
      return {
        id: user.id,
        cookie: login.headers.get("cookie")!,
        sessionId: login.session.id,
      };
    },
    async close() {
      if (!db.databaseName.startsWith("h4h_test_"))
        throw new Error("Unsafe test cleanup target");
      await db.dropDatabase();
      await client.close();
    },
  };
}
