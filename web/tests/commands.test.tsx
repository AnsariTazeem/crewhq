// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useCommands } from "../src/commands";
import { ApiError, loadIntent, saveIntent } from "../src/api";
beforeEach(() => vi.stubGlobal("crypto", webcrypto));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function Control({ name = "Crew" }: { name?: string }) {
  const commands = useCommands("person-a", "event-a", () => {});
  return (
    <>
      <button
        onClick={() => {
          void commands.run("/teams", { name }, "Create team");
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

it("an unmounted command owner cannot delete a newer recovery record", async () => {
  let complete!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = render(<Control />);
  fireEvent.click(screen.getByText("Create"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  first.unmount();
  const newer = {
    key: "new-operation",
    actorId: "person-a",
    eventId: "event-a",
    path: "/teams",
    label: "New action",
    at: Date.now(),
    body: { name: "New crew" },
  };
  saveIntent(newer);
  render(<Control />);
  await act(async () => complete(new Response('{"outcome":"committed"}')));
  expect(loadIntent("person-a", "event-a")?.key).toBe("new-operation");
  expect(screen.getByText("Unconfirmed")).toBeTruthy();
});

it("a confirmed preflight validation rejection releases the same pending intent", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Lost response"))
    .mockResolvedValueOnce(
      new Response('{"outcome":"unresolved"}', { status: 202 }),
    )
    .mockResolvedValueOnce(
      new Response('{"code":"INVALID_INPUT"}', { status: 400 }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<Control name="" />);
  fireEvent.click(screen.getByText("Create"));
  await screen.findByText("Unconfirmed");
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByText("No pending action");
  expect(loadIntent("person-a", "event-a")).toBeNull();
});

it.each([
  { code: "", terminal: false },
  { code: "abcdefghijklmnopqrstuw", terminal: false },
  { code: "abcdefghijklmnopqrstuv", terminal: true },
])(
  "requires the same secret before retry after reload ($terminal)",
  async ({ code, terminal }) => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockResolvedValueOnce(
        new Response('{"outcome":"unresolved"}', { status: 202 }),
      )
      .mockResolvedValueOnce(new Response('{"outcome":"committed"}'));
    vi.stubGlobal("fetch", fetcher);
    function SecretControl() {
      const c = useCommands("person-a", "event-a", () => {});
      return (
        <>
          <button
            onClick={() => {
              void c.run(
                "/invitations/redeem",
                { code: "abcdefghijklmnopqrstuv" },
                "Join",
                true,
              );
            }}
          >
            Start
          </button>
          <button
            onClick={() => {
              void c.reconcile(true, code);
            }}
          >
            Retry secret
          </button>
          <p>{c.pending ? "Unconfirmed" : "Finished"}</p>
          {c.error instanceof ApiError && <p>{c.error.code}</p>}
          <p>{c.notice}</p>
        </>
      );
    }
    const first = render(<SecretControl />);
    fireEvent.click(screen.getByText("Start"));
    await screen.findByText("Unconfirmed");
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const original = loadIntent("person-a", "event-a")!;
    if (code) {
      first.unmount();
      render(<SecretControl />);
    }
    fireEvent.click(screen.getByText("Retry secret"));
    if (terminal) {
      await screen.findByText("Finished");
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(
        new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("Idempotency-Key"),
      ).toBe(original.key);
    } else {
      if (code) await screen.findByText("CREDENTIAL_MISMATCH");
      else
        await screen.findByText(
          "Re-enter the original invitation code to retry this same action, or check its status again.",
        );
      expect(screen.getByText("Unconfirmed")).toBeTruthy();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  },
);
