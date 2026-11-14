import { createHmac } from "node:crypto";
import { RateLimiterMongo, RateLimiterRes } from "rate-limiter-flexible";
import type { Db, MongoClient } from "mongodb";

type Limit =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; retryAfter?: number };

export class InviteLimiter {
  private readonly actor;
  private readonly source;
  constructor(
    db: Db,
    client: MongoClient,
    private readonly key: string,
  ) {
    const store = {
      storeClient: client,
      dbName: db.databaseName,
      tableName: "rate_limits",
      duration: 60,
      disableIndexesCreation: true,
    };
    this.actor = new RateLimiterMongo({
      ...store,
      keyPrefix: "invite_actor",
      points: 10,
    });
    this.source = new RateLimiterMongo({
      ...store,
      keyPrefix: "invite_source",
      points: 300,
    });
  }

  async consume(actorId: string, ip: string): Promise<Limit> {
    const source = createHmac("sha256", this.key)
      .update("invite-rate-ip-v1\0")
      .update(ip)
      .digest("hex");
    try {
      await this.actor.consume(actorId);
      await this.source.consume(source);
      return { allowed: true };
    } catch (error) {
      if (error instanceof RateLimiterRes)
        return {
          allowed: false,
          status: 429,
          retryAfter: Math.max(1, Math.ceil(error.msBeforeNext / 1_000)),
        };
      return { allowed: false, status: 503 };
    }
  }
}
