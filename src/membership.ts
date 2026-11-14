import { createHash, randomBytes, randomUUID } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { ClientSession, Db, MongoClient } from "mongodb";
import type { Logger } from "pino";
import { requestPage, type JoinRequest } from "./requests.js";
import type { ParticipantProfile, TeamProfileInput } from "./profiles.js";
import { currentPerson, currentTeam } from "./current-reads.js";
import type { ProjectionRead } from "./live-reads.js";
import {
  Operations,
  committed,
  rejected,
  type Intent,
  type CommandReply,
} from "./operations.js";

export type Event = {
  _id: string;
  name: string;
  minSize: number;
  maxSize: number;
  admissionClosesAt: Date;
  startsAt?: Date;
  endsAt?: Date;
};
export type Person = {
  _id: string;
  eventId: string;
  userId: string;
  teamId: string | null;
  membershipEpoch: number;
  revision: number;
  displayName?: string;
  profile?: ParticipantProfile;
};
export type Team = {
  _id: string;
  eventId: string;
  name: string;
  leaderId: string | null;
  members: string[];
  minSize: number;
  maxSize: number;
  revision: number;
  frozen: boolean;
  state: "active" | "deleted";
  wantedSkills?: string[];
};
type Audit = {
  _id: string;
  operationId: string;
  eventId: string;
  teamId: string;
  actorId: string;
  action: string;
  at: Date;
  revision: number;
  targetIds: string[];
  private?: true;
};
type EventActor = Pick<Intent, "eventId" | "actorId">;
export type HistoryCursor = { at: Date; id: string };
type Invitation = {
  _id: string;
  eventId: string;
  teamId: string;
  digest: string;
  encryptedCode: string;
  expiresAt: Date;
  revoked: boolean;
} & (
  | { kind: "shared" }
  | { kind: "personal"; subjectId: string; generation: number }
);
type RemovalRestriction = {
  eventId: string;
  teamId: string;
  userId: string;
  generation: number;
  restricted: boolean;
  grantId: string | null;
};

export class Membership {
  readonly operations: Operations;
  private readonly events;
  private readonly people;
  private readonly teams;
  private readonly invitations;
  constructor(
    private readonly db: Db,
    client: MongoClient,
    private readonly invitationKey: string,
    logger?: Pick<Logger, "warn">,
  ) {
    this.operations = new Operations(db, client, logger);
    this.events = db.collection<Event>("events");
    this.people = db.collection<Person>("people");
    this.teams = db.collection<Team>("teams");
    this.invitations = db.collection<Invitation>("invitations");
  }

