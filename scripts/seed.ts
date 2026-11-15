import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { randomBytes } from "node:crypto";
import { authOptions } from "../src/auth.js";
import { ensureDatabaseReady } from "../src/database.js";
import {
  seedDataset,
  assertBenchmarkDatabase,
  checkSeedTarget,
} from "./seed-data.js";

const { values } = parseArgs({ options: { database: { type: "string" } } });
if (!values.database)
  throw new Error(
    "Specify --database h4h_bench_<name>; existing application databases are never reset",
  );
const client = new MongoClient(
  process.env.TEST_MONGODB_URI ??
    "mongodb://127.0.0.1:27027/?replicaSet=rs0&directConnection=true",
);
const db = client.db(values.database);
assertBenchmarkDatabase(db);
try {
  await client.connect();
  await checkSeedTarget(db);
  const options = authOptions({
    db,
    client,
    origin: "http://localhost:3000",
    secret: randomBytes(32).toString("base64url"),
    googleClientId: "seed.apps.googleusercontent.com",
    googleClientSecret: "schema-only",
  });
  await ensureDatabaseReady(db, client, options);
  console.log(JSON.stringify(await seedDataset(db), null, 2));
} finally {
  await client.close();
}
