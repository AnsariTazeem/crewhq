import { afterEach, expect, it, vi } from "vitest";
import { read } from "../src/api";
afterEach(() => vi.unstubAllGlobals());
it("recovers a transient safe-read failure with bounded retries", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"code":"STORAGE_UNAVAILABLE"}', { status: 503 }),
    )
    .mockResolvedValueOnce(new Response('{"name":"Recovered"}'));
  vi.stubGlobal("fetch", fetcher);
  expect(await read("/events/example")).toEqual({ name: "Recovered" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not retry authorization failures", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response('{"code":"UNAUTHENTICATED"}', { status: 401 }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(read("/me")).rejects.toMatchObject({ status: 401 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
