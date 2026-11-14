import type { Response } from "express";
import { LiveSource, type LiveFrame } from "./live-source.js";

export function openLive(
  response: Response,
  source: LiveSource,
  eventId: string,
  actorId: string,
  expiresAt: Date,
  authorize: () => Promise<void>,
) {
  let closed = false,
    busy = false;
  let pending: LiveFrame | null = null;
  let pingPending = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let release = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(scheduled);
    clearTimeout(expiry);
    clearInterval(heartbeat);
    release();
  };
  const reset = () => {
    if (closed) return;
    cleanup();
    response.end('event: reset\ndata: {"reason":"REFRESH_REQUIRED"}\n\n');
    const kill = setTimeout(() => response.destroy(), 250);
    kill.unref();
    response.once("close", () => clearTimeout(kill));
  };
  const write = (data: string) => {
    if (closed) return;
    if (!response.write(data)) reset();
  };
  const flush = async (ping = false) => {
    if (ping) pingPending = true;
    if (closed || busy) return;
    busy = true;
    try {
      if (!source.ready) {
        reset();
        return;
      }
      await authorize();
      if (closed || !source.ready) {
        reset();
        return;
      }
      const frame = pending;
      pending = null;
      const heartbeatDue = pingPending;
      pingPending = false;
      if (frame) write(`event: refresh\ndata: ${JSON.stringify(frame)}\n\n`);
      if (heartbeatDue) write(": heartbeat\n\n");
    } catch {
      reset();
    } finally {
      busy = false;
      if ((pending || pingPending) && !closed && !scheduled)
        scheduled = setTimeout(() => {
          scheduled = undefined;
          void flush();
        }, source.coalesceMs);
    }
  };
  const subscription = source.subscribe(eventId, actorId, (frame) => {
    if (!frame) {
      reset();
      return;
    }
    pending = frame;
    if (!scheduled)
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void flush();
      }, source.coalesceMs);
  });
  release = subscription.close;
  response.once("close", cleanup);
  response.once("error", () => {
    cleanup();
    response.destroy();
  });
  if (response.destroyed) {
    cleanup();
    return;
  }
  response.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  write(
    `retry: 1000\nevent: ready\ndata: ${JSON.stringify(subscription.frame)}\n\n`,
  );
  if (closed) return;
  heartbeat = setInterval(() => void flush(true), source.heartbeatMs);
  heartbeat.unref();
  expiry = setTimeout(reset, Math.max(0, expiresAt.getTime() - Date.now()));
  expiry.unref();
}
