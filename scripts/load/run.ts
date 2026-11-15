import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MongoClient } from "mongodb";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import pino from "pino";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { evaluateSummary } from "./result.js";
import { authOptions } from "../../src/auth.js";
import { ensureDatabaseReady } from "../../src/database.js";
import { createApp } from "../../src/app.js";
import { LiveSource } from "../../src/live-source.js";
import {
  seedDataset,
  verifyDataset,
  assertBenchmarkDatabase,
  seededUserId,
} from "../seed-data.js";
import { boardQueries, validBoard } from "./contract.js";

const image =
  "grafana/k6@sha256:d41bb79cd8de5a7ad619b53570e3712633e8bff0937010a5c6c57a4747e7a276";
const runId =
  new Date().toISOString().replaceAll(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 8);
const output = path.resolve("test-results/load", runId);
const temporary = await mkdtemp(path.join(os.tmpdir(), "crewhq-load-"));
await mkdir(output, { recursive: true });
const clientOptions = {
  monitorCommands: true,
  maxPoolSize: 100,
  serverSelectionTimeoutMS: 3_000,
  connectTimeoutMS: 3_000,
  socketTimeoutMS: 2_000,
  waitQueueTimeoutMS: 2_000,
  readPreference: "primary" as const,
  readConcern: { level: "majority" as const },
  writeConcern: { w: "majority" as const },
};
const uri =
  process.env.TEST_MONGODB_URI ??
  "mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true";
const client = new MongoClient(uri, clientOptions);
const observer = new MongoClient(uri, { ...clientOptions, maxPoolSize: 2 });
const db = client.db(`h4h_bench_${randomUUID().replaceAll("-", "")}`);
assertBenchmarkDatabase(db);
let ownedDatabase = false;
let observeCommands = false;
const commandTimings = new Map<string, number[]>();
const commandLabels = new Map<number, string>();
const checkoutTimings: number[] = [];
let activeConnections = 0,
  peakConnections = 0,
  checkoutFailures = 0;
