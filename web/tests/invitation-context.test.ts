// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureInvitation, clearInvitation } from "../src/invitation-context";
afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});
it("removes credentials from the address bar and retains them only for five minutes in this tab", () => {
  history.replaceState(
    null,
    "",
    "/join?event=event-a#code=abcdefghijklmnopqrstuv",
  );
  expect(captureInvitation("event-a")).toBe("abcdefghijklmnopqrstuv");
  expect(location.hash).toBe("");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 300_001);
  expect(captureInvitation("event-a")).toBe("");
});
it("does not carry another event's invitation into this event", () => {
  history.replaceState(null, "", "/join#code=abcdefghijklmnopqrstuv");
  captureInvitation("event-a");
  expect(captureInvitation("event-b")).toBe("");
  clearInvitation();
  expect(sessionStorage.getItem("crewhq.invitation")).toBeNull();
});
