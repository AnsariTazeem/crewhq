import { useState } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  Clock3,
  LockKeyhole,
  UsersRound,
} from "lucide-react";
import type { Commands } from "./commands";
import type {
  HistoryEntry,
  Identity,
  JoinRequest,
  Page,
  Profile,
  Team,
} from "./model";
import { personName } from "./model";
import { useQuery } from "./queries";
import {
  InvitationManager,
  LeaveTeam,
  ProfileEditor,
  Roster,
  TeamEditor,
} from "./actions";
import { Busy, Empty, ErrorBox, Tags } from "./ui";

export function TeamPanel({
  team,
  identity,
  commands,
  eventId,
}: {
  team: Team | null;
  identity: Identity;
  commands: Commands;
  eventId: string;
}) {
  return (
    <section className="panel team-panel">
      <div className="panel-label">
        <span className="eyebrow">YOUR CREW</span>
        <UsersRound size={17} />
      </div>
      {team ? (
        <>
          <h2>{team.name}</h2>
          <p className="hint">
            {team.frozen
              ? "Roster fixed after submission"
              : team.sizeEligible
                ? "Minimum team size met"
                : `Add ${team.minSize - team.memberCount} more to meet the minimum`}
          </p>
          <div className="seat-line">
            <span className="seat-count">
              {team.memberCount}
              <span>/{team.maxSize}</span>
            </span>
            <span className="hint">members</span>
            <span
              className={`status-label ${team.frozen || team.sizeEligible ? "eligible" : ""}`}
            >
              {team.frozen ? (
                <LockKeyhole size={13} />
              ) : team.sizeEligible ? (
                <CircleCheck size={13} />
              ) : (
                <Clock3 size={13} />
              )}
              {team.frozen
                ? "Fixed"
                : team.sizeEligible
                  ? "Eligible size"
                  : "Forming"}
            </span>
          </div>
          <Roster team={team} identity={identity} commands={commands} />
          {identity.id === team.leaderId && !team.frozen && (
            <InvitationManager
              team={team}
              eventId={eventId}
              commands={commands}
            />
          )}
          <p className="form-note">
            {team.frozen
              ? "Members cannot join, leave or be removed after submission."
              : "Your roster stays flexible until submission, then becomes fixed."}
          </p>
        </>
      ) : (
        <>
          <h2>Your crew is out there.</h2>
          <p className="hint">
            Find a team that needs your skills, or start one of your own.
          </p>
          <div className="seat-illustration" aria-hidden="true">
            <span>you</span>
            <i />
            <span>+</span>
            <i />
            <span>+</span>
          </div>
          <p className="form-note">
            One team per event. Plenty of ways to find the right one.
          </p>
        </>
      )}
    </section>
  );
}
export function ProfilePanel({
  profile,
  commands,
}: {
  profile: Profile;
  commands: Commands;
}) {
  return (
    <section className="panel profile-panel">
      <div className="panel-label">
        <span className="eyebrow">YOUR CALLING CARD</span>
        <ArrowUpRight size={16} />
      </div>
      <h2>{profile.displayName}</h2>
      <p className="hint">
        {profile.rankingReady
          ? "Ready for teammate suggestions"
          : "A little detail goes a long way."}
      </p>
      {profile.offeredSkills.length > 0 && (
        <Tags values={profile.offeredSkills} />
      )}
      <ProfileEditor profile={profile} commands={commands} />
      {!profile.rankingReady && (
        <p className="form-note">
          Add skills and a time zone to help people discover you. Both are
          optional.
        </p>
      )}
    </section>
  );
}
export function TeamView({
  team,
  identity,
  commands,
  eventId,
}: {
  team: Team | null;
  identity: Identity;
  commands: Commands;
  eventId: string;
}) {
  const [historyCursors, setHistoryCursors] = useState<string[]>([]);
  const history = useQuery<Page<HistoryEntry>>(
    team
      ? `/events/${eventId}/teams/${team.id}/history?limit=20${historyCursors.at(-1) ? `&cursor=${historyCursors.at(-1)}` : ""}`
      : null,
  );
  if (!team)
    return (
      <Empty
        title="Make room for your next crew"
        text="Browse teams with open seats, join with an invitation, or create a team."
      />
    );
  return (
    <section>
      <div className="section-top">
        <div>
          <span className="eyebrow">TEAM WORKSPACE</span>
          <h1>
            {team.name}
            <span className="accent">.</span>
          </h1>
          <p>
            {team.memberCount} of {team.maxSize} members · {team.minSize} needed
            to meet the minimum.
          </p>
        </div>
        {identity.id === team.leaderId && !team.frozen && (
          <TeamEditor team={team} commands={commands} />
        )}
      </div>
      {team.frozen && (
        <div className="notice">
          <LockKeyhole size={18} />
          This team has submitted. Its roster is now fixed.
        </div>
      )}
      <div className="panel workspace-roster">
        <h2>The people behind the project</h2>
        <Roster team={team} identity={identity} commands={commands} />
        <p className="eyebrow">Looking for</p>
        {team.wantedSkills.length ? (
          <Tags values={team.wantedSkills} />
        ) : (
          <p className="hint">No specific wanted skills selected.</p>
        )}
        <div className="button-row">
          {identity.id === team.leaderId && (
            <InvitationManager
              team={team}
              eventId={eventId}
              commands={commands}
            />
          )}
          <LeaveTeam team={team} identity={identity} commands={commands} />
        </div>
      </div>
      <div className="results-heading">
        <h2>Team activity</h2>
        <span className="hint">Who changed what, and when</span>
      </div>
      {history.loading && <Busy />}
      {!!history.error && (
        <ErrorBox error={history.error} retry={history.reload} />
      )}
      {history.data && (
        <>
          <ol className="activity-list">
            {history.data.items.map((entry) => (
              <li key={entry.id}>
                <span className="activity-dot" />
                <div>
                  <strong>
                    {entry.action.replaceAll("-", " ").replaceAll("_", " ")}
                  </strong>
                  <p>
                    {personName(entry.actorId, identity, team)}
                    {entry.targetIds.length > 0 &&
                      ` · ${entry.targetIds.map((id) => personName(id, identity, team)).join(", ")}`}
                  </p>
                  <time dateTime={entry.at}>
                    {new Date(entry.at).toLocaleString()}
                  </time>
                  {entry.action.includes("remove") && (
                    <p className="hint">
                      Removed participant ID: {entry.targetIds.join(", ")}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="pagination">
            <button
              className="button button-outline button-small"
              disabled={!historyCursors.length || history.stale}
              onClick={() => setHistoryCursors((c) => c.slice(0, -1))}
            >
              Newer activity
            </button>
            <button
              className="button button-outline button-small"
              disabled={!history.data.nextCursor || history.stale}
              onClick={() =>
                setHistoryCursors((c) => [...c, history.data!.nextCursor!])
              }
            >
              Older activity
            </button>
          </div>
        </>
      )}
    </section>
  );
}
export function RequestsView({
  team,
  identity,
  commands,
  eventId,
}: {
  team: Team | null;
  identity: Identity;
  commands: Commands;
  eventId: string;
}) {
  const leader = team?.leaderId === identity.id;
  const [cursors, setCursors] = useState<string[]>([]);
  const path = `/events/${eventId}${leader ? `/teams/${team.id}` : ""}/requests?state=all&limit=20${cursors.at(-1) ? `&after=${cursors.at(-1)}` : ""}`;
  const queue = useQuery<Page<JoinRequest>>(path);
  return (
    <section>
      <div className="section-top">
        <div>
          <span className="eyebrow">KEEP THINGS MOVING</span>
          <h1>
            {leader ? "Join requests" : "Your requests"}
            <span className="accent">.</span>
          </h1>
          <p>
            {leader
              ? "Meet the people who want to build with your team."
              : "Follow your applications. Joining a team cancels the others in this event."}
          </p>
        </div>
      </div>
      {queue.loading && <Busy />}
      {!!queue.error && <ErrorBox error={queue.error} retry={queue.reload} />}
      {queue.data && (
        <>
          {queue.data.items.length ? (
            <ul className="request-list">
              {queue.data.items.map((request) => (
                <li className="request-card" key={request.id}>
                  <span className="request-symbol">
                    <UsersRound size={21} />
                  </span>
                  <div className="request-info">
                    <h2>
                      {leader
                        ? (request.applicantName ??
                          `Participant ${request.applicantId.slice(-6)}`)
                        : (request.teamName ??
                          `Team ${request.teamId.slice(0, 8)}`)}
                    </h2>
                    <span
                      className={`tag ${request.status === "pending" ? "tag-green" : "tag-muted"}`}
                    >
                      {request.status}
                    </span>
                    <p className="hint">
                      Sent {new Date(request.at).toLocaleString()}
                    </p>
                    {request.reason && (
                      <p className="hint">
                        {request.reason.replaceAll("_", " ").toLowerCase()}
                      </p>
                    )}
                  </div>
                  {request.status === "pending" && (
                    <div className="button-row">
                      {leader ? (
                        <>
                          <button
                            className="button button-outline button-small"
                            disabled={
                              commands.busy ||
                              !!commands.pending ||
                              queue.stale ||
                              !!team?.frozen
                            }
                            onClick={() => {
                              void commands.run(
                                `/teams/${request.teamId}/requests/${request.id}/decline`,
                                {},
                                "Decline request",
                              );
                            }}
                          >
                            Decline
                          </button>
                          <button
                            className="button button-primary button-small"
                            disabled={
                              commands.busy ||
                              !!commands.pending ||
                              queue.stale ||
                              !!team?.frozen ||
                              team.memberCount >= team.maxSize
                            }
                            onClick={() => {
                              void commands.run(
                                `/teams/${request.teamId}/requests/${request.id}/accept`,
                                {},
                                "Accept request",
                              );
                            }}
                          >
                            Accept
                          </button>
                        </>
                      ) : (
                        <button
                          className="button button-outline button-small"
                          disabled={
                            commands.busy || !!commands.pending || queue.stale
                          }
                          onClick={() => {
                            void commands.run(
                              `/teams/${request.teamId}/requests/${request.id}/withdraw`,
                              {},
                              "Withdraw request",
                            );
                          }}
                        >
                          Withdraw
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title={
                leader
                  ? "Your next teammate might be browsing"
                  : "No requests yet"
              }
              text={
                leader
                  ? "Applications will appear here. You can also share an invitation directly."
                  : "Explore teams on the board and request to join one that interests you."
              }
            />
          )}
          <div className="pagination">
            <button
              className="button button-outline button-small"
              disabled={!cursors.length || queue.stale}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous
            </button>
            <button
              className="button button-outline button-small"
              disabled={!queue.data.nextCursor || queue.stale}
              onClick={() => setCursors((c) => [...c, queue.data!.nextCursor!])}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
