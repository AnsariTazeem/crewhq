import { expect, it, vi } from "vitest";
import { LiveConnection } from "../src/live";

it("treats reconnect as a reset and ignores frames from a closed connection", () => {
  const sources: {
    handlers: Map<string, (event: { data: string }) => void>;
    close: ReturnType<typeof vi.fn>;
    onerror: (() => void) | null;
  }[] = [];
  const open = () => {
    const source = {
      handlers: new Map(),
      close: vi.fn(),
      onerror: null as (() => void) | null,
    };
    sources.push(source);
    return {
      ...source,
      addEventListener: (name: string, fn: (event: { data: string }) => void) =>
        source.handlers.set(name, fn),
      set onerror(value: (() => void) | null) {
        source.onerror = value;
      },
    } as unknown as EventSource;
  };
  const live = new LiveConnection("event", open);
  const stop = live.start();
  const frame = { generation: "g1", frontier: "f1" };
  sources[0]!.handlers.get("ready")!({ data: JSON.stringify(frame) });
  expect(live.getSnapshot()).toMatchObject({
    phase: "connected",
    frontier: "f1",
    reset: 1,
  });
  live.recover();
  expect(live.getSnapshot()).toMatchObject({ reset: 2 });
  stop();
  sources[0]!.handlers.get("refresh")!({
    data: JSON.stringify({ generation: "g1", frontier: "late" }),
  });
  expect(live.getSnapshot().frontier).toBe("f1");
  expect(sources[0]!.close).toHaveBeenCalledOnce();
});
