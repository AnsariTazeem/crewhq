import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Globe2,
  Search,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { Commands } from "./commands";
import type {
  Board,
  Identity,
  Page,
  Person,
  JoinRequest,
  Suggestions,
  Team,
} from "./model";
import { skillLabel, skills } from "./model";
import { useLive, useQuery } from "./queries";
import { Avatar, Busy, Empty, ErrorBox, Modal, Tags } from "./ui";

export function PersonCard({ person }: { person: Person }) {
  return (
    <article className="person-card">
      <div className="card-person">
        <Avatar name={person.displayName} />
        <div>
          <h3>{person.displayName}</h3>
          <span className="person-status">
            <span className="tiny-dot" />
            Looking for a team
          </span>
        </div>
        <Modal
          title={person.displayName}
          description="Participant profile · self-declared skills and time zone"
          trigger={
            <button
              className="icon-button card-open"
              aria-label={`View ${person.displayName}'s profile`}
            >
              <ArrowUpRight size={19} />
            </button>
          }
        >
          <p className="profile-bio">
            {person.bio || "This participant hasn’t added a bio yet."}
          </p>
          <Tags values={person.offeredSkills} />
          <p className="hint">{person.timeZone ?? "Time zone not provided"}</p>
          {person.wantedSkills.length > 0 && (
            <>
              <h3>Looking for</h3>
              <Tags values={person.wantedSkills} muted />
            </>
          )}
          <p className="form-note">
            {person.rankingReady
              ? "Skills and time zone are available for suggestions."
              : "Insufficient information to rank. Normal team participation is still available."}
          </p>
        </Modal>
      </div>
      <p className="card-bio">
        {person.bio || "This participant hasn’t added a bio yet."}
      </p>
      <Tags values={person.offeredSkills} />
      <div className="card-bottom">
        <span>
          <Globe2 size={14} />
          {person.timeZone?.replaceAll("_", " ") ?? "Time zone not set"}
        </span>
        {!person.rankingReady && (
          <span className="tag tag-muted">Unranked</span>
        )}
      </div>
    </article>
  );
}
function TeamCard({
  team,
  commands,
  canRequest,
  requests,
}: {
  team: Team;
  commands: Commands;
  canRequest: boolean;
  requests: JoinRequest[];
}) {
  const pending = requests.some(
    (request) => request.teamId === team.id && request.status === "pending",
  );
  const seats = team.maxSize - team.memberCount;
  return (
    <article className="team-card">
      <div className="card-person">
        <Avatar name={team.name} />
        <div>
          <h3>{team.name}</h3>
          <span className="hint">
            {team.memberCount} of {team.maxSize} members
          </span>
        </div>
        <span className="tag tag-green">
          {seats} {seats === 1 ? "seat" : "seats"} open
        </span>
      </div>
      <div
        className="team-seats"
        aria-label={`${team.memberCount} of ${team.maxSize} seats occupied`}
      >
        {Array.from({ length: team.maxSize }, (_, i) => (
          <span key={i} className={i < team.memberCount ? "filled" : ""}>
            {i < team.memberCount ? <Check size={15} /> : <span>+</span>}
          </span>
        ))}
      </div>
      <p className="eyebrow">Looking for</p>
      {team.wantedSkills.length ? (
        <Tags values={team.wantedSkills} />
      ) : (
        <p className="hint">Open to different skills and perspectives.</p>
      )}
      <div className="card-bottom">
        <span>
          {team.sizeEligible
            ? "Minimum team size met"
            : `Needs ${team.minSize - team.memberCount} more to meet minimum`}
        </span>
        <button
          className="button button-outline button-small"
          disabled={
            !canRequest || pending || commands.busy || !!commands.pending
          }
          onClick={() => {
            void commands.run(
              `/teams/${team.id}/requests`,
              {},
              "Request to join",
            );
          }}
        >
          {pending ? "Request sent" : "Request to join"}
          {!pending && <ArrowUpRight size={15} />}
        </button>
      </div>
    </article>
  );
}
export function DiscoveryBoard({
  eventId,
  identity,
  team,
  commands,
}: {
  eventId: string;
  identity: Identity;
  team: Team | null;
  commands: Commands;
}) {
  const [kind, setKind] = useState<"teams" | "people">(
    team ? "people" : "teams",
  );
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [skill, setSkill] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim());
      setCursors([]);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const queryString = new URLSearchParams({
    kind,
    limit: "12",
    ...(debounced ? { search: debounced } : {}),
    ...(skill ? { skill } : {}),
    ...(cursors.at(-1) ? { after: cursors.at(-1)! } : {}),
  });
  const board = useQuery<Board<Person | Team>>(
    `/events/${eventId}/board?${queryString}`,
  );
  const own = useQuery<Page<JoinRequest>>(
    !team ? `/events/${eventId}/requests?state=pending&limit=50` : null,
  );
  const live = useLive();
  return (
    <section aria-label="Teammate discovery">
      <div className="section-top">
        <div>
          <span className="eyebrow">THE TEAMMATE BOARD</span>
          <h1>
            Find your people<span className="accent">.</span>
          </h1>
          <p>Different skills. Shared ambition. Your next crew starts here.</p>
        </div>
        <span
          className={`live-pill ${live.phase !== "connected" ? "muted" : ""}`}
          role="status"
        >
          <span className="tiny-dot" />
          {live.phase === "connected"
            ? board.stale
              ? "Syncing changes"
              : "Live updates connected"
            : live.phase === "offline"
              ? "Offline · view may be stale"
              : "Reconnecting updates"}
        </span>
      </div>
      <div className="board-tabs" role="group" aria-label="Browse board">
        <button
          aria-pressed={kind === "teams"}
          onClick={() => {
            setKind("teams");
            setCursors([]);
          }}
        >
          <UsersRound size={16} />
          Teams with open seats
        </button>
        <button
          aria-pressed={kind === "people"}
          onClick={() => {
            setKind("people");
            setCursors([]);
          }}
        >
          <Search size={16} />
          People looking for a team
        </button>
      </div>
      <div className="filter-row">
        <label className="search-field">
          <Search size={18} />
          <span className="sr-only">
            Search {kind === "teams" ? "teams" : "people"}
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              kind === "teams"
                ? "Search by team name…"
                : "Search by participant name…"
            }
            maxLength={80}
          />
          <kbd aria-hidden="true">⌕</kbd>
        </label>
        <label className="skill-filter">
          <SlidersHorizontal size={16} />
          <span className="sr-only">Filter by skill</span>
          <select
            value={skill}
            onChange={(e) => {
              setSkill(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">All skills</option>
            {skills.map((s) => (
              <option value={s} key={s}>
                {skillLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="results-heading">
        <h2>{kind === "teams" ? "Room for one more" : "Meet the builders"}</h2>
        <span className="hint">
          {kind === "teams"
            ? "Active teams recruiting now"
            : "Participants without a team"}
        </span>
      </div>
      {!!board.error && <ErrorBox error={board.error} retry={board.reload} />}
      {board.loading && <Busy text="Finding your people…" />}
      {board.data && (
        <>
          {!board.data.admissionsOpen && (
            <p className="notice">
              Team formation is closed. Existing profiles remain visible.
            </p>
          )}
          <div className="discovery-grid" aria-busy={board.stale}>
            {board.data.items.map((item) =>
              "memberCount" in item ? (
                <TeamCard
                  key={item.id}
                  team={item}
                  commands={commands}
                  requests={own.data?.items ?? []}
                  canRequest={
                    !team && board.data!.admissionsOpen && !board.stale
                  }
                />
              ) : (
                <PersonCard key={item.id} person={item} />
              ),
            )}
          </div>
          {!board.data.items.length && (
            <Empty
              title={
                search || skill
                  ? "No matches this time"
                  : kind === "teams"
                    ? "Be the first to make room"
                    : "Everyone here has a crew"
              }
              text={
                search || skill
                  ? "Try another name or skill, or clear your filters."
                  : kind === "teams"
                    ? "Create a team and invite people to build with you."
                    : "New participants will appear here as they register."
              }
              action={
                (search || skill) && (
                  <button
                    className="button button-outline"
                    onClick={() => {
                      setSearch("");
                      setSkill("");
                      setCursors([]);
                    }}
                  >
                    Clear filters
                  </button>
                )
              }
            />
          )}
          <div className="pagination">
            <button
              className="button button-outline button-small"
              disabled={!cursors.length || board.stale}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Previous
            </button>
            <span className="hint">Page {cursors.length + 1}</span>
            <button
              className="button button-outline button-small"
              disabled={!board.data.nextCursor || board.stale}
              onClick={() =>
                setCursors((previous) => [...previous, board.data!.nextCursor!])
              }
            >
              Next <ArrowDown size={14} />
            </button>
          </div>
        </>
      )}
      <p className="board-footnote">
        {team
          ? "Already in a team? Browse freely. Leave your current team before applying elsewhere."
          : "You can apply to more than one team. Joining one cancels your other pending requests in this event."}
      </p>
      <span className="sr-only">Signed in as {identity.name}</span>
    </section>
  );
}
export function SuggestionsView({ eventId }: { eventId: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({
    limit: "12",
    unrankedLimit: "12",
    ...(cursors.at(-1) ? { unrankedAfter: cursors.at(-1)! } : {}),
  });
  const suggestions = useQuery<Suggestions>(
    `/events/${eventId}/teammate-suggestions?${params}`,
  );
  return (
    <section>
      <div className="section-top">
        <div>
          <span className="eyebrow">COMPLEMENTARY SKILLS</span>
          <h1>
            A useful starting point<span className="accent">.</span>
          </h1>
          <p>Suggestions you can understand. People you can get to know.</p>
        </div>
        <Sparkles size={26} className="accent" />
      </div>
      <div className="explanation">
        <h2>Why these people?</h2>
        <p>
          Declared skill coverage comes first. Local time zone proximity breaks
          ties.{" "}
          {suggestions.data?.context.mode === "additional-skills"
            ? "With no wanted skills selected, additional skills are counted up to three."
            : "Wanted skills are compared with each person’s offered skills."}{" "}
          Time zone proximity does not mean working-hour overlap or
          availability.
        </p>
        <p className="hint">
          These are suggestions, not automatic invitations or reserved seats.
        </p>
      </div>
      {suggestions.loading && <Busy />}
      {!!suggestions.error && (
        <ErrorBox error={suggestions.error} retry={suggestions.reload} />
      )}
      {suggestions.data && (
        <>
          <div className="results-heading">
            <h2>Suggested teammates</h2>
            <span className="hint">
              {suggestions.data.rankedCount} eligible to rank
            </span>
          </div>
          <div className="discovery-grid">
            {suggestions.data.items.map((person) => (
              <div key={person.id}>
                <PersonCard person={person} />
                <div className="score-note">
                  {person.matchedSkills?.length
                    ? `Matches: ${person.matchedSkills.map(skillLabel).join(", ")}`
                    : "No additional skill match"}{" "}
                  ·{" "}
                  {suggestions.data!.context.mode === "needs"
                    ? "Wanted skill coverage"
                    : "Additional skill score"}{" "}
                  {Math.round((person.skillScore ?? 0) * 100)}%
                </div>
              </div>
            ))}
          </div>
          {!suggestions.data.items.length && (
            <Empty
              title="No ranked suggestions yet"
              text="Add offered skills and a time zone to your profile. Recruiting leaders also need their teammates’ time zones."
            />
          )}
          <div className="results-heading">
            <h2>More people to discover</h2>
            <span className="hint">Insufficient information to rank</span>
          </div>
          <div className="discovery-grid">
            {suggestions.data.unranked.map((person) => (
              <PersonCard person={person} key={person.id} />
            ))}
          </div>
          <div className="pagination">
            <button
              className="button button-outline button-small"
              disabled={!cursors.length}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous unranked
            </button>
            <button
              className="button button-outline button-small"
              disabled={!suggestions.data.unrankedNextCursor}
              onClick={() =>
                setCursors((c) => [...c, suggestions.data!.unrankedNextCursor!])
              }
            >
              More unranked people
            </button>
          </div>
        </>
      )}
    </section>
  );
}
