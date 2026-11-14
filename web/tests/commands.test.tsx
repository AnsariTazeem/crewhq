// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCommands } from "../src/commands";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function Control() {
  const commands = useCommands("person-a", "event-a", () => {});
  return (
    <>
      <button
        onClick={() => {
          void commands.run("/teams", { name: "Crew" }, "Create team");
        }}
      >
        Create
      </button>
      <button
        onClick={() => {
          void commands.reconcile(true);
        }}
      >
        Retry
      </button>
      <button
        onClick={() => {
          void commands.reconcile();
        }}
      >
        Check
      </button>
      <p>{commands.pending ? "Unconfirmed" : "No pending action"}</p>
      <p>{commands.notice}</p>
    </>
  );
}
it("retains an uncertain command across reload and retries the same key after status lookup", async () => {
  const requests: { url: string; key: string | null; body?: string }[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({
      url,
      key: new Headers(options?.headers).get("Idempotency-Key"),
      ...(typeof options?.body === "string" ? { body: options.body } : {}),
    });
    if (requests.length === 1) throw new TypeError("Connection lost");
    if (url.includes("/operations/"))
      return new Response(JSON.stringify({ outcome: "unresolved" }), {
        status: 202,
      });
    return new Response(
      JSON.stringify({ outcome: "committed", result: { teamId: "team-a" } }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const first = render(<Control />);
  fireEvent.click(screen.getByText("Create"));
  await screen.findByText("Unconfirmed");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  first.unmount();
  render(<Control />);
  expect(screen.getByText("Unconfirmed")).toBeTruthy();
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByText("No pending action");
  expect(requests.map((r) => r.url)).toEqual([
    "/api/events/event-a/teams",
    `/api/events/event-a/operations/${requests[0]!.key}`,
    "/api/events/event-a/teams",
  ]);
  expect(requests[2]!.key).toBe(requests[0]!.key);
  expect(requests[2]!.body).toBe('{"name":"Crew"}');
});
it("does not persist an invitation credential or report an uncertain response as success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Lost response");
    }),
  );
  function SecretControl() {
    const commands = useCommands("person-b", "event-b", () => {});
    return (
      <>
        <button
          onClick={() => {
            void commands.run(
              "/invitations/redeem",
              { code: "abcdefghijklmnopqrstuv" },
              "Join",
              true,
            );
          }}
        >
          Join
        </button>
        {commands.pending && <p>Unconfirmed secret</p>}
      </>
    );
  }
  render(<SecretControl />);
  fireEvent.click(screen.getByText("Join"));
  await screen.findByText("Unconfirmed secret");
  expect(JSON.stringify(sessionStorage)).not.toContain(
    "abcdefghijklmnopqrstuv",
  );
});
