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
