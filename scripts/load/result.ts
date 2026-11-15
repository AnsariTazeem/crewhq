import { z } from "zod";
const schema = z.object({
  state: z.object({ testRunDurationMs: z.number().positive() }),
  metrics: z.record(
    z.string(),
    z.object({
      values: z.record(z.string(), z.number()),
      thresholds: z
        .record(z.string(), z.object({ ok: z.boolean() }))
        .optional(),
    }),
  ),
});
export function evaluateSummary(raw: unknown, exitCode: number) {
  const { metrics, state } = schema.parse(raw);
  const samples = metrics.board_samples?.values.count ?? 0;
  const validRate = metrics.board_valid?.values.rate ?? 0;
  const p95Ms = metrics.board_latency?.values["p(95)"];
  const participants = metrics.board_participants?.values.count ?? 0;
  const measuredElapsedSeconds = (state.testRunDurationMs - 10_000) / 1000;
  const required: Record<string, string> = {
    board_latency: "p(95)<200",
    "board_latency{kind:people}": "p(95)<200",
    "board_latency{kind:teams}": "p(95)<200",
    board_valid: "rate==1",
    board_samples: "count>=1000",
    board_participants: "count==100",
  };
  const thresholdsPass = Object.entries(required).every(
    ([name, threshold]) => metrics[name]?.thresholds?.[threshold]?.ok === true,
  );
  const people = metrics["board_latency{kind:people}"]?.values;
  const teams = metrics["board_latency{kind:teams}"]?.values;
  const passed =
    exitCode === 0 &&
    thresholdsPass &&
    p95Ms !== undefined &&
    p95Ms < 200 &&
    (people?.["p(95)"] ?? Infinity) < 200 &&
    (teams?.["p(95)"] ?? Infinity) < 200 &&
    validRate === 1 &&
    samples >= 1000 &&
    participants === 100 &&
    measuredElapsedSeconds >= 60;
  return {
    passed,
    result: {
      samples,
      validRate,
      p95Ms: p95Ms ?? null,
      participants,
      measuredElapsedSeconds,
      requestsPerSecond:
        measuredElapsedSeconds > 0 ? samples / measuredElapsedSeconds : 0,
      people,
      teams,
    },
  };
}
