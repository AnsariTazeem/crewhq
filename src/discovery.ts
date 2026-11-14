import type { Db } from "mongodb";
import type { z } from "zod";
import type { Person, Team, Event } from "./membership.js";
import {
  Operations,
  committed,
  rejected,
  type Intent,
  type CommandReply,
} from "./operations.js";
import { profileInput, publicProfile } from "./profiles.js";
import { currentPerson } from "./current-reads.js";
import type { ProjectionRead } from "./live-reads.js";

type Scope = Pick<Intent, "actorId" | "eventId">;
export type BoardQuery = {
  kind: "people" | "teams";
  limit: number;
  after?: string | undefined;
  skill?: string | undefined;
  search?: string | undefined;
};
export class Discovery {
  constructor(
    private readonly db: Db,
    private readonly operations: Operations,
  ) {}

  async getProfile(scope: Scope): Promise<CommandReply> {
    const person = await currentPerson(this.db, scope);
    if (!person) return { status: 403, body: { code: "NOT_ENROLLED" } };
    return {
      status: 200,
      body: {
        ...publicProfile(person.profile, person.displayName ?? "Participant"),
        profileRevision: person.profile?.profileRevision ?? 0,
      },
    };
  }

  async board(
    scope: Scope,
    query: BoardQuery,
    read?: ProjectionRead,
  ): Promise<CommandReply> {
    if (!(await currentPerson(this.db, scope)))
      return { status: 403, body: { code: "NOT_ENROLLED" } };
    const event = await this.db
      .collection<Event>("events")
      .findOne({ _id: scope.eventId }, { ...read, maxTimeMS: 1_500 });
    if (!event) return { status: 404, body: { code: "EVENT_NOT_FOUND" } };
    const admissionsOpen = event.admissionClosesAt > new Date();
    const regex = query.search
      ? {
          $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        }
      : undefined;
    let items: Record<string, unknown>[];
    let nextCursor: string | null;
    if (query.kind === "people") {
      const people = await this.db
        .collection<Person>("people")
        .find(
          {
            eventId: scope.eventId,
            teamId: null,
            ...(query.after ? { userId: { $gt: query.after } } : {}),
            ...(query.skill ? { "profile.offeredSkills": query.skill } : {}),
            ...(regex
              ? {
                  $or: [
                    { "profile.displayName": regex },
                    { profile: { $exists: false }, displayName: regex },
                  ],
                }
              : {}),
          },
          {
            ...read,
            projection: { userId: 1, displayName: 1, profile: 1 },
            maxTimeMS: 1_500,
          },
        )
        .sort({ userId: 1 })
        .limit(query.limit + 1)
        .toArray();
      const page = people.slice(0, query.limit);
      nextCursor = people.length > query.limit ? page.at(-1)!.userId : null;
      items = page.map((person) => ({
        id: person.userId,
        ...publicProfile(person.profile, person.displayName ?? "Participant"),
      }));
    } else {
      const teams = admissionsOpen
        ? await this.db
            .collection<Team>("teams")
            .find(
              {
                eventId: scope.eventId,
                state: "active",
                frozen: false,
                $expr: { $lt: [{ $size: "$members" }, "$maxSize"] },
                ...(query.after ? { _id: { $gt: query.after } } : {}),
                ...(query.skill ? { wantedSkills: query.skill } : {}),
                ...(regex ? { name: regex } : {}),
              },
              {
                ...read,
                projection: {
                  name: 1,
                  leaderId: 1,
                  members: 1,
                  minSize: 1,
                  maxSize: 1,
                  revision: 1,
                  wantedSkills: 1,
                },
                maxTimeMS: 1_500,
              },
            )
            .sort({ _id: 1 })
            .limit(query.limit + 1)
            .toArray()
        : [];
      const page = teams.slice(0, query.limit);
      nextCursor = teams.length > query.limit ? page.at(-1)!._id : null;
      items = page.map((team) => ({
        id: team._id,
        name: team.name,
        leaderId: team.leaderId,
        memberCount: team.members.length,
        minSize: team.minSize,
        maxSize: team.maxSize,
        sizeEligible: team.members.length >= team.minSize,
        revision: team.revision,
        wantedSkills: team.wantedSkills ?? [],
      }));
    }
    return {
      status: 200,
      body: {
        eventId: scope.eventId,
        kind: query.kind,
        items,
        nextCursor,
        admissionsOpen,
      },
    };
  }

  saveProfile(intent: Intent, input: z.output<typeof profileInput>) {
    return this.operations.run(
      intent,
      "save-profile",
      input,
      async (session, operationId) => {
        const people = this.db.collection<Person>("people");
        const person = await people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        if (!person) return rejected("NOT_ENROLLED", 403);
        if ((person.profile?.profileRevision ?? 0) !== input.expectedRevision)
          return rejected("PROFILE_CHANGED");
        const { expectedRevision, ...fields } = input;
        const profileRevision = expectedRevision + 1;
        const result = await people.updateOne(
          { _id: person._id, revision: person.revision },
          {
            $set: { profile: { ...fields, profileRevision } },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1)
          throw new Error("Profile guard did not advance");
        await this.operations.publish(session, operationId, intent.eventId);
        return committed({
          participantId: intent.actorId,
          eventId: intent.eventId,
          profileRevision,
        });
      },
    );
  }
}
