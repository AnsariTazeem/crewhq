import type { ClientSession, Db, MongoClient } from "mongodb";
import type { CommandReply } from "./operations.js";
import { LiveError, LiveSource } from "./live-source.js";
import type { Logger } from "pino";

export type ProjectionRead = { session: ClientSession; maxTimeMS: number };

/** Confirm a live minimum and supply a shared snapshot for projection queries. */
export class LiveReads {
  constructor(
    private readonly db: Db,
    private readonly client: MongoClient,
    private readonly source: LiveSource,
    private readonly logger?: Pick<Logger, "warn">,
  ) {}
  async run(
    eventId: string,
    token: string | undefined,
    read: (options: ProjectionRead) => Promise<CommandReply>,
  ) {
    const minimum = this.source.minimum(eventId, token);
    const session = this.client.startSession({ causalConsistency: true });
    try {
      session.advanceOperationTime(minimum.at);
      session.startTransaction({
        readConcern: { level: "snapshot" },
        readPreference: "primary",
        writeConcern: { w: "majority", wtimeoutMS: 1_500 },
        maxCommitTimeMS: 1_500,
      });
      const options = { session, maxTimeMS: 1_500 };
      // The first read fixes a snapshot at or after the required operation time.
      await this.db
        .collection<{ _id: string }>("outbox")
        .findOne({ _id: "read-barrier" }, options);
      const reply = await read(options);
      if (reply.status !== 200) return { reply };
      await session.commitTransaction();
      return { reply, frame: minimum.frame };
    } catch (error) {
      this.logger?.warn(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "live projection could not confirm freshness",
      );
      throw new LiveError("READ_FRESHNESS_UNAVAILABLE");
    } finally {
      if (session.inTransaction())
        await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
  }
}
