import { EventEmitter } from "node:events";

export async function connectLive(url: string, cookie: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  const frames: { event: string; data: Record<string, unknown> }[] = [];
  const changes = new EventEmitter();
  let ended = false;
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder
          .decode(chunk, { stream: true })
          .replaceAll("\r\n", "\n");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
          if (frames.length > 100)
            throw new Error("Unexpected unbounded test stream");
          changes.emit("change");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) changes.emit("streamFailure", error);
    } finally {
      ended = true;
      changes.emit("change");
    }
  })();
  return {
    response,
    async next(
      event: string,
      timeoutMs = 5_000,
    ): Promise<Record<string, unknown>> {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const found = frames.findIndex((frame) => frame.event === event);
        if (found >= 0) return frames.splice(found, 1)[0]!.data;
        if (ended) throw new Error(`Stream ended while waiting for ${event}`);
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            clearTimeout(timer);
            changes.off("change", onChange);
            changes.off("streamFailure", onFailure);
            error ? reject(error) : resolve();
          };
          const onChange = () => finish();
          const onFailure = (error: unknown) => finish(error);
          const timer = setTimeout(
            () => finish(new Error(`Timed out waiting for ${event}`)),
            Math.max(1, deadline - performance.now()),
          );
          changes.once("change", onChange);
          changes.once("streamFailure", onFailure);
        });
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}
