import { expect, test } from "vitest";
import { evaluateSummary } from "../scripts/load/result.js";

const proof = {
  state: { testRunDurationMs: 70_000 },
  metrics: {
    board_latency: {
      values: { "p(95)": 150 },
      thresholds: { "p(95)<200": { ok: true } },
    },
    "board_latency{kind:people}": {
      values: { "p(95)": 155 },
      thresholds: { "p(95)<200": { ok: true } },
    },
    "board_latency{kind:teams}": {
      values: { "p(95)": 145 },
      thresholds: { "p(95)<200": { ok: true } },
    },
    board_valid: {
      values: { rate: 1 },
      thresholds: { "rate==1": { ok: true } },
    },
    board_samples: {
      values: { count: 5_000 },
      thresholds: { "count>=1000": { ok: true } },
    },
    board_participants: {
      values: { count: 100 },
      thresholds: { "count==100": { ok: true } },
    },
  },
};
test("complete measured board evidence meets the strict target", () => {
  expect(evaluateSummary(proof, 0)).toMatchObject({
    passed: true,
    result: { samples: 5000, participants: 100, requestsPerSecond: 5000 / 60 },
  });
});
test.each([200, 201])(
  "p95 at or above the boundary fails despite a zero generator exit",
  (p95) => {
    const summary = structuredClone(proof);
    summary.metrics.board_latency.values["p(95)"] = p95;
    expect(evaluateSummary(summary, 0).passed).toBe(false);
  },
);
test("zero exit and missing measurement data cannot become passing evidence", () => {
  expect(() => evaluateSummary({}, 0)).toThrow();
});
test("a failed generator exit remains a failure even with apparently passing metrics", () => {
  expect(evaluateSummary(proof, 99).passed).toBe(false);
});
