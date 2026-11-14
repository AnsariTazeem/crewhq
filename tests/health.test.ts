import request from "supertest";
import { expect, test } from "vitest";
import { createApp } from "../src/app.js";

test("liveness responds without exposing configuration or requiring database access", async () => {
  const response = await request(createApp()).get("/health/live");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "alive" });
});