  enroll(intent: Intent, displayName: string) {
    return this.operations.run(
      intent,
      "enroll",
      {},
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const existing = await this.people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        if (existing)
          return committed({
            eventId: intent.eventId,
            participantId: intent.actorId,
          });
        await this.people.insertOne(
          {
            _id: `${intent.eventId}:${intent.actorId}`,
            eventId: intent.eventId,
            userId: intent.actorId,
            teamId: null,
            membershipEpoch: 0,
            revision: 0,
            displayName: displayName.slice(0, 80) || "Participant",
          },
          { session },
        );
        await this.operations.publish(session, operationId, intent.eventId);
        return committed(
          { eventId: intent.eventId, participantId: intent.actorId },
          201,
        );
      },
    );
  }

  createTeam(intent: Intent, name: string) {
    const teamId = randomUUID();
    return this.operations.run(
      intent,
      "create-team",
      { name },
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const person = await this.people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        if (!person) return rejected("NOT_ENROLLED", 403);
        if (person.teamId) return rejected("ALREADY_TEAMED");
        const changed = await this.people.updateOne(
          { _id: person._id, revision: person.revision, teamId: null },
          { $set: { teamId }, $inc: { membershipEpoch: 1, revision: 1 } },
          { session },
        );
        if (changed.modifiedCount !== 1)
          throw new Error("Membership guard did not advance");
        const team: Team = {
          _id: teamId,
          eventId: intent.eventId,
          name,
          leaderId: intent.actorId,
          members: [intent.actorId],
          minSize: event.minSize,
          maxSize: event.maxSize,
          revision: 1,
          state: "active",
          frozen: false,
        };
        await this.teams.insertOne(team, { session });
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          team,
          "TEAM_CREATED",
          [intent.actorId],
        );
        return committed({ eventId: intent.eventId, teamId }, 201);
      },
    );
  }

  saveTeamProfile(intent: Intent, teamId: string, input: TeamProfileInput) {
    return this.operations.run(
      intent,
      "save-team-profile",
      { teamId, ...input },
      async (session, operationId) => {
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          team.leaderId !== intent.actorId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("LEADER_REQUIRED", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        if (team.revision !== input.expectedRevision)
          return rejected("TEAM_CHANGED");
        const { name, wantedSkills } = input;
        const updated = await this.teams.updateOne(
          {
            _id: teamId,
            revision: team.revision,
            state: "active",
            frozen: false,
          },
          { $set: { name, wantedSkills }, $inc: { revision: 1 } },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw new Error("Team profile guard did not advance");
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          { ...team, name, wantedSkills, revision: team.revision + 1 },
          "TEAM_PROFILE_UPDATED",
          [],
        );
        return committed({
          eventId: intent.eventId,
          teamId,
          revision: team.revision + 1,
        });
      },
    );
  }

  async issueInvitation(intent: Intent, teamId: string, subjectId?: string) {
    const invitationId = randomUUID();
    const code = randomBytes(16).toString("base64url");
    const encryptedCode = await symmetricEncrypt({
      key: this.invitationKey,
      data: code,
    });
    return this.operations.run(
      intent,
      subjectId ? "issue-personal-invitation" : "issue-shared-invitation",
      { teamId, ...(subjectId ? { subjectId } : {}) },
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          team.leaderId !== intent.actorId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("LEADER_REQUIRED", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        const restriction = subjectId
          ? await this.db
              .collection<RemovalRestriction>("restrictions")
              .findOne(
                {
                  eventId: intent.eventId,
                  teamId,
                  userId: subjectId,
                  restricted: true,
                },
                { session },
              )
          : null;
        if (subjectId && !restriction)
          return rejected("NO_REMOVAL_RESTRICTION");
        const existing = await this.invitations.findOne(
          {
            eventId: intent.eventId,
            teamId,
            kind: subjectId ? "personal" : "shared",
            ...(subjectId
              ? {
                  _id: restriction?.grantId ?? "",
                  subjectId,
                  generation: restriction!.generation,
                }
              : {}),
            revoked: false,
            expiresAt: { $gt: new Date() },
          },
          { session },
        );
        const updatedTeam = await this.guardTeam(session, team);
        if (existing) return committed({ invitationId: existing._id, teamId });
        await this.invitations.insertOne(
          {
            _id: invitationId,
            eventId: intent.eventId,
            teamId,
            ...(subjectId
              ? {
                  kind: "personal" as const,
                  subjectId,
                  generation: restriction!.generation,
                }
              : { kind: "shared" as const }),
            digest: createHash("sha256").update(code).digest("hex"),
            encryptedCode,
            expiresAt: new Date(
              Math.min(
                Date.now() + 86_400_000,
                event.admissionClosesAt.getTime(),
              ),
            ),
            revoked: false,
          },
          { session },
        );
        if (subjectId) {
          const granted = await this.db
            .collection<RemovalRestriction>("restrictions")
            .updateOne(
              {
                eventId: intent.eventId,
                teamId,
                userId: subjectId,
                restricted: true,
                generation: restriction!.generation,
              },
              { $set: { grantId: invitationId } },
              { session },
            );
          if (granted.modifiedCount !== 1)
            throw new Error("Personal grant guard did not advance");
        }
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          updatedTeam,
          subjectId ? "PERSONAL_INVITATION_ISSUED" : "INVITATION_ISSUED",
          [],
          Boolean(subjectId),
        );
        return committed({ invitationId, teamId }, 201);
      },
    );
  }

  revokeInvitation(intent: Intent, teamId: string, invitationId: string) {
    return this.operations.run(
      intent,
      "revoke-invitation",
      { teamId, invitationId },
      async (session, operationId) => {
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          team.leaderId !== intent.actorId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("LEADER_REQUIRED", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        const invitation = await this.invitations.findOne(
          { _id: invitationId, teamId, eventId: intent.eventId },
          { session },
        );
        if (!invitation) return rejected("INVITE_UNUSABLE", 404);
        if (invitation.revoked) return committed({ teamId, invitationId });
        const updated = await this.guardTeam(session, team);
        const revoked = await this.invitations.updateOne(
          { _id: invitationId, revoked: false },
          { $set: { revoked: true } },
          { session },
        );
        if (revoked.modifiedCount !== 1)
          throw new Error("Invitation revocation did not advance");
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          updated,
          invitation.kind === "personal"
            ? "PERSONAL_INVITATION_REVOKED"
            : "INVITATION_REVOKED",
          [],
          invitation.kind === "personal",
        );
        return committed({ teamId, invitationId });
      },
    );
  }

  redeemInvitation(intent: Intent, code: string) {
    const digest = createHash("sha256").update(code).digest("hex");
    return this.operations.run(
      intent,
      "redeem-invitation",
      { digest },
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const person = await this.people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        if (!person) return rejected("NOT_ENROLLED", 403);
        if (person.teamId) return rejected("ALREADY_TEAMED");
        const invitation = await this.invitations.findOne(
          {
            eventId: intent.eventId,
            digest,
            revoked: false,
            expiresAt: { $gt: new Date() },
          },
          { session },
        );
        if (!invitation) return rejected("INVITE_UNUSABLE", 404);
        if (
          invitation.kind === "personal" &&
          invitation.subjectId !== intent.actorId
        )
          return rejected("INVITE_SUBJECT_MISMATCH", 403);
        const team = await this.teams.findOne(
          { _id: invitation.teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        if (team.members.length >= team.maxSize) return rejected("TEAM_FULL");
        const restrictions =
          this.db.collection<RemovalRestriction>("restrictions");
        const restriction = await restrictions.findOne(
          {
            eventId: intent.eventId,
            teamId: team._id,
            userId: intent.actorId,
            restricted: true,
          },
          { session },
        );
        if (invitation.kind === "shared" && restriction)
          return rejected("PERSONAL_REINVITE_REQUIRED", 403);
        if (
          invitation.kind === "personal" &&
          (!restriction ||
            restriction.generation !== invitation.generation ||
            restriction.grantId !== invitation._id)
        )
          return rejected("INVITE_UNUSABLE", 403);
        const decision = await this.admit(
          session,
          operationId,
          intent.actorId,
          person,
          team,
        );
        if (invitation.kind === "personal") {
          const cleared = await restrictions.updateOne(
            {
              eventId: intent.eventId,
              teamId: team._id,
              userId: intent.actorId,
              restricted: true,
              generation: invitation.generation,
              grantId: invitation._id,
            },
            { $set: { restricted: false, grantId: null } },
            { session },
          );
          if (cleared.modifiedCount !== 1)
            throw new Error("Personal return restriction did not advance");
          const consumed = await this.invitations.updateOne(
            { _id: invitation._id, revoked: false },
            { $set: { revoked: true } },
            { session },
          );
          if (consumed.modifiedCount !== 1)
            throw new Error("Personal invitation was not consumed");
        }
        return decision;
      },
    );
  }

  createRequest(intent: Intent, teamId: string) {
    const requestId = randomUUID();
    return this.operations.run(
      intent,
      "create-request",
      { teamId },
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const person = await this.people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        if (!person) return rejected("NOT_ENROLLED", 403);
        if (person.teamId) return rejected("ALREADY_TEAMED");
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        if (team.members.length >= team.maxSize) return rejected("TEAM_FULL");
        if (
          await this.db.collection("restrictions").findOne(
            {
              eventId: intent.eventId,
              teamId,
              userId: intent.actorId,
              restricted: true,
            },
            { session },
          )
        )
          return rejected("PERSONAL_REINVITE_REQUIRED", 403);
        const requests = this.db.collection<JoinRequest>("requests");
        const existing = await requests.findOne(
          {
            eventId: intent.eventId,
            teamId,
            applicantId: intent.actorId,
            epoch: person.membershipEpoch,
            state: "pending",
          },
          { session },
        );
        await this.guardUnteamedPerson(session, person);
        const updated = await this.guardTeam(session, team);
        if (existing) return committed({ requestId: existing._id, teamId });
        await requests.insertOne(
          {
            _id: requestId,
            eventId: intent.eventId,
            teamId,
            applicantId: intent.actorId,
            personId: person._id,
            epoch: person.membershipEpoch,
            state: "pending",
            at: new Date(),
          },
          { session },
        );
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          updated,
          "REQUEST_CREATED",
          [],
          true,
        );
        return committed({ requestId, teamId }, 201);
      },
    );
  }

  acceptRequest(intent: Intent, teamId: string, requestId: string) {
    return this.operations.run(
      intent,
      "accept-request",
      { teamId, requestId },
      async (session, operationId) => {
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event) return rejected("EVENT_NOT_FOUND", 404);
        if (event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          team.leaderId !== intent.actorId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("LEADER_REQUIRED", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        const requests = this.db.collection<JoinRequest>("requests");
        const application = await requests.findOne(
          { _id: requestId, teamId, eventId: intent.eventId },
          { session },
        );
        if (!application) return rejected("REQUEST_NOT_FOUND", 404);
        if (application.state !== "pending")
          return rejected("REQUEST_NOT_PENDING");
        const person = await this.people.findOne(
          { _id: application.personId },
          { session },
        );
        if (!this.requestMatchesMembership(application, person))
          return rejected("REQUEST_CANCELLED");
        if (team.members.length >= team.maxSize) return rejected("TEAM_FULL");
        if (
          await this.db.collection("restrictions").findOne(
            {
              eventId: intent.eventId,
              teamId,
              userId: application.applicantId,
              restricted: true,
            },
            { session },
          )
        )
          return rejected("PERSONAL_REINVITE_REQUIRED", 403);
        const changed = await requests.updateOne(
          { _id: requestId, state: "pending" },
          { $set: { state: "accepted", resolvedAt: new Date() } },
          { session },
        );
        if (changed.modifiedCount !== 1)
          throw new Error("Request decision did not advance");
        return this.admit(session, operationId, intent.actorId, person, team);
      },
    );
  }

  closeRequest(
    intent: Intent,
    teamId: string,
    requestId: string,
    action: "decline" | "withdraw",
  ) {
    return this.operations.run(
      intent,
      `${action}-request`,
      { teamId, requestId },
      async (session, operationId) => {
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        const requests = this.db.collection<JoinRequest>("requests");
        const application = await requests.findOne(
          { _id: requestId, teamId, eventId: intent.eventId },
          { session },
        );
        if (
          action === "decline" &&
          (team.leaderId !== intent.actorId ||
            !team.members.includes(intent.actorId))
        )
          return rejected("LEADER_REQUIRED", 403);
        if (
          action === "withdraw" &&
          application?.applicantId !== intent.actorId
        )
          return rejected("APPLICANT_REQUIRED", 403);
        if (!application) return rejected("REQUEST_NOT_FOUND", 404);
        if (application.state !== "pending")
          return rejected("REQUEST_NOT_PENDING");
        const person = await this.people.findOne(
          { _id: application.personId },
          { session },
        );
        if (!this.requestMatchesMembership(application, person))
          return rejected("REQUEST_CANCELLED");
        if (team.frozen) return rejected("ROSTER_FROZEN");
        const event = await this.events.findOne(
          { _id: intent.eventId },
          { session },
        );
        if (!event || event.admissionClosesAt <= new Date())
          return rejected("ADMISSIONS_CLOSED");
        await this.guardUnteamedPerson(session, person);
        const updated = await this.guardTeam(session, team);
        const changed = await requests.updateOne(
          { _id: requestId, state: "pending" },
          {
            $set: {
              state: action === "decline" ? "declined" : "withdrawn",
              resolvedAt: new Date(),
            },
          },
          { session },
        );
        if (changed.modifiedCount !== 1)
          throw new Error("Request decision did not advance");
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          updated,
          action === "decline" ? "REQUEST_DECLINED" : "REQUEST_WITHDRAWN",
          [],
          true,
        );
        return committed({ teamId, requestId });
      },
    );
  }

  async getRequests(
    scope: EventActor,
    options: {
      limit: number;
      after?: string | undefined;
      state: "all" | "pending";
    },
    teamId?: string,
    read?: ProjectionRead,
  ): Promise<CommandReply> {
    const person = await currentPerson(this.db, scope);
    if (!person) return { status: 403, body: { code: "NOT_ENROLLED" } };
    const event = await this.events.findOne(
      { _id: scope.eventId },
      read ?? { maxTimeMS: 1_500 },
    );
    if (!event) return { status: 404, body: { code: "EVENT_NOT_FOUND" } };
    const team = teamId
      ? await currentTeam(this.db, scope.eventId, teamId)
      : null;
    if (teamId && (!team || team.state !== "active"))
      return { status: 404, body: { code: "TEAM_NOT_FOUND" } };
    if (teamId && team!.leaderId !== scope.actorId)
      return { status: 403, body: { code: "LEADER_REQUIRED" } };
    const page = await requestPage(
      this.db,
      {
        eventId: scope.eventId,
        ...(teamId ? { teamId } : { applicantId: scope.actorId }),
      },
      event.admissionClosesAt,
      options,
      read,
    );
    if (teamId) {
      const current = await currentTeam(this.db, scope.eventId, teamId);
      if (
        !current ||
        current.state !== "active" ||
        current.leaderId !== scope.actorId
      )
        return { status: 403, body: { code: "LEADER_REQUIRED" } };
      if (current.revision !== team!.revision)
        return { status: 409, body: { code: "TEAM_CHANGED" } };
    } else {
      const current = await currentPerson(this.db, scope);
      if (!current || current.revision !== person.revision)
        return { status: 409, body: { code: "MEMBERSHIP_CHANGED" } };
    }
    return { status: 200, body: page };
  }

  removeMember(intent: Intent, teamId: string, userId: string) {
    return this.operations.run(
      intent,
      "remove-member",
      { teamId, userId },
      async (session, operationId) => {
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          team.leaderId !== intent.actorId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("LEADER_REQUIRED", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        if (userId === intent.actorId) return rejected("USE_LEAVE_FOR_SELF");
        const person = await this.people.findOne(
          { eventId: intent.eventId, userId },
          { session },
        );
        if (
          !person ||
          person.teamId !== teamId ||
          !team.members.includes(userId)
        )
          return rejected("NOT_TEAM_MEMBER", 409);
        const changedPerson = await this.people.updateOne(
          { _id: person._id, teamId, revision: person.revision },
          { $set: { teamId: null }, $inc: { membershipEpoch: 1, revision: 1 } },
          { session },
        );
        if (changedPerson.modifiedCount !== 1)
          throw new Error("Removal person guard did not advance");
        const changedTeam = await this.teams.updateOne(
          {
            _id: teamId,
            revision: team.revision,
            state: "active",
            frozen: false,
          },
          { $pull: { members: userId }, $inc: { revision: 1 } },
          { session },
        );
        if (changedTeam.modifiedCount !== 1)
          throw new Error("Removal team guard did not advance");
        await this.db.collection<RemovalRestriction>("restrictions").updateOne(
          { eventId: intent.eventId, teamId, userId },
          {
            $set: { restricted: true, grantId: null },
            $inc: { generation: 1 },
          },
          { upsert: true, session },
        );
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          {
            ...team,
            members: team.members.filter((id) => id !== userId),
            revision: team.revision + 1,
          },
          "MEMBER_REMOVED",
          [userId],
        );
        return committed({ teamId, removedId: userId });
      },
    );
  }

  leave(intent: Intent, teamId: string, successorId?: string) {
    return this.operations.run(
      intent,
      "leave-team",
      { teamId, ...(successorId ? { successorId } : {}) },
      async (session, operationId) => {
        const person = await this.people.findOne(
          { eventId: intent.eventId, userId: intent.actorId },
          { session },
        );
        const team = await this.teams.findOne(
          { _id: teamId, eventId: intent.eventId },
          { session },
        );
        if (!team || team.state !== "active")
          return rejected("TEAM_NOT_FOUND", 404);
        if (
          !person ||
          person.teamId !== teamId ||
          !team.members.includes(intent.actorId)
        )
          return rejected("NOT_TEAM_MEMBER", 403);
        if (team.frozen) return rejected("ROSTER_FROZEN");
        const remaining = team.members.filter((id) => id !== intent.actorId);
        const isLeader = team.leaderId === intent.actorId;
        if (isLeader && remaining.length && !successorId)
          return rejected("SUCCESSOR_REQUIRED");
        if (successorId && (!isLeader || !remaining.includes(successorId)))
          return rejected("SUCCESSOR_CHANGED");
        const leaderId = remaining.length
          ? isLeader
            ? successorId!
            : team.leaderId
          : null;
        const updated: Team = {
          ...team,
          members: remaining,
          leaderId,
          revision: team.revision + 1,
          state: remaining.length ? "active" : "deleted",
        };
        const changedPerson = await this.people.updateOne(
          { _id: person._id, teamId, revision: person.revision },
          { $set: { teamId: null }, $inc: { membershipEpoch: 1, revision: 1 } },
          { session },
        );
        if (changedPerson.modifiedCount !== 1)
          throw new Error("Departure membership guard did not advance");
        const changedTeam = await this.teams.updateOne(
          {
            _id: teamId,
            revision: team.revision,
            state: "active",
            frozen: false,
          },
          {
            $set: {
              members: updated.members,
              leaderId: updated.leaderId,
              state: updated.state,
            },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (changedTeam.modifiedCount !== 1)
          throw new Error("Departure team guard did not advance");
        await this.recordChange(
          session,
          operationId,
          intent.actorId,
          updated,
          !remaining.length
            ? "TEAM_DELETED"
            : isLeader
              ? "LEADER_LEFT"
              : "MEMBER_LEFT",
          successorId ? [successorId] : [intent.actorId],
        );
        return committed({
          eventId: intent.eventId,
          teamId,
          deleted: !remaining.length,
        });
      },
    );
  }

  private requestMatchesMembership(
    application: JoinRequest,
    person: Person | null,
  ): person is Person {
    return (
      person !== null &&
      person.teamId === null &&
      person.membershipEpoch === application.epoch
    );
  }

  private async guardUnteamedPerson(session: ClientSession, person: Person) {
    const changed = await this.people.updateOne(
      { _id: person._id, revision: person.revision, teamId: null },
      { $inc: { revision: 1 } },
      { session },
    );
    if (changed.modifiedCount !== 1)
      throw new Error("Request person guard did not advance");
  }

  private async admit(
    session: ClientSession,
    operationId: string,
    actorId: string,
    person: Person,
    team: Team,
  ) {
    const changedPerson = await this.people.updateOne(
      { _id: person._id, teamId: null, revision: person.revision },
      { $set: { teamId: team._id }, $inc: { membershipEpoch: 1, revision: 1 } },
      { session },
    );
    if (changedPerson.modifiedCount !== 1)
      throw new Error("Membership guard did not advance");
    const changedTeam = await this.teams.updateOne(
      {
        _id: team._id,
        revision: team.revision,
        state: "active",
        frozen: false,
        members: { $nin: [person.userId] },
        $expr: { $lt: [{ $size: "$members" }, "$maxSize"] },
      },
      { $push: { members: person.userId }, $inc: { revision: 1 } },
      { session },
    );
    if (changedTeam.modifiedCount !== 1)
      throw new Error("Admission guard did not advance");
    await this.recordChange(
      session,
      operationId,
      actorId,
      {
        ...team,
        members: [...team.members, person.userId],
        revision: team.revision + 1,
      },
      "MEMBER_JOINED",
      [person.userId],
    );
    return committed({ eventId: team.eventId, teamId: team._id }, 201);
  }

  async getInvitation(
    scope: EventActor,
    teamId: string,
    invitationId: string,
    read?: ProjectionRead,
  ): Promise<CommandReply> {
    const team = await currentTeam(this.db, scope.eventId, teamId);
    if (!team || team.state !== "active")
      return { status: 404, body: { code: "TEAM_NOT_FOUND" } };
    if (
      team.leaderId !== scope.actorId ||
      !team.members.includes(scope.actorId)
    )
      return { status: 403, body: { code: "LEADER_REQUIRED" } };
    if (team.frozen) return { status: 409, body: { code: "ROSTER_FROZEN" } };
    const invitation = await this.invitations.findOne(
      {
        _id: invitationId,
        eventId: scope.eventId,
        teamId,
        revoked: false,
        expiresAt: { $gt: new Date() },
      },
      read ?? { maxTimeMS: 1_500 },
    );
    if (!invitation) return { status: 404, body: { code: "INVITE_UNUSABLE" } };
    const code = await symmetricDecrypt({
      key: this.invitationKey,
      data: invitation.encryptedCode,
    });
    const current = await currentTeam(this.db, scope.eventId, teamId);
    if (
      !current ||
      current.revision !== team.revision ||
      current.leaderId !== scope.actorId
    ) {
      return { status: 409, body: { code: "TEAM_CHANGED" } };
    }
    return {
      status: 200,
      body: { invitationId, code, expiresAt: invitation.expiresAt },
    };
  }

  private summary(team: Team, actorId: string) {
    return {
      id: team._id,
      eventId: team.eventId,
      name: team.name,
      wantedSkills: team.wantedSkills ?? [],
      leaderId: team.leaderId,
      memberCount: team.members.length,
      minSize: team.minSize,
      maxSize: team.maxSize,
      sizeEligible:
        team.members.length >= team.minSize &&
        team.members.length <= team.maxSize,
      frozen: team.frozen,
      revision: team.revision,
      ...(team.members.includes(actorId) ? { members: [...team.members] } : {}),
    };
  }

  private async memberSummary(team: Team, actorId: string) {
    const summary = this.summary(team, actorId);
    if (!team.members.includes(actorId)) return summary;
    const people = await this.people
      .find(
        {
          eventId: team.eventId,
          teamId: team._id,
          userId: { $in: team.members },
        },
        {
          projection: { userId: 1, displayName: 1, "profile.displayName": 1 },
          readConcern: { level: "majority" },
          maxTimeMS: 1_500,
        },
      )
      .limit(20)
      .toArray();
    const current = await currentTeam(this.db, team.eventId, team._id);
    if (
      !current ||
      current.revision !== team.revision ||
      !current.members.includes(actorId)
    )
      return null;
    return {
      ...summary,
      roster: people.map((person) => ({
        id: person.userId,
        displayName:
          person.profile?.displayName ?? person.displayName ?? "Participant",
      })),
    };
  }

  async getMine(scope: EventActor): Promise<CommandReply> {
    const person = await currentPerson(this.db, scope);
    if (!person) return { status: 403, body: { code: "NOT_ENROLLED" } };
    if (!person.teamId)
      return {
        status: 200,
        body: {
          eventId: scope.eventId,
          participantId: scope.actorId,
          team: null,
        },
      };
    const team = await currentTeam(this.db, scope.eventId, person.teamId);
    if (
      !team ||
      team.state !== "active" ||
      !team.members.includes(scope.actorId)
    )
      return { status: 409, body: { code: "TEAM_CHANGED" } };
    const summary = await this.memberSummary(team, scope.actorId);
    if (!summary) return { status: 409, body: { code: "TEAM_CHANGED" } };
    return {
      status: 200,
      body: {
        eventId: scope.eventId,
        participantId: scope.actorId,
        team: summary,
      },
    };
  }

  async getTeam(scope: EventActor, teamId: string): Promise<CommandReply> {
    if (!(await currentPerson(this.db, scope)))
      return { status: 403, body: { code: "NOT_ENROLLED" } };
    const team = await currentTeam(this.db, scope.eventId, teamId);
    if (!team || team.state !== "active")
      return { status: 404, body: { code: "TEAM_NOT_FOUND" } };
    const summary = await this.memberSummary(team, scope.actorId);
    return summary
      ? { status: 200, body: summary }
      : { status: 409, body: { code: "TEAM_CHANGED" } };
  }

  async getHistory(
    scope: EventActor,
    teamId: string,
    limit: number,
    cursor?: HistoryCursor,
    read?: ProjectionRead,
  ): Promise<CommandReply> {
    const team = await currentTeam(this.db, scope.eventId, teamId);
    if (!team || team.state !== "active")
      return { status: 404, body: { code: "TEAM_NOT_FOUND" } };
    if (!team.members.includes(scope.actorId))
      return { status: 403, body: { code: "NOT_TEAM_MEMBER" } };
    const entries = await this.db
      .collection<Audit>("audit")
      .find(
        {
          eventId: scope.eventId,
          teamId,
          private: { $ne: true },
          ...(cursor
            ? {
                $or: [
                  { at: { $lt: cursor.at } },
                  { at: cursor.at, _id: { $lt: cursor.id } },
                ],
              }
            : {}),
        },
        read ?? { maxTimeMS: 1_500 },
      )
      .sort({ at: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const current = await currentTeam(this.db, scope.eventId, teamId);
    if (!current || !current.members.includes(scope.actorId))
      return { status: 403, body: { code: "NOT_TEAM_MEMBER" } };
    if (current.revision !== team.revision)
      return { status: 409, body: { code: "TEAM_CHANGED" } };
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      entries.length > limit && last
        ? Buffer.from(
            JSON.stringify({ at: last.at.toISOString(), id: last._id }),
          ).toString("base64url")
        : null;
    return {
      status: 200,
      body: {
        items: page.map((entry) => ({
          id: entry._id,
          actorId: entry.actorId,
          action: entry.action,
          at: entry.at,
          targetIds: entry.targetIds,
        })),
        nextCursor,
      },
    };
  }

  private async guardTeam(session: ClientSession, team: Team): Promise<Team> {
    const result = await this.teams.updateOne(
      {
        _id: team._id,
        revision: team.revision,
        state: "active",
        frozen: false,
      },
      { $inc: { revision: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1)
      throw new Error("Team guard did not advance");
    return { ...team, revision: team.revision + 1 };
  }

  private async recordChange(
    session: ClientSession,
    operationId: string,
    actorId: string,
    team: Team,
    action: string,
    targetIds: string[],
    privateEntry = false,
  ) {
    await this.db.collection<Audit>("audit").insertOne(
      {
        _id: operationId,
        operationId,
        actorId,
        eventId: team.eventId,
        teamId: team._id,
        action,
        at: new Date(),
        revision: team.revision,
        targetIds,
        ...(privateEntry ? { private: true as const } : {}),
      },
      { session },
    );
    await this.operations.publish(
      session,
      operationId,
      team.eventId,
      privateEntry ? undefined : { teamId: team._id, revision: team.revision },
    );
  }
}
