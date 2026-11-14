import { useEffect, useMemo, useState } from "react";
import { createAuthClient } from "better-auth/client";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Compass,
  LayoutGrid,
  LogOut,
  Menu,
  RefreshCw,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import { ApiError, message, saveIntent } from "./api";
import { useCommands } from "./commands";
import type { EventInfo, Identity, Membership, Profile } from "./model";
import { LiveConnection } from "./live";
import { ActorContext, LiveContext, useQuery } from "./queries";
import { clearInvitation, invitationTimeRemaining } from "./invitation-context";
import { Avatar, Brand, Busy, ErrorBox } from "./ui";
import { CreateTeam, JoinTeam } from "./actions";
import { DiscoveryBoard, SuggestionsView } from "./board";
import { ProfilePanel, RequestsView, TeamPanel, TeamView } from "./team";

const auth = createAuthClient();
type View = "discover" | "suggestions" | "team" | "requests" | "profile";
export function App({
  eventId,
  invitationCode,
  invitationRevision,
}: {
  eventId: string;
  invitationCode: string;
  invitationRevision: number;
}) {
  const identity = useQuery<Identity>("/me", false);
  if (identity.loading)
    return (
      <div className="boot">
        <Brand />
        <Busy />
      </div>
    );
  if (!identity.data)
    return (
      <SignIn
        error={
          identity.error instanceof ApiError && identity.error.status === 401
            ? null
            : identity.error
        }
        retry={identity.reload}
        eventId={eventId}
      />
    );
  return (
    <Workspace
      key={`${identity.data.id}:${eventId}`}
      identity={identity.data}
      eventId={eventId}
      invitationCode={invitationCode}
      invitationRevision={invitationRevision}
      signedOut={identity.reload}
    />
  );
}
function SignIn({
  error,
  retry,
  eventId,
}: {
  error: unknown;
  retry: () => void;
  eventId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<unknown>(null);
  return (
    <main className="sign-in">
      <div className="login-main">
        <Brand />
        <div className="login-content">
          <span className="eyebrow">LESS SEARCHING. MORE BUILDING.</span>
          <h1>
            Great things
            <br />
            start with
            <br />
            <span>your people.</span>
          </h1>
          <p>
            Find complementary skills, meet your next teammates and make room
            for something good.
          </p>
          <button
            className="button login-button"
            aria-label="Sign in with Google"
            aria-busy={busy}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void auth.signIn
                .social({
                  provider: "google",
                  callbackURL: `${location.origin}/?event=${eventId}`,
                })
                .then(
                  (result) => {
                    if (result.error) {
                      setLoginError(new Error("Sign-in unavailable"));
                      setBusy(false);
                    }
                  },
                  (error) => {
                    setLoginError(error);
                    setBusy(false);
                  },
                );
            }}
          >
            <img src="/google-sign-in.svg" alt="" width="216" height="48" />
          </button>
          {busy && (
            <p role="status" className="hint">
              Connecting to Google…
            </p>
          )}
          <p className="form-note">
            Your identity stays with your account. Team membership is separate
            for every event.
          </p>
          {!!(error || loginError) && (
            <ErrorBox error={error || loginError} retry={retry} />
          )}
        </div>
        <span className="login-footer">
          A place for people who build together.
        </span>
      </div>
      <div className="login-art" aria-hidden="true">
        <div className="art-overline">
          A GOOD TEAM IS MORE THAN A LIST OF NAMES.
        </div>
        <div className="art-orbit">
          <span className="art-node n1">build</span>
          <span className="art-node n2">design</span>
          <span className="art-node n3">explore</span>
          <div className="art-center">
            <img src="/mark.svg" alt="" />
            <span>
              better
              <br />
              together.
            </span>
          </div>
        </div>
        <div className="art-bottom">
          <span>
            Different strengths.
            <br />
            One shared starting point.
          </span>
          <ArrowUpRight size={36} />
        </div>
      </div>
    </main>
  );
}
function Workspace({
  identity,
  eventId,
  invitationCode,
  invitationRevision,
  signedOut,
}: {
  identity: Identity;
  eventId: string;
  invitationCode: string;
  invitationRevision: number;
  signedOut: () => void;
}) {
  const live = useMemo(() => new LiveConnection(eventId), [eventId]);
  return (
    <ActorContext.Provider value={{ id: identity.id, changed: signedOut }}>
      <LiveContext.Provider value={live}>
        <WorkspaceContent
          identity={identity}
          eventId={eventId}
          invitationCode={invitationCode}
          invitationRevision={invitationRevision}
          signedOut={signedOut}
          live={live}
        />
      </LiveContext.Provider>
    </ActorContext.Provider>
  );
}
function WorkspaceContent({
  identity,
  eventId,
  invitationCode,
  invitationRevision,
  signedOut,
  live,
}: {
  identity: Identity;
  eventId: string;
  invitationCode: string;
  invitationRevision: number;
  signedOut: () => void;
  live: LiveConnection;
}) {
  const event = useQuery<EventInfo>(`/events/${eventId}`, false);
  const membership = useQuery<Membership>(`/events/${eventId}/me`);
  const enrolled = !!membership.data;
  const profile = useQuery<Profile>(
    enrolled ? `/events/${eventId}/profile` : null,
  );
  const [view, setView] = useState<View>("discover");
  const [mobileNav, setMobileNav] = useState(false);
  const [code, setCode] = useState(invitationCode);
  const [credential, setCredential] = useState("");
  const [signOutError, setSignOutError] = useState<unknown>(null);
  const commands = useCommands(
    identity.id,
    eventId,
    () => {
      membership.reload();
      event.reload();
      live.recover();
    },
    signedOut,
  );
  useEffect(() => {
    if (!enrolled) return;
    const stop = live.start();
    const visibility = () => {
      if (document.hidden || !navigator.onLine) live.suspend();
      else live.resume();
    };
    const focus = () => {
      if (!document.hidden && navigator.onLine) live.recover();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", visibility);
    window.addEventListener("focus", focus);
    const interval = setInterval(
      () => {
        if (!document.hidden && navigator.onLine) {
          live.recover();
          event.reload();
        }
      },
      30_000 + Math.random() * 3_000,
    );
    return () => {
      stop();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", visibility);
      window.removeEventListener("focus", focus);
    };
  }, [enrolled, live]);
  useEffect(() => {
    setCode(invitationCode);
    const timer = setTimeout(
      () => {
        clearInvitation();
        setCode("");
      },
      invitationTimeRemaining() || (invitationCode ? 300_000 : 0),
    );
    return () => clearTimeout(timer);
  }, [invitationRevision, invitationCode]);
  const team = membership.data?.team ?? null;
  const admissionsOpen =
    !!event.data &&
    new Date(event.data.admissionClosesAt).getTime() > Date.now();
  const canForm = enrolled && admissionsOpen && !team && !membership.stale;
  const signOut = async () => {
    const result = await auth.signOut();
    if (result.error) {
      setSignOutError(new Error("Sign-out unavailable"));
      return;
    }
    saveIntent(null);
    clearInvitation();
    setCode("");
    live.suspend();
    signedOut();
  };
  if (membership.error instanceof ApiError && membership.error.status === 401)
    return <SignIn eventId={eventId} error={null} retry={membership.reload} />;
  const names: Record<View, string> = {
    discover: "Discover",
    suggestions: "Suggestions",
    team: "My team",
    requests: "Requests",
    profile: "My profile",
  };
  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
    commands.clearNotice();
    document.getElementById("main-content")?.focus();
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-brand">
          <button
            className="icon-button mobile-toggle"
            aria-label={mobileNav ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileNav}
            aria-controls="workspace-navigation"
            onClick={() => setMobileNav(!mobileNav)}
          >
            {mobileNav ? <X size={21} /> : <Menu size={21} />}
          </button>
          <Brand />
        </div>
        <div className="event-label">
          <span className="event-monogram">H</span>
          <div>
            <strong>{event.data?.name ?? "Event workspace"}</strong>
            <span>Team formation</span>
          </div>
        </div>
        <div className="topbar-user">
          <Avatar name={identity.name} small />
          <span>{identity.name}</span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => {
              void signOut().catch(setSignOutError);
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <aside
        className={`sidebar ${mobileNav ? "is-open" : ""}`}
        aria-label="Workspace navigation"
        id="workspace-navigation"
      >
        <div className="sidebar-upper">
          <span className="nav-label">WORKSPACE</span>
          <nav>
            {(
              [
                ["discover", Compass],
                ["suggestions", Sparkles],
                ["team", UsersRound],
                ["requests", LayoutGrid],
              ] as const
            ).map(([key, Icon]) => (
              <button
                key={key}
                aria-current={view === key ? "page" : undefined}
                disabled={!enrolled}
                onClick={() => navigate(key)}
              >
                <Icon size={18} />
                <span>{names[key]}</span>
                {view === key && <span className="nav-indicator" />}
              </button>
            ))}
          </nav>
          <div className="sidebar-rule" />
          <span className="nav-label">YOUR PARTICIPATION</span>
          <div className="participation-step">
            <span className={enrolled ? "step done" : "step"}>
              {enrolled ? <Check size={13} /> : "1"}
            </span>
            <div>
              <strong>Register for the event</strong>
              <span>{enrolled ? "You’re on the list" : "Start here"}</span>
            </div>
          </div>
          <div className="participation-step">
            <span className={team ? "step done" : "step"}>
              {team ? <Check size={13} /> : "2"}
            </span>
            <div>
              <strong>Find your crew</strong>
              <span>
                {team
                  ? `${team.memberCount}/${team.maxSize} members`
                  : "Make a connection"}
              </span>
            </div>
          </div>
        </div>
        <div className="sidebar-bottom">
          <div className="small-note">
            <span className="tiny-dot" />
            Room for different strengths.
            <p>
              A profile helps people find you. A conversation helps you find
              your crew.
            </p>
          </div>
          <button
            className="nav-profile"
            onClick={() => navigate("profile")}
            disabled={!enrolled}
          >
            <Avatar name={profile.data?.displayName ?? identity.name} small />
            <span>
              <strong>{profile.data?.displayName ?? identity.name}</strong>
              <span>Participant profile</span>
            </span>
            <ArrowUpRight size={16} />
          </button>
        </div>
      </aside>
      <main id="main-content" className="workspace-main" tabIndex={-1}>
        <div className="breadcrumb">
          <span>Workspace</span>
          <span>/</span>
          <strong>{names[view]}</strong>
          <button
            className="text-button refresh-button"
            onClick={() => {
              membership.reload();
              profile.reload();
              event.reload();
              live.recover();
            }}
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
        {!!signOutError && <ErrorBox error={signOutError} />}
        {commands.pending && (
          <section className="pending-banner" aria-label="Unconfirmed action">
            <strong>{commands.pending.label}: outcome unconfirmed</strong>
            <p>
              A lost response does not mean the action failed. Keep this
              operation key: <code>{commands.pending.key}</code>
            </p>
            <div className="button-row">
              <button
                className="button button-outline button-small"
                disabled={commands.busy}
                onClick={() => {
                  void commands.reconcile();
                }}
              >
                Check status
              </button>
              <button
                className="button button-outline button-small"
                disabled={commands.busy}
                onClick={() => {
                  void commands.reconcile(true, credential);
                }}
              >
                Retry same action
              </button>
            </div>
            {!commands.pending.body && (
              <label>
                Original invitation code (only if retrying)
                <input
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  autoComplete="off"
                  maxLength={22}
                />
              </label>
            )}
          </section>
        )}
        {(commands.error || commands.notice) && (
          <div
            className={`notice ${commands.error ? "notice-error" : ""}`}
            role={commands.error ? "alert" : "status"}
          >
            <span>
              {commands.error ? message(commands.error) : commands.notice}
            </span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={commands.clearNotice}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {event.loading || membership.loading ? (
          <Busy />
        ) : event.error ? (
          <ErrorBox error={event.error} retry={event.reload} />
        ) : !enrolled ? (
          membership.error instanceof ApiError &&
          membership.error.code === "NOT_ENROLLED" ? (
            <div className="registration panel">
              <span className="eyebrow">WELCOME TO THE STARTING LINE</span>
              <h1>
                Your next team
                <br />
                starts here<span className="accent">.</span>
              </h1>
              <p>
                Register for {event.data?.name} to discover people, request a
                seat or create your own crew.
              </p>
              <div className="registration-rules">
                <span>
                  <Check size={16} />
                  Teams of {event.data?.minSize}–{event.data?.maxSize}
                </span>
                <span>
                  <Check size={16} />
                  One team per participant
                </span>
                <span>
                  <Check size={16} />
                  Roster fixed after submission
                </span>
              </div>
              <button
                className="button button-primary"
                disabled={
                  commands.busy || !!commands.pending || !admissionsOpen
                }
                onClick={() => {
                  void commands.run("/enroll", {}, "Register for event");
                }}
              >
                {admissionsOpen
                  ? "Register for this event"
                  : "Registration closed"}
                <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <ErrorBox error={membership.error} retry={membership.reload} />
          )
        ) : (
          <div className="workspace-columns">
            <div className="primary-column">
              {!admissionsOpen && (
                <div className="notice">
                  Team formation is closed. Joining, applications and roster
                  changes may be unavailable.
                </div>
              )}
              {view === "discover" && (
                <>
                  <DiscoveryBoard
                    eventId={eventId}
                    identity={identity}
                    team={team}
                    commands={commands}
                  />
                  {!team && (
                    <div className="start-team-strip">
                      <div>
                        <h2>Have a project in mind?</h2>
                        <p>
                          Start a crew and make room for the skills you need.
                        </p>
                      </div>
                      <div className="button-row">
                        <JoinTeam
                          key={`${code}-${invitationRevision}`}
                          commands={commands}
                          initialCode={code}
                          clearCode={() => {
                            setCode("");
                            clearInvitation();
                          }}
                          disabled={!canForm}
                        />
                        <CreateTeam commands={commands} disabled={!canForm} />
                      </div>
                    </div>
                  )}
                </>
              )}
              {view === "suggestions" && <SuggestionsView eventId={eventId} />}
              {view === "team" && (
                <TeamView
                  key={team?.id ?? "none"}
                  eventId={eventId}
                  identity={identity}
                  team={team}
                  commands={commands}
                />
              )}
              {view === "requests" && (
                <RequestsView
                  key={team?.id ?? "solo"}
                  eventId={eventId}
                  identity={identity}
                  team={team}
                  commands={commands}
                />
              )}
              {view === "profile" && (
                <section>
                  <div className="section-top">
                    <div>
                      <span className="eyebrow">INTRODUCE YOURSELF</span>
                      <h1>
                        Your calling card<span className="accent">.</span>
                      </h1>
                      <p>
                        Show people where your strengths and interests meet.
                      </p>
                    </div>
                  </div>
                  {profile.loading && <Busy />}
                  {!!profile.error && (
                    <ErrorBox error={profile.error} retry={profile.reload} />
                  )}
                  {profile.data && (
                    <div className="panel profile-detail">
                      <Avatar name={profile.data.displayName} />
                      <h2>{profile.data.displayName}</h2>
                      <p>
                        {profile.data.bio ||
                          "Tell people a little about yourself."}
                      </p>
                      <ProfilePanel
                        profile={profile.data}
                        commands={commands}
                      />
                    </div>
                  )}
                </section>
              )}
            </div>
            <aside className="context-column" aria-label="Your participation">
              <TeamPanel
                key={
                  team ? `${team.id}-${team.leaderId}-${team.frozen}` : "solo"
                }
                team={team}
                identity={identity}
                commands={commands}
                eventId={eventId}
              />
              {profile.data && view !== "profile" && (
                <ProfilePanel profile={profile.data} commands={commands} />
              )}
              <div className="context-note">
                <span className="eyebrow">GOOD TO KNOW</span>
                <p>
                  You can form an incomplete team. Meet the minimum size before
                  your event submission.
                </p>
                <span>
                  Build the team before you build the thing.{" "}
                  <ArrowUpRight size={14} />
                </span>
              </div>
            </aside>
          </div>
        )}
        <footer className="workspace-footer">
          <span>CrewHQ</span>
          <span>Made for the people behind the project.</span>
        </footer>
      </main>
    </div>
  );
}
