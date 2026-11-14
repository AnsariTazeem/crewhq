import { betterAuth } from "better-auth";
import { MongoClient } from "mongodb";
import pino from "pino";
import { ZodError } from "zod";
import { createApp } from "./app.js";
import { authOptions } from "./auth.js";
import { loadConfig } from "./config.js";
import { ensureDatabaseReady } from "./database.js";
import type { Event } from "./membership.js";

const logger = pino({
  level: "info",
  redact: [
    "headers.cookie",
    "headers.authorization",
    "body.code",
    "*.token",
    "*.secret",
    "*.password",
  ],
});
let client: MongoClient | undefined;
try {
  const config = loadConfig(process.env);
  client = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 3_000,
    connectTimeoutMS: 3_000,
    socketTimeoutMS: 2_000,
    waitQueueTimeoutMS: 2_000,
    maxPoolSize: 100,
    readPreference: "primary",
    readConcern: { level: "majority" },
    writeConcern: { w: "majority" },
  });
  await client.connect();
  const db = client.db(config.MONGODB_DATABASE);
  const options = authOptions({
    db,
    client,
    origin: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    googleClientId: config.GOOGLE_CLIENT_ID,
    googleClientSecret: config.GOOGLE_CLIENT_SECRET,
  });
  const auth = betterAuth(options);
  await auth.$context;
  await ensureDatabaseReady(db, client, options);
  const events = db.collection<Event>("events");
  const existing = await events.findOne({ _id: config.DEMO_EVENT_ID });
  if (
    existing &&
    (existing.minSize !== config.DEMO_MIN_SIZE ||
      existing.maxSize !== config.DEMO_MAX_SIZE ||
      (config.DEMO_EVENT_STARTS_AT &&
        existing.startsAt?.getTime() !==
          Date.parse(config.DEMO_EVENT_STARTS_AT)) ||
      (config.DEMO_EVENT_ENDS_AT &&
        existing.endsAt?.getTime() !== Date.parse(config.DEMO_EVENT_ENDS_AT)))
  ) {
    throw new Error("Existing event rules differ; refusing to overwrite them");
  }
  await events.updateOne(
    { _id: config.DEMO_EVENT_ID },
    {
      $setOnInsert: {
        _id: config.DEMO_EVENT_ID,
        name: "Team formation demo",
        minSize: config.DEMO_MIN_SIZE,
        maxSize: config.DEMO_MAX_SIZE,
        admissionClosesAt: new Date(config.DEMO_ADMISSIONS_CLOSES_AT),
        ...(config.DEMO_EVENT_STARTS_AT && config.DEMO_EVENT_ENDS_AT
          ? {
              startsAt: new Date(config.DEMO_EVENT_STARTS_AT),
              endsAt: new Date(config.DEMO_EVENT_ENDS_AT),
            }
          : {}),
      },
    },
    { upsert: true },
  );
  let ready = true;
  const app = createApp({
    db,
    client,
    auth,
    origin: config.APP_ORIGIN,
    invitationKey: config.INVITATION_ENCRYPTION_KEY,
    logger,
    isReady: () => ready,
  });
  const server = app.listen(config.PORT, config.HOST, (error?: Error) => {
    if (error) {
      ready = false;
      logger.error(
        {
          errorType: error.name,
          ...("code" in error ? { code: error.code } : {}),
        },
        "HTTP listen failed",
      );
      void client?.close().finally(() => {
        process.exitCode = 1;
      });
      return;
    }
    logger.info({ port: config.PORT, host: config.HOST }, "core API listening");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    logger.info("draining HTTP requests");
    const forced = setTimeout(() => {
      server.closeAllConnections();
      void client?.close();
      process.exitCode = 1;
    }, 10_000);
    forced.unref();
    server.close(() => {
      clearTimeout(forced);
      void client?.close().then(() => logger.info("core API stopped"));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  logger.error(
    {
      type: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ZodError
        ? { fields: error.issues.map((issue) => issue.path.join(".")) }
        : {}),
    },
    "startup failed; inspect configuration and database readiness",
  );
  await client?.close();
  process.exitCode = 1;
}