client.on("connectionCheckedOut", (event) => {
  activeConnections++;
  if (observeCommands) {
    peakConnections = Math.max(peakConnections, activeConnections);
    checkoutTimings.push(event.durationMS);
  }
});
client.on("connectionCheckedIn", () => {
  activeConnections--;
});
client.on("connectionCheckOutFailed", () => {
  if (observeCommands) checkoutFailures++;
});
client.on("commandStarted", (event) => {
  if (!observeCommands) return;
  const collection = event.command[event.commandName];
  const allowed = ["session", "people", "teams", "events", "outbox"];
  const target =
    typeof collection === "string" && allowed.includes(collection)
      ? collection
      : "other";
  const concern =
    event.command.autocommit === false
      ? "snapshot"
      : (event.command.readConcern?.level ?? "default");
  commandLabels.set(
    event.requestId,
    `${event.commandName}:${target}:${concern}`,
  );
});
client.on("commandSucceeded", (event) => {
  if (!observeCommands) return;
  const name = commandLabels.get(event.requestId) ?? event.commandName;
  commandLabels.delete(event.requestId);
  const list = commandTimings.get(name) ?? [];
  if (list.length < 100_000) list.push(event.duration);
  commandTimings.set(name, list);
});
client.on("commandFailed", (event) => {
  commandLabels.delete(event.requestId);
});
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
class BenchmarkFailure extends Error {}
let live: LiveSource | undefined;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let container: ReturnType<typeof spawn> | undefined;
const containerName = `crewhq-load-${randomUUID()}`;
let interrupted = false;
const stopGenerator = () => {
  interrupted = true;
  container?.kill();
  {
    try {
      execFileSync("docker", ["rm", "--force", containerName], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {}
  }
};
process.once("SIGINT", stopGenerator);
process.once("SIGTERM", stopGenerator);
const report: Record<string, unknown> = {
  runId,
  outcome: "setup_failed",
  profile: {
    users: 100,
    warmupSeconds: 10,
    measuredSeconds: 60,
    thinkingSeconds: 1,
    workload:
      "50/50 people/teams; first page, skill, search and next page; authenticated reset snapshots",
    authentication:
      "100 distinct genuine signed sessions prepared outside timed traffic; external Google consent excluded",
    p95TargetMsExclusive: 200,
    requiredValidRate: 1,
    minimumSamples: 1000,
  },
  environment: {
    scope:
      "loopback, single API process and MongoDB replica set; generator shares this machine",
    node: process.version,
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    freeMemoryBeforeBytes: os.freemem(),
    k6Image: image,
    mongoMaxPoolSize: clientOptions.maxPoolSize,
  },
};
try {
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  report.workingTreeDirty =
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
      .length > 0;
  await client.connect();
  const databases = await client
    .db("admin")
    .admin()
    .listDatabases({ nameOnly: true });
  if (databases.databases.some((database) => database.name === db.databaseName))
    throw new BenchmarkFailure("Generated benchmark database already exists");
  ownedDatabase = true;
  const authSecret = randomBytes(32).toString("base64url"),
    invitationKey = randomBytes(32).toString("base64url");
  const origin = "http://localhost:3000";
  const options = authOptions({
    db,
    client,
    origin,
    secret: authSecret,
    googleClientId: "benchmark.apps.googleusercontent.com",
    googleClientSecret: "isolated-fixture-only",
  });
  const auth = betterAuth(options);
  await auth.$context;
  await ensureDatabaseReady(db, client, options);
  report.dataset = await seedDataset(db);
  report.k6Version = execFileSync("docker", ["run", "--rm", image, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
  report.mongodb = (await db.command({ buildInfo: 1 })).version;
  const journal = await client.db("admin").command({
    getParameter: 1,
    journalCommitInterval: 1,
  });
  const replica = await client.db("admin").command({ replSetGetConfig: 1 });
  report.databaseSettings = {
    journalCommitIntervalMs: journal.journalCommitInterval,
    majorityJournalDefault:
      replica.config.writeConcernMajorityJournalDefault ?? "server-default",
    replicaSetMembers: replica.config.members.length,
  };
  if (replica.config.writeConcernMajorityJournalDefault === false)
    throw new BenchmarkFailure("Majority journal durability must remain enabled");
  // Session issuance is isolated from the served auth instance. No test routes exist on the target.
  const fixtureAuth = betterAuth({
    ...options,
    plugins: [...(options.plugins ?? []), testUtils()],
  });
  const { test: fixtures } = await fixtureAuth.$context;
  const actors = [];
  for (let index = 9_900; index < 10_000; index++) {
    const id = seededUserId(index),
      login = await fixtures.login({ userId: id });
    actors.push({ id, cookie: login.headers.get("cookie")! });
  }
  await observer.connect();
  live = new LiveSource(observer.db(db.databaseName), invitationKey);
  await live.start();
  const diagnostics: Record<string, number> = {};
  const diagnosticLog = pino(
    { level: "warn", base: null },
    {
      write(line: string) {
        try {
          const entry = JSON.parse(line);
          const key = `${entry.msg}:${entry.errorType ?? "unknown"}`;
          diagnostics[key] = (diagnostics[key] ?? 0) + 1;
        } catch {
          /* No raw logs or credentials are retained. */
        }
      },
    },
  );
  const app = createApp({
    db,
    client,
    auth,
    origin,
    invitationKey,
    live,
    logger: diagnosticLog,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new BenchmarkFailure("Benchmark listen address unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Cookie: actors[0]!.cookie,
    "X-Actor-Id": actors[0]!.id,
    "X-Snapshot-Mode": "reset",
  };
  const cursors: Record<string, string> = {};
  for (const kind of ["people", "teams"] as const) {
    const response = await fetch(
      `${baseUrl}/api/events/${(report.dataset as { eventId: string }).eventId}/board?kind=${kind}&limit=20`,
      { headers },
    );
    const body = await response.json();
    if (
      response.status !== 200 ||
      !validBoard(body, (report.dataset as { eventId: string }).eventId, {
        kind,
      }) ||
      !response.headers.get("X-Read-Frontier")
    )
      throw new BenchmarkFailure("Signed board preflight failed");
    cursors[kind] = body.nextCursor;
  }
  const eventId = (report.dataset as { eventId: string }).eventId;
  for (const query of boardQueries(cursors)) {
    const response = await fetch(
      `${baseUrl}/api/events/${eventId}/board?${new URLSearchParams({ ...query, limit: "20" })}`,
      { headers },
    );
    if (
      response.status !== 200 ||
      !validBoard(await response.json(), eventId, query)
    )
      throw new BenchmarkFailure("Board workload preflight failed");
  }
  if ((await fetch(`${baseUrl}/api/events/${eventId}/board`)).status !== 401)
    throw new BenchmarkFailure("Unauthenticated board was not rejected");
  const configFile = path.join(temporary, "sessions.json");
  const dockerUrl =
    process.platform === "linux"
      ? baseUrl
      : `http://host.docker.internal:${address.port}`;
  await writeFile(
    configFile,
    JSON.stringify({
      baseUrl: dockerUrl,
      eventId,
      actors,
      cursors,
    }),
    { mode: 0o600 },
  );
  const commonEnv = [
    "-e",
    "BENCH_SECONDS=60",
    "-e",
    "BENCH_WARMUP=10",
    "-e",
    "BENCH_CONFIG=/run/sessions.json",
    "-e",
    "BENCH_RESULT=/results/k6-summary.json",
  ];
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    ...(process.platform === "linux" ? ["--network", "host"] : []),
    "--user",
    "0",
    "--mount",
    `type=bind,source=${path.resolve("scripts/load")},target=/scripts,readonly`,
    "--mount",
    `type=bind,source=${configFile},target=/run/sessions.json,readonly`,
    "--mount",
    `type=bind,source=${output},target=/results`,
    image,
    "run",
    "--no-usage-report",
    ...commonEnv,
    "/scripts/board.js",
  ];
  if (interrupted)
    throw new BenchmarkFailure("Benchmark interrupted before measurement");
  observeCommands = true;
  eventLoop.enable();
  container = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Drain generator output without publishing host paths or HTTP debug data.
  for (const stream of [container.stdout, container.stderr]) stream?.resume();
  const timer = setTimeout(stopGenerator, 180_000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    container!.once("error", reject);
    container!.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timer));
  report.generatorExitCode = exitCode;
  observeCommands = false;
  eventLoop.disable();
  const summary = JSON.parse(
    await readFile(path.join(output, "k6-summary.json"), "utf8"),
  );
  const { passed, result } = evaluateSummary(summary, exitCode);
  report.result = result;
  report.driverCommands = Object.fromEntries(
    [...commandTimings].map(([name, values]) => {
      values.sort((a, b) => a - b);
      return [
        name,
        {
          count: values.length,
          meanMs: values.reduce((a, b) => a + b, 0) / values.length,
          p95Ms: values[Math.ceil(values.length * 0.95) - 1],
          maxMs: values.at(-1),
        },
      ];
    }),
  );
  checkoutTimings.sort((a, b) => a - b);
  report.connectionPool = {
    peakCheckedOut: peakConnections,
    checkoutFailures,
    checkoutSamples: checkoutTimings.length,
    checkoutP95Ms:
      checkoutTimings[Math.ceil(checkoutTimings.length * 0.95) - 1] ?? null,
    checkoutMaxMs: checkoutTimings.at(-1) ?? null,
  };
  report.eventLoop = {
    meanMs: eventLoop.mean / 1e6,
    p95Ms: eventLoop.percentile(95) / 1e6,
    maxMs: eventLoop.max / 1e6,
  };
  report.diagnostics = diagnostics;
  report.postRunDataset = await verifyDataset(db);
  report.outcome = passed ? "passed" : "failed";
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  report.outcome = "failed";
  report.failure =
    error instanceof BenchmarkFailure
      ? error.message.replace(
          /(?:mongodb(?:\+srv)?|https?):\/\/\S+/g,
          "[endpoint]",
        )
      : "Benchmark setup or validation failed";
  report.failureType = error instanceof Error ? error.name : "unknown";
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stopGenerator);
  process.removeListener("SIGTERM", stopGenerator);
  {
    try {
      execFileSync("docker", ["rm", "--force", containerName], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {}
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await live?.close().catch(() => {});
  await observer.close().catch(() => {});
  assertBenchmarkDatabase(db);
  if (ownedDatabase)
    await db.dropDatabase().catch(() => {
      report.cleanupFailed = true;
      process.exitCode = 1;
    });
  await client.close().catch(() => {
    report.cleanupFailed = true;
    process.exitCode = 1;
  });
  eventLoop.disable();
  if (
    path.dirname(temporary) !== path.resolve(os.tmpdir()) ||
    !path.basename(temporary).startsWith("crewhq-load-")
  )
    throw new BenchmarkFailure("Unsafe ephemeral cleanup target");
  await rm(temporary, { recursive: true, force: true }).catch(() => {
    report.credentialCleanupFailed = true;
    process.exitCode = 1;
  });
  if (report.cleanupFailed || report.credentialCleanupFailed)
    report.outcome = "cleanup_failed";
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      runId,
      outcome: report.outcome,
      result: report.result,
      failure: report.failure,
    }),
  );
}
