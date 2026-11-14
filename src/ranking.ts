import type { Db, MongoClient } from "mongodb";
import type { Event, Person, Team } from "./membership.js";
import type { Intent, CommandReply } from "./operations.js";
import { publicProfile, resolveNamedTimeZone } from "./profiles.js";
import { currentPerson, currentTeam } from "./current-reads.js";
import { boundedEventInterval } from "./event-dates.js";

type Scope = Pick<Intent, "actorId" | "eventId">;
export type RankingQuery = {
  limit: number;
  unrankedLimit: number;
  unrankedAfter?: string | undefined;
};
type Context = { kind: "solo" | "team"; wanted: string[]; members: Person[] };

function referenceInstants(event: Event): Date[] | null {
  const interval = boundedEventInterval(event.startsAt, event.endsAt);
  if (!interval) return null;
  const start = interval.start.getTime(),
    end = interval.end.getTime();
  const instants = new Set([start, end]);
  for (
    let noon = Date.UTC(
      interval.start.getUTCFullYear(),
      interval.start.getUTCMonth(),
      interval.start.getUTCDate(),
      12,
    );
    noon <= end;
    noon += 86_400_000
  ) {
    if (noon >= start) instants.add(noon);
  }
  return [...instants].sort((a, b) => a - b).map((value) => new Date(value));
}

function scorePool(context: Context, candidates: Person[], references: Date[]) {
  const mode = context.wanted.length ? "needs" : "additional-skills";
  const wanted = new Set(context.wanted);
  const offered = new Set(
    context.members.flatMap((member) => member.profile?.offeredSkills ?? []),
  );
  const offsets = new Map<string, number[] | null>();
  const zoneOffsets = (zone: string | null | undefined) => {
    if (!zone) return null;
    if (offsets.has(zone)) return offsets.get(zone)!;
    const resolved = resolveNamedTimeZone(zone);
    if (!resolved) {
      offsets.set(zone, null);
      return null;
    }
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: resolved,
      timeZoneName: "longOffset",
    });
    const values = references.map((at) => {
      const text =
        formatter.formatToParts(at).find((part) => part.type === "timeZoneName")
          ?.value ?? "";
      const match = /^(?:GMT|UTC)(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
        text,
      );
      if (!match) throw new Error("Unsupported zone-offset representation");
      return match[1]
        ? (match[1] === "+" ? 1 : -1) *
            (Number(match[2]) * 60 +
              Number(match[3]) +
              Number(match[4] ?? 0) / 60)
        : 0;
    });
    offsets.set(zone, values);
    return values;
  };
  const contextZones = context.members.map((member) =>
    zoneOffsets(member.profile?.timeZone),
  );
  const contextMissing = [
    ...(mode === "additional-skills" &&
    context.members.some((member) => !member.profile?.offeredSkills.length)
      ? ["context.offeredSkills"]
      : []),
    ...(contextZones.some((zone) => !zone) ? ["context.timeZone"] : []),
  ];
  const scored = candidates.map((candidate) => {
    const profile = publicProfile(
      candidate.profile,
      candidate.displayName ?? "Participant",
    );
    const declared = new Set(profile.offeredSkills);
    const matchedSkills = contextMissing.includes("context.offeredSkills")
      ? []
      : [...declared]
          .filter((skill) =>
            mode === "needs" ? wanted.has(skill) : !offered.has(skill),
          )
          .sort();
    const candidateZones = zoneOffsets(profile.timeZone);
    const missingInformation = [
      ...contextMissing,
      ...(!declared.size ? ["candidate.offeredSkills"] : []),
      ...(!candidateZones ? ["candidate.timeZone"] : []),
    ];
    const skillScore =
      !declared.size || contextMissing.includes("context.offeredSkills")
        ? null
        : mode === "needs"
          ? matchedSkills.length / wanted.size
          : Math.min(matchedSkills.length, 3) / 3;
    let zoneScore: number | null = null;
    if (candidateZones && contextZones.every((zone) => zone !== null)) {
      let sum = 0;
      for (const zone of contextZones)
        for (let i = 0; i < references.length; i++) {
          const r = Math.abs(candidateZones[i]! - zone![i]!) % 1440;
          sum += 1 - Math.min(r, 1440 - r) / 720;
        }
      zoneScore = sum / (contextZones.length * references.length);
    }
    return {
      id: candidate.userId,
      ...profile,
      rankingReady: missingInformation.length === 0,
      rankingLabel: missingInformation.length
        ? "Insufficient information to rank"
        : mode === "needs"
          ? "Declared need coverage, then local-clock phase"
          : "Additional declared skills, then local-clock phase",
      skillScore,
      zoneScore,
      matchedSkills,
      missingInformation,
    };
  });
  const ranked = scored
    .filter((person) => person.rankingReady)
    .sort(
      (a, b) =>
        b.skillScore! - a.skillScore! ||
        b.zoneScore! - a.zoneScore! ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const unranked = scored
    .filter((person) => !person.rankingReady)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { mode, ranked, unranked };
}

