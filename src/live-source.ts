import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Timestamp,
  type ChangeStream,
  type ChangeStreamInsertDocument,
  type Db,
} from "mongodb";
import { z } from "zod";
import type { Logger } from "pino";

type OutboxEntry = {
  _id: string;
  category: "control" | "event" | "team";
  eventId?: string;
  expiresAt: Date;
};
export type LiveFrame = { generation: string; frontier: string };
type Subscriber = {
  actorId: string;
  eventId: string;
  send: (frame: LiveFrame | null) => void;
};
const payload = z.strictObject({
  v: z.literal(1),
  eventId: z.uuid(),
  generation: z.uuid(),
  t: z.number().int().min(0).max(0xffffffff),
  i: z.number().int().min(0).max(0xffffffff),
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
});
export class LiveError extends Error {
  constructor(
    readonly code: string,
    readonly status = 503,
  ) {
    super(code);
  }
}

/** One observed outbox source serves bounded subscribers in this process. */
export class LiveSource {
  private stream: ChangeStream<OutboxEntry> | undefined;
  private task: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private available = false;
  private lastPoll = 0;
  private head: Timestamp | undefined;
  private generation = randomUUID();
  private readonly subscribers = new Set<Subscriber>();
  private readonly signingKey: Buffer;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  readonly heartbeatMs: number;
  readonly coalesceMs: number;
  constructor(
    private readonly db: Db,
    secret: string,
    private readonly settings: {
      heartbeatMs?: number;
      coalesceMs?: number;
      logger?: Pick<Logger, "warn" | "info">;
    } = {},
  ) {
    this.signingKey = createHmac("sha256", secret)
      .update("crewhq-read-frontier-key-v1\0")
      .update(db.databaseName)
      .digest();
    this.heartbeatMs = settings.heartbeatMs ?? 15_000;
    this.coalesceMs = settings.coalesceMs ?? 250;
  }
  get ready() {
    return (
      this.available &&
      !this.stopped &&
      performance.now() - this.lastPoll < 5_000
    );
  }
  get connections() {
    return this.subscribers.size;
  }

