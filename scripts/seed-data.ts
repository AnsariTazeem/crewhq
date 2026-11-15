import { createHash } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { Event, Person, Team } from "../src/membership.js";
import { skillCatalog } from "../src/skill-catalog.js";

const version = "board-dataset-v1";
export const seedEventId = "d124631b-0d2f-46a4-9027-15ebf9c737c7";
const zones = [
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "Asia/Singapore",
  "Australia/Sydney",
  "Asia/Kathmandu",
];
const digest = (kind: string, index: number) =>
  createHash("sha256").update(`${version}:${kind}:${index}`).digest("hex");
export const seededUserId = (index: number) =>
  digest("user", index).slice(0, 24);
const teamId = (index: number) => {
  const hex = digest("team", index);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export function assertBenchmarkDatabase(db: Db) {
  if (!/^h4h_bench_[A-Za-z0-9_-]{1,32}$/.test(db.databaseName))
    throw new Error(
      "An isolated benchmark database named h4h_bench_<name> is required",
    );
}

export async function verifyDataset(db: Db) {
  assertBenchmarkDatabase(db);
  const [users, people, teams, unteamed, recruiting, incomplete] =
    await Promise.all([
      db.collection("user").countDocuments(),
      db.collection("people").countDocuments(),
      db.collection("teams").countDocuments(),
      db.collection("people").countDocuments({ teamId: null }),
      db.collection("teams").countDocuments({
        $expr: { $lt: [{ $size: "$members" }, "$maxSize"] },
      }),
      db.collection("teams").countDocuments({
        $expr: { $lt: [{ $size: "$members" }, "$minSize"] },
      }),
    ]);
  if (
    users !== 10_000 ||
    people !== 10_000 ||
    teams !== 2_000 ||
    unteamed !== 5_000 ||
    recruiting !== 1_500 ||
    incomplete !== 500
  )
    throw new Error("Seed counts differ from the declared dataset");
  const [identities, participants, rosters] = await Promise.all([
    db
      .collection("user")
      .find({}, { projection: { _id: 1 } })
      .toArray(),
    db
      .collection<Person>("people")
      .find({}, { projection: { _id: 1, eventId: 1, userId: 1, teamId: 1 } })
      .toArray(),
    db.collection<Team>("teams").find({}).toArray(),
  ]);
  const userIds = new Set(identities.map((user) => String(user._id)));
  const participantById = new Map(
    participants.map((person) => [person.userId, person]),
  );
  const teamById = new Map(rosters.map((team) => [team._id, team]));
  let valid = participantById.size === people;
  for (const person of participants) {
    valid &&=
      person.eventId === seedEventId &&
      person._id === seedEventId + ":" + person.userId &&
      userIds.has(person.userId);
    if (person.teamId)
      valid &&=
        teamById.get(person.teamId)?.members.includes(person.userId) === true;
  }
  for (const team of rosters) {
    valid &&=
      team.eventId === seedEventId &&
      team.state === "active" &&
      team.members.length >= 1 &&
      team.members.length <= team.maxSize &&
      team.members.includes(team.leaderId!) &&
      new Set(team.members).size === team.members.length;
    for (const userId of team.members)
      valid &&= participantById.get(userId)?.teamId === team._id;
  }
  if (!valid) throw new Error("Seed membership invariants failed");
  return {
    version,
    eventId: seedEventId,
    users,
    people,
    teams,
    unteamed,
    recruiting,
    incomplete,
  };
}

/** Read-only ownership check; call before initializing indexes or TTL policies. */
export async function checkSeedTarget(db: Db) {
  assertBenchmarkDatabase(db);
  const marker = await db
    .collection<{ _id: string; complete: boolean }>("seed_manifest")
    .findOne({ _id: version });
  if (marker?.complete) return true;
  for (const { name } of await db
    .listCollections({}, { nameOnly: true })
    .toArray()) {
    if (await db.collection(name).findOne())
      throw new Error(
        "Benchmark database is not empty; refusing to overwrite data",
      );
  }
  return false;
}

/** Append-only bootstrap of synthetic data; never resets an existing database. */
export async function seedDataset(db: Db) {
  if (await checkSeedTarget(db)) return verifyDataset(db);
  await db
    .collection<{ _id: string; complete: boolean }>("seed_manifest")
    .insertOne({ _id: version, complete: false });
  const now = new Date();
  const people: Person[] = Array.from({ length: 10_000 }, (_, index) => {
    const userId = seededUserId(index);
    const displayName = `Participant ${String(index).padStart(5, "0")}`;
    const missing = index % 10 === 0;
    return {
      _id: `${seedEventId}:${userId}`,
      eventId: seedEventId,
      userId,
      teamId: null,
      membershipEpoch: 0,
      revision: 1,
      displayName,
      profile: {
        profileRevision: 1,
        displayName,
        bio: "Synthetic participant for board verification.",
        offeredSkills: missing
          ? []
          : [
              skillCatalog[index % skillCatalog.length]!,
              skillCatalog[(index + 7) % skillCatalog.length]!,
            ].sort(),
        wantedSkills: [skillCatalog[(index + 3) % skillCatalog.length]!],
        timeZone: missing ? null : zones[index % zones.length]!,
      },
    };
  });
  let assigned = 0;
  const teams: Team[] = Array.from({ length: 2_000 }, (_, index) => {
    const id = teamId(index),
      size = (index % 4) + 1;
    const members = people.slice(assigned, assigned + size).map((person) => {
      person.teamId = id;
      person.membershipEpoch = 1;
      return person.userId;
    });
    assigned += size;
    return {
      _id: id,
      eventId: seedEventId,
      name: `Crew ${String(index).padStart(4, "0")}`,
      leaderId: members[0]!,
      members,
      minSize: 2,
      maxSize: 4,
      revision: 1,
      frozen: false,
      state: "active",
      wantedSkills: [skillCatalog[index % skillCatalog.length]!],
    };
  });
  await db.collection("user").insertMany(
    people.map((person, index) => ({
      _id: new ObjectId(person.userId),
      name: person.displayName!,
      email: `participant-${index}@example.test`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.collection<Person>("people").insertMany(people);
  await db.collection<Team>("teams").insertMany(teams);
  await db.collection<Event>("events").insertOne({
    _id: seedEventId,
    name: "Board scale dataset",
    minSize: 2,
    maxSize: 4,
    admissionClosesAt: new Date(now.getTime() + 7 * 86_400_000),
    startsAt: now,
    endsAt: new Date(now.getTime() + 86_400_000),
  });
  await db
    .collection<{ _id: string } & Record<string, unknown>>("audit")
    .insertMany(
      teams.map((team, index) => ({
        _id: digest("audit", index),
        operationId: `seed:${version}:${team._id}`,
        eventId: seedEventId,
        teamId: team._id,
        actorId: team.leaderId,
        action: "seed-team",
        at: now,
        revision: 1,
        targetIds: team.members,
      })),
    );
  const result = await verifyDataset(db);
  await db
    .collection<{ _id: string; complete: boolean }>("seed_manifest")
    .updateOne({ _id: version }, { $set: { complete: true } });
  return result;
}
