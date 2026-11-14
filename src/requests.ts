import type { Db, Document } from "mongodb";
import type { ProjectionRead } from "./live-reads.js";

export type JoinRequest = {
  _id: string;
  eventId: string;
  teamId: string;
  applicantId: string;
  personId: string;
  epoch: number;
  state: "pending" | "accepted" | "declined" | "withdrawn";
  at: Date;
  resolvedAt?: Date;
};

/** Resolve eligibility before filtering/pagination; no cleanup worker owns correctness. */
export async function requestPage(
  db: Db,
  scope: { eventId: string; applicantId?: string; teamId?: string },
  admissionClosesAt: Date,
  options: {
    limit: number;
    after?: string | undefined;
    state: "all" | "pending";
  },
  read?: ProjectionRead,
) {
  const pipeline: Document[] = [
    {
      $match: {
        ...scope,
        ...(options.after ? { _id: { $gt: options.after } } : {}),
      },
    },
    { $sort: { _id: 1 } },
    {
      $lookup: {
        from: "people",
        localField: "personId",
        foreignField: "_id",
        as: "person",
      },
    },
    { $unwind: "$person" },
    {
      $lookup: {
        from: "teams",
        localField: "teamId",
        foreignField: "_id",
        as: "team",
      },
    },
    { $unwind: "$team" },
    {
      $set: {
        reason: {
          $switch: {
            branches: [
              { case: { $ne: ["$state", "pending"] }, then: null },
              {
                case: {
                  $or: [
                    { $ne: ["$epoch", "$person.membershipEpoch"] },
                    { $ne: ["$person.teamId", null] },
                  ],
                },
                then: "REQUEST_CANCELLED",
              },
              {
                case: {
                  $ne: ["$team.state", "active"],
                },
                then: "TEAM_DELETED",
              },
              { case: "$team.frozen", then: "ROSTER_FROZEN" },
              {
                case: { $lte: [admissionClosesAt, new Date()] },
                then: "ADMISSIONS_CLOSED",
              },
            ],
            default: null,
          },
        },
      },
    },
    {
      $set: {
        status: {
          $cond: [
            { $ne: ["$state", "pending"] },
            "$state",
            {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$reason", "REQUEST_CANCELLED"] },
                    then: "cancelled",
                  },
                  { case: { $ne: ["$reason", null] }, then: "unavailable" },
                ],
                default: "pending",
              },
            },
          ],
        },
      },
    },
    ...(options.state === "pending" ? [{ $match: { status: "pending" } }] : []),
    { $limit: options.limit + 1 },
    {
      $project: {
        _id: 0,
        id: "$_id",
        teamId: 1,
        applicantId: 1,
        status: 1,
        reason: 1,
        at: 1,
        resolvedAt: 1,
      },
    },
  ];
  const items = await db
    .collection<JoinRequest>("requests")
    .aggregate<{
      id: string;
      teamId: string;
      applicantId: string;
      status: string;
      at: Date;
    }>(
      pipeline,
      read ?? { readConcern: { level: "snapshot" }, maxTimeMS: 1_500 },
    )
    .toArray();
  const page = items.slice(0, options.limit);
  return {
    items: page,
    nextCursor: items.length > options.limit ? page.at(-1)!.id : null,
  };
}
