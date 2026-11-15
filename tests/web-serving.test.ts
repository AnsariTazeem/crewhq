import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { mountWeb } from "../src/web.js";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "crewhq-web-"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>CrewHQ</title>",
  );
});
afterAll(async () => {
  if (
    path.dirname(directory) !== tmpdir() ||
    !path.basename(directory).startsWith("crewhq-web-")
  )
    throw new Error("Unsafe fixture cleanup");
  await rm(directory, { recursive: true });
});
it("serves workspace entries without swallowing missing API or asset routes", async () => {
  const app = express();
  mountWeb(app, directory);
  await request(app).get("/").expect(200);
  const join = await request(app).get("/join?event=example").expect(200);
  expect(join.headers["cache-control"]).toContain("no-store");
  await request(app).get("/api/missing").expect(404);
  await request(app).get("/assets/missing.js").expect(404);
  await request(app).post("/").expect(404);
});

it("serves an index when the application checkout has a hidden parent directory", async () => {
  const hidden = path.join(directory, ".compiled");
  await mkdir(hidden);
  await writeFile(
    path.join(hidden, "index.html"),
    "<!doctype html><title>CrewHQ hidden path</title>",
  );
  const app = express();
  mountWeb(app, hidden);
  await request(app).get("/join").expect(200);
});
