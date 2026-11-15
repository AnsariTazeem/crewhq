// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LiveConnection } from "../src/live";
import { LiveContext, useQuery } from "../src/queries";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("does not apply an older snapshot when a newer hint arrives during the read", async () => {
  const handlers = new Map<string, (event: { data: string }) => void>();
  const live = new LiveConnection(
    "event",
    () =>
      ({
        addEventListener: (
          name: string,
          callback: (event: { data: string }) => void,
        ) => handlers.set(name, callback),
        close: () => {},
      }) as unknown as EventSource,
  );
  const stop = live.start();
  handlers.get("ready")!({
    data: JSON.stringify({ generation: "g1", frontier: "first" }),
  });
  const requests: {
    frontier: string | null;
    resolve: (value: Response) => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve) =>
          requests.push({
            frontier: new Headers(options.headers).get("X-Read-Frontier"),
            resolve,
          }),
        ),
    ),
  );
  function View() {
    const query = useQuery<{ name: string }>("/events/event/board");
    return <p>{query.data?.name ?? "Loading"}</p>;
  }
  render(
    <LiveContext.Provider value={live}>
      <View />
    </LiveContext.Provider>,
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() =>
    handlers.get("refresh")!({
      data: JSON.stringify({ generation: "g1", frontier: "newer" }),
    }),
  );
  await act(async () =>
    requests[0]!.resolve(
      new Response(JSON.stringify({ name: "Old snapshot" }), {
        headers: { "X-Read-Frontier": "first" },
      }),
    ),
  );
  expect(screen.queryByText("Old snapshot")).toBeNull();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]!.frontier).toBe("newer");
  await act(async () =>
    requests[1]!.resolve(
      new Response(JSON.stringify({ name: "Current snapshot" }), {
        headers: { "X-Read-Frontier": "newer" },
      }),
    ),
  );
  expect(screen.getByText("Current snapshot")).toBeTruthy();
  stop();
});

it("a successful snapshot remains usable while the live transport reconnects", async () => {
  const handlers = new Map<string, (event: { data: string }) => void>();
  const source = {
    addEventListener: (
      name: string,
      callback: (event: { data: string }) => void,
    ) => handlers.set(name, callback),
    close: () => {},
    onerror: null as (() => void) | null,
  };
  const live = new LiveConnection(
    "event",
    () => source as unknown as EventSource,
  );
  const stop = live.start();
  handlers.get("ready")!({
    data: JSON.stringify({ generation: "g1", frontier: "floor" }),
  });
  const fetcher = vi.fn(
    async () =>
      new Response('{"name":"Current"}', {
        headers: { "X-Read-Frontier": "floor" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  function View() {
    const query = useQuery<{ name: string }>("/events/event/me");
    return <p>{query.data && !query.stale ? "Usable snapshot" : "Updating"}</p>;
  }
  render(
    <LiveContext.Provider value={live}>
      <View />
    </LiveContext.Provider>,
  );
  await screen.findByText("Usable snapshot");
  act(() => source.onerror!());
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(live.getSnapshot().phase).toBe("reconnecting");
  expect(await screen.findByText("Usable snapshot")).toBeTruthy();
  stop();
});

it("repairs an expired read frontier even while the event source is suspended", async () => {
  const handlers = new Map<string, (event: { data: string }) => void>();
  const live = new LiveConnection(
    "event",
    () =>
      ({
        addEventListener: (
          name: string,
          callback: (event: { data: string }) => void,
        ) => handlers.set(name, callback),
        close: () => {},
      }) as unknown as EventSource,
  );
  const stop = live.start();
  handlers.get("ready")!({
    data: JSON.stringify({ generation: "g1", frontier: "expired" }),
  });
  stop();
  const fetcher = vi.fn(async (_url: string, options: RequestInit) =>
    new Headers(options.headers).has("X-Read-Frontier")
      ? new Response('{"code":"READ_FRONTIER_EXPIRED"}', { status: 400 })
      : new Response('{"name":"Recovered snapshot"}'),
  );
  vi.stubGlobal("fetch", fetcher);
  function View() {
    const query = useQuery<{ name: string }>("/events/event/me");
    return <p>{query.data?.name ?? "Updating"}</p>;
  }
  render(
    <LiveContext.Provider value={live}>
      <View />
    </LiveContext.Provider>,
  );
  await screen.findByText("Recovered snapshot");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(live.getSnapshot().frontier).toBeNull();
});