  async start() {
    if (this.started || this.stopped)
      throw new Error("Live source cannot be started twice");
    this.started = true;
    try {
      this.startup = this.bootstrap();
      await this.startup;
      if (this.stopped) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
    } catch (error) {
      await this.stream?.close().catch(() => {});
      throw error;
    }
    this.watchdog = setInterval(() => {
      if (this.available && !this.ready) {
        this.lose();
        void this.stream?.close().catch(() => {});
      }
    }, 1_000);
    this.watchdog.unref();
    this.task = this.observe();
  }
  private advance(at: Timestamp) {
    if (!this.head || at.compare(this.head) > 0) this.head = at;
  }
  private async bootstrap() {
    this.available = false;
    this.generation = randomUUID();
    const outbox = this.db.collection<OutboxEntry>("outbox");
    await outbox.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    if (this.stopped) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
    this.stream = outbox.watch([{ $match: { operationType: "insert" } }], {
      maxAwaitTimeMS: 500,
    });
    const initial = await this.stream.tryNext();
    if (this.stopped) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
    if (initial?.clusterTime) this.advance(initial.clusterTime);
    const markerId = `live:${randomUUID()}`;
    await outbox.insertOne(
      {
        _id: markerId,
        category: "control",
        expiresAt: new Date(Date.now() + 60_000),
      },
      { writeConcern: { w: "majority", wtimeoutMS: 1_500 } },
    );
    const deadline = performance.now() + 5_000;
    while (!this.stopped && performance.now() < deadline) {
      const change = await this.stream.tryNext();
      if (change?.clusterTime) this.advance(change.clusterTime);
      if (
        change?.operationType === "insert" &&
        change.fullDocument._id === markerId
      ) {
        if (!change.clusterTime) throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
        this.lastPoll = performance.now();
        this.available = true;
        this.settings.logger?.info(
          { generation: this.generation },
          "live source ready",
        );
        return;
      }
      if (this.stream.closed) break;
    }
    throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
  }
  private async observe() {
    while (!this.stopped) {
      try {
        while (!this.stopped && this.available) {
          const change = await this.stream!.tryNext();
          this.lastPoll = performance.now();
          if (this.stream!.closed)
            throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
          if (!change || change.operationType !== "insert") continue;
          if (!change.clusterTime)
            throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
          this.advance(change.clusterTime);
          const row = (change as ChangeStreamInsertDocument<OutboxEntry>)
            .fullDocument;
          if (row.category === "control" || !row.eventId) continue;
          for (const subscriber of this.subscribers)
            if (subscriber.eventId === row.eventId)
              subscriber.send(this.frame(row.eventId));
        }
      } catch (error) {
        this.lose(error);
      }
      await this.stream?.close().catch(() => {});
      if (this.stopped) break;
      await delay(250);
      try {
        await this.bootstrap();
      } catch {
        this.lose();
      }
    }
  }
  private lose(error?: unknown) {
    if (this.available && !this.stopped)
      this.settings.logger?.warn(
        {
          errorType: error instanceof Error ? error.name : "SourceUnavailable",
        },
        "live source unavailable",
      );
    this.available = false;
    for (const subscriber of [...this.subscribers]) subscriber.send(null);
  }
  frame(eventId: string): LiveFrame {
    if (!this.ready || !this.head)
      throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
    return {
      generation: this.generation,
      frontier: this.sign(eventId, this.head),
    };
  }
  private sign(eventId: string, at: Timestamp) {
    const now = Date.now();
    const data = Buffer.from(
      JSON.stringify({
        v: 1,
        eventId,
        generation: this.generation,
        t: at.getHighBitsUnsigned(),
        i: at.getLowBitsUnsigned(),
        issuedAt: now,
        expiresAt: now + 600_000,
      }),
    ).toString("base64url");
    return `${data}.${createHmac("sha256", this.signingKey).update(data).digest("base64url")}`;
  }
  minimum(
    eventId: string,
    token?: string,
  ): { at: Timestamp; frame: LiveFrame } {
    if (!this.ready || !this.head)
      throw new LiveError("LIVE_SOURCE_UNAVAILABLE");
    let at = this.head;
    if (token !== undefined) {
      if (
        token.length > 1_024 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
      )
        throw new LiveError("INVALID_READ_FRONTIER", 400);
      const [data, signature] = token.split(".");
      const expected = createHmac("sha256", this.signingKey)
        .update(data!)
        .digest();
      const supplied = Buffer.from(signature!, "base64url");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new LiveError("INVALID_READ_FRONTIER", 400);
      let decoded: z.infer<typeof payload>;
      try {
        decoded = payload.parse(
          JSON.parse(Buffer.from(data!, "base64url").toString("utf8")),
        );
      } catch {
        throw new LiveError("INVALID_READ_FRONTIER", 400);
      }
      if (
        decoded.eventId !== eventId ||
        decoded.issuedAt > Date.now() + 5_000 ||
        decoded.expiresAt - decoded.issuedAt !== 600_000
      )
        throw new LiveError("INVALID_READ_FRONTIER", 400);
      if (decoded.expiresAt <= Date.now())
        throw new LiveError("READ_FRONTIER_EXPIRED", 409);
      const requested = new Timestamp({ t: decoded.t, i: decoded.i });
      if (requested.compare(at) > 0) at = requested;
    }
    return {
      at,
      frame: { generation: this.generation, frontier: this.sign(eventId, at) },
    };
  }
  subscribe(eventId: string, actorId: string, send: Subscriber["send"]) {
    const frame = this.frame(eventId);
    if (
      this.subscribers.size >= 512 ||
      [...this.subscribers].filter((s) => s.actorId === actorId).length >= 2
    )
      throw new LiveError("LIVE_CONNECTION_LIMIT", 429);
    const subscriber = { eventId, actorId, send };
    this.subscribers.add(subscriber);
    return {
      frame,
      close: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }
  async close() {
    this.stopped = true;
    this.lose();
    clearInterval(this.watchdog);
    await this.stream?.close().catch(() => {});
    await this.startup?.catch(() => {});
    await this.task;
    await this.stream?.close().catch(() => {});
  }
}
