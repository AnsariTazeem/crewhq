import request from "supertest";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "./support/harness.js";

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness();
});
afterAll(async () => {
  await harness?.close();
});

test("a real signed session identifies only its participant's safe identity", async () => {
  const person = await harness.person("Ada");
  const response = await request(harness.app)
    .get("/api/me")
    .set("Cookie", person.cookie);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ id: person.id, name: "Ada" });
});

test("the browser session endpoint never exposes its session credential", async () => {
  const person = await harness.person("Grace");
  const response = await request(harness.app)
    .get("/api/auth/get-session")
    .set("Cookie", person.cookie);
  expect(response.status).toBe(200);
  expect(response.body.session).not.toHaveProperty("token");
});