export class Suggestions {
  constructor(
    private readonly db: Db,
    private readonly client: MongoClient,
  ) {}
  async get(scope: Scope, query: RankingQuery): Promise<CommandReply> {
    const current = await currentPerson(this.db, scope);
    if (!current) return { status: 403, body: { code: "NOT_ENROLLED" } };
    const session = this.client.startSession({ snapshot: true });
    try {
      const options = {
        session,
        readConcern: { level: "snapshot" as const },
        maxTimeMS: 1_500,
      };
      const person = await this.db
        .collection<Person>("people")
        .findOne({ _id: current._id }, options);
      if (!person || person.revision !== current.revision)
        return { status: 409, body: { code: "MEMBERSHIP_CHANGED" } };
      let context: Context = {
        kind: "solo",
        wanted: person.profile?.wantedSkills ?? [],
        members: [person],
      };
      let contextTeam: Team | null = null;
      if (person.teamId) {
        contextTeam = await this.db
          .collection<Team>("teams")
          .findOne({ _id: person.teamId, eventId: scope.eventId }, options);
        if (
          !contextTeam ||
          contextTeam.state !== "active" ||
          !contextTeam.members.includes(scope.actorId)
        )
          return { status: 409, body: { code: "TEAM_CHANGED" } };
        if (contextTeam.leaderId !== scope.actorId)
          return { status: 403, body: { code: "LEADER_REQUIRED" } };
        if (
          contextTeam.frozen ||
          contextTeam.members.length >= contextTeam.maxSize
        )
          return { status: 409, body: { code: "TEAM_NOT_RECRUITING" } };
        const members = await this.db
          .collection<Person>("people")
          .find({ eventId: scope.eventId, teamId: contextTeam._id }, options)
          .limit(21)
          .toArray();
        if (
          members.length > 20 ||
          members.length !== contextTeam.members.length ||
          members.some(
            (member) => !contextTeam!.members.includes(member.userId),
          )
        )
          return { status: 503, body: { code: "MEMBERSHIP_INCONSISTENT" } };
        context = {
          kind: "team",
          wanted: contextTeam.wantedSkills ?? [],
          members,
        };
      }
      const event = await this.db
        .collection<Event>("events")
        .findOne({ _id: scope.eventId }, options);
      if (!event) return { status: 404, body: { code: "EVENT_NOT_FOUND" } };
      if (event.admissionClosesAt <= new Date())
        return { status: 409, body: { code: "ADMISSIONS_CLOSED" } };
      const references = referenceInstants(event);
      if (!references)
        return { status: 503, body: { code: "RANKING_DATES_UNCONFIGURED" } };
      const candidates = await this.db
        .collection<Person>("people")
        .find(
          {
            eventId: scope.eventId,
            teamId: null,
            userId: { $ne: scope.actorId },
          },
          { ...options, projection: { userId: 1, displayName: 1, profile: 1 } },
        )
        .limit(10_001)
        .toArray();
      if (candidates.length > 10_000)
        return { status: 503, body: { code: "RANKING_CAPACITY_EXCEEDED" } };
      const result = scorePool(context, candidates, references);
      const latest = await currentPerson(this.db, scope);
      if (!latest || latest.revision !== current.revision)
        return { status: 409, body: { code: "MEMBERSHIP_CHANGED" } };
      if (contextTeam) {
        const latestTeam = await currentTeam(
          this.db,
          scope.eventId,
          contextTeam._id,
        );
        if (
          !latestTeam ||
          latestTeam.state !== "active" ||
          latestTeam.leaderId !== scope.actorId ||
          !latestTeam.members.includes(scope.actorId)
        )
          return { status: 403, body: { code: "LEADER_REQUIRED" } };
        if (latestTeam.revision !== contextTeam.revision)
          return { status: 409, body: { code: "TEAM_CHANGED" } };
      }
      const unranked = result.unranked.filter(
        (candidate) =>
          !query.unrankedAfter || candidate.id > query.unrankedAfter,
      );
      const unrankedPage = unranked.slice(0, query.unrankedLimit);
      return {
        status: 200,
        body: {
          version: "skills-zone-v1",
          context: {
            kind: context.kind,
            mode: result.mode,
            wantedSkills: context.wanted,
            ...(contextTeam ? { teamId: contextTeam._id } : {}),
          },
          eligibleCount: candidates.length,
          rankedCount: result.ranked.length,
          unrankedCount: result.unranked.length,
          items: result.ranked.slice(0, query.limit),
          unranked: unrankedPage,
          unrankedNextCursor:
            unranked.length > query.unrankedLimit
              ? unrankedPage.at(-1)!.id
              : null,
          explanation: {
            skillRule: {
              mode: result.mode,
              denominator: result.mode === "needs" ? context.wanted.length : 3,
              cap: result.mode === "needs" ? null : 3,
            },
            order: [
              "skillScore descending",
              "zoneScore descending",
              "participant ID ascending",
            ],
            referenceInstants: references,
            contextMembers: context.members.length,
            zoneMeaning:
              "Mean circular local-clock phase proximity; not availability or consent",
            zoneRule:
              "For each member/reference: r=abs(offset difference) mod 1440; 1-min(r,1440-r)/720; arithmetic mean",
            runtime: {
              node: process.versions.node,
              icu: process.versions.icu,
              tz: process.versions.tz,
            },
          },
        },
      };
    } finally {
      await session.endSession();
    }
  }
}
