import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  MongoError,
  MongoServerError,
  type ClientSession,
  type Db,
  type MongoClient,
} from "mongodb";
import type { Logger } from "pino";

export type Intent = { actorId: string; eventId: string; key: string };
export type Decision = {
  outcome: "committed" | "rejected";
  status: number;
  code?: string;
  result?: Record<string, unknown>;
};
type Receipt = Intent & {
  _id: string;
  fingerprint: string;
  at: Date;
  decision?: Decision;
};
type Outbox = {
  _id: string;
  eventId: string;
  teamId?: string;
  revision?: number;
  category: "event" | "team";
  at: Date;
  expiresAt: Date;
};
export type CommandReply = { status: number; body: Record<string, unknown> };

export const committed = (
  result: Record<string, unknown>,
  status = 200,
): Decision => ({ outcome: "committed", status, result });
export const rejected = (code: string, status = 409): Decision => ({
  outcome: "rejected",
  status,
  code,
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** One durable intent coordinates the domain transaction and every later retry. */
export class Operations {
  private readonly receipts;
  constructor(
    private readonly db: Db,
    private readonly client: MongoClient,
    private readonly logger?: Pick<Logger, "warn">,
  ) {
    this.receipts = db.collection<Receipt>("operations");
  }

  private id(intent: Intent) {
    return hash(canonical(intent));
  }
  private fault(phase: string, operationId: string, error: unknown) {
    this.logger?.warn(
      {
        operationId,
        phase,
        errorType: error instanceof Error ? error.name : "unknown",
        ...(error instanceof MongoServerError
          ? { databaseCode: error.code }
          : {}),
        ...(error instanceof MongoError ? { labels: error.errorLabels } : {}),
      },
      "transaction diagnostic",
    );
  }
  private async lookup(intent: Intent) {
    return this.receipts.findOne(
      { _id: this.id(intent), ...intent },
      { maxTimeMS: 1_500 },
    );
  }
  private reply(receipt: Receipt, fingerprint?: string): CommandReply {
    if (fingerprint && receipt.fingerprint !== fingerprint) {
      return {
        status: 409,
        body: {
          outcome: "rejected",
          code: "IDEMPOTENCY_KEY_REUSED",
          operationKey: receipt.key,
        },
      };
    }
    if (!receipt.decision) return this.unresolved(receipt.key);
    const { status, ...decision } = receipt.decision;
    return { status, body: { ...decision, operationKey: receipt.key } };
  }
  private unresolved(key: string, status = 202): CommandReply {
    return {
      status,
      body: {
        outcome: "unresolved",
        code: status === 503 ? "STORAGE_UNAVAILABLE" : "OUTCOME_UNRESOLVED",
        operationKey: key,
      },
    };
  }
  async get(intent: Intent): Promise<CommandReply> {
    const receipt = await this.lookup(intent);
    if (!receipt?.decision) return this.unresolved(intent.key);
    return {
      status: 200,
      body: {
        ...this.reply(receipt).body,
        originalStatus: receipt.decision.status,
      },
    };
  }

  async run(
    intent: Intent,
    action: string,
    payload: unknown,
    decide: (session: ClientSession, operationId: string) => Promise<Decision>,
  ): Promise<CommandReply> {
    const fingerprint = hash(canonical({ action, payload }));
    const receiptId = this.id(intent);
    const deadline = performance.now() + 8_000;
    for (
      let attempt = 0;
      attempt < 3 && performance.now() < deadline;
      attempt++
    ) {
      const session = this.client.startSession();
      let commitStarted = false;
      try {
        session.startTransaction({
          readConcern: { level: "snapshot" },
          readPreference: "primary",
          writeConcern: { w: "majority", wtimeoutMS: 1_500 },
          maxCommitTimeMS: 1_500,
        });
        const existing = await this.receipts.findOne(
          { _id: receiptId, ...intent },
          { session },
        );
        if (existing) return this.reply(existing, fingerprint);
        const receipt: Receipt = {
          _id: receiptId,
          ...intent,
          fingerprint,
          at: new Date(),
        };
        await this.receipts.insertOne(receipt, { session });
        const decision = await decide(session, receiptId);
        await this.receipts.updateOne(
          { _id: receiptId },
          { $set: { decision } },
          { session },
        );
        if (performance.now() >= deadline)
          throw new Error("Command work budget exceeded");
        commitStarted = true;
        // Retry uncertain COMMITs only, never the business callback while commit is unknown.
        for (let commitAttempt = 0; commitAttempt < 3; commitAttempt++) {
          try {
            await session.commitTransaction();
            return this.reply({ ...receipt, decision });
          } catch (error) {
            if (
              error instanceof MongoError &&
              error.hasErrorLabel("TransientTransactionError")
            )
              throw error;
            if (
              !(
                error instanceof MongoError &&
                error.hasErrorLabel("UnknownTransactionCommitResult")
              ) ||
              commitAttempt === 2 ||
              performance.now() >= deadline
            )
              throw error;
          }
        }
      } catch (error) {
        this.fault(commitStarted ? "commit" : "work", receiptId, error);
        if (!commitStarted && session.inTransaction())
          await session.abortTransaction().catch((abortError) => {
            this.fault("abort", receiptId, abortError);
          });
        const recovered = await this.lookup(intent).catch((readError) => {
          this.fault("reconcile", receiptId, readError);
          return null;
        });
        if (recovered) return this.reply(recovered, fingerprint);
        const retryable =
          (error instanceof MongoError &&
            error.hasErrorLabel("TransientTransactionError")) ||
          (!commitStarted &&
            error instanceof MongoServerError &&
            error.code === 11000);
        if (retryable && attempt < 2 && performance.now() < deadline) {
          await delay(5 + Math.floor(Math.random() * 20));
          continue;
        }
        return this.unresolved(intent.key, commitStarted ? 202 : 503);
      } finally {
        if (!commitStarted && session.inTransaction())
          await session.abortTransaction().catch((abortError) => {
            this.fault("abort", receiptId, abortError);
          });
        await session.endSession().catch((cleanupError) => {
          this.fault("cleanup", receiptId, cleanupError);
        });
      }
    }
    return this.unresolved(intent.key);
  }

  async publish(
    session: ClientSession,
    operationId: string,
    eventId: string,
    team?: { teamId: string; revision: number },
  ) {
    await this.db.collection<Outbox>("outbox").insertOne(
      {
        _id: operationId,
        eventId,
        category: team ? "team" : "event",
        ...(team ? { teamId: team.teamId, revision: team.revision } : {}),
        at: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      { session },
    );
  }
}
