import http from "k6/http";
import { sleep } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { validBoard, boardQueries } from "./contract.js";

const config = JSON.parse(open(__ENV.BENCH_CONFIG));
const duration = Number(__ENV.BENCH_SECONDS ?? 60);
const warmup = Number(__ENV.BENCH_WARMUP ?? 10);
if (
  new Set(config.actors.map((actor) => actor.id)).size !== 100 ||
  new Set(config.actors.map((actor) => actor.cookie)).size !== 100 ||
  config.actors.length !== 100 ||
  duration < 60 ||
  warmup < 10
)
  throw new Error(
    "The board proof requires 100 signed actors, at least 10s warm-up and 60s measurement",
  );
const latency = new Trend("board_latency", true);
const valid = new Rate("board_valid");
const samples = new Counter("board_samples");
const participants = new Counter("board_participants");
const queries = boardQueries(config.cursors);
let seen = false;
export const options = {
  scenarios: {
    warmup: {
      executor: "constant-vus",
      vus: 100,
      duration: `${warmup}s`,
      gracefulStop: "0s",
      exec: "warm",
    },
    board: {
      executor: "constant-vus",
      vus: 100,
      duration: `${duration}s`,
      startTime: `${warmup}s`,
      gracefulStop: "5s",
      exec: "measure",
    },
  },
  thresholds: {
    board_latency: ["p(95)<200"],
    "board_latency{kind:people}": ["p(95)<200"],
    "board_latency{kind:teams}": ["p(95)<200"],
    board_valid: ["rate==1"],
    board_samples: ["count>=1000"],
    board_participants: ["count==100"],
  },
  summaryTrendStats: [
    "min",
    "avg",
    "med",
    "max",
    "p(90)",
    "p(95)",
    "p(99)",
    "count",
  ],
  systemTags: ["status", "method", "name", "scenario", "expected_response"],
};
function visit(measured) {
  const slot = (exec.vu.idInTest - 1) % 100;
  const actor = config.actors[slot];
  const query = queries[(slot + exec.vu.iterationInScenario) % queries.length];
  const params = Object.entries({ ...query, limit: 20 })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const response = http.get(
    `${config.baseUrl}/api/events/${config.eventId}/board?${params}`,
    {
      headers: {
        Cookie: actor.cookie,
        "X-Actor-Id": actor.id,
        "X-Snapshot-Mode": "reset",
      },
      timeout: "12s",
      redirects: 0,
      tags: { name: `board-${query.kind}` },
    },
  );
  let correct = false;
  try {
    correct =
      response.status === 200 &&
      validBoard(response.json(), config.eventId, query) &&
      !!response.headers["X-Read-Frontier"];
  } catch {
    /* Invalid JSON is a failed response. */
  }
  if (measured) {
    latency.add(response.timings.duration, { kind: query.kind });
    valid.add(correct);
    samples.add(1);
    if (!seen) {
      participants.add(1);
      seen = true;
    }
  }
  sleep(1);
}
export function warm() {
  visit(false);
}
export function measure() {
  visit(true);
}
export function handleSummary(data) {
  return {
    [__ENV.BENCH_RESULT]: JSON.stringify(data, null, 2),
    stdout:
      JSON.stringify({
        latency: data.metrics.board_latency?.values,
        valid: data.metrics.board_valid?.values,
        samples: data.metrics.board_samples?.values,
        participants: data.metrics.board_participants?.values,
      }) + "\n",
  };
}
