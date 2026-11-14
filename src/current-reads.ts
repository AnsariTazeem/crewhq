import type { Db } from "mongodb";
import type { Person, Team } from "./membership.js";

// Current permission decisions stay separate from cached or snapshot projection reads.
const options = {
  readConcern: { level: "linearizable" as const },
  readPreference: "primary" as const,
  maxTimeMS: 1_500,
};
export function currentPerson(
  db: Db,
  scope: { actorId: string; eventId: string },
) {
  return db
    .collection<Person>("people")
    .findOne({ _id: `${scope.eventId}:${scope.actorId}` }, options);
}
export async function currentTeam(db: Db, eventId: string, teamId: string) {
  const team = await db
    .collection<Team>("teams")
    .findOne({ _id: teamId }, options);
  return team?.eventId === eventId ? team : null;
}
