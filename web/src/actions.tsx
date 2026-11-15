import { useContext, useState } from "react";
import { Check, Link2, Plus, Settings2, UserRoundPlus } from "lucide-react";
import type { Commands } from "./commands";
import type { Identity, Invitation, Profile, Team } from "./model";
import { personName } from "./model";
import { ApiError, read } from "./api";
import { ActorContext } from "./queries";
import {
  Avatar,
  CommandFeedback,
  CopyButton,
  ErrorBox,
  Modal,
  SkillPicker,
  SubmitButton,
  formAction,
} from "./ui";

type Props = { commands: Commands };
export function CreateTeam({
  commands,
  disabled = false,
}: Props & { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <Modal
      title="Start your crew"
      description="Create a team now. Add teammates before submitting your project."
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="button button-primary" disabled={disabled}>
          <Plus size={17} />
          Create a team
        </button>
      }
    >
      <form
        onSubmit={formAction(async () => {
          if (await commands.run("/teams", { name }, "Create team"))
            setOpen(false);
        })}
      >
        <label>
          Team name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            placeholder="Something worth building together"
          />
        </label>
        <p className="form-note">
          One team per event. Invitations and join requests are managed by the
          team leader.
        </p>
        <CommandFeedback commands={commands} />
        <div className="form-footer">
          <SubmitButton busy={commands.busy} disabled={!!commands.pending}>
            Create team
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}
export function JoinTeam({
  commands,
  initialCode,
  clearCode,
  disabled = false,
}: Props & { initialCode: string; clearCode: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(!!initialCode);
  const [code, setCode] = useState(initialCode);
  return (
    <Modal
      title="Join with an invitation"
      description="A code and an invitation link grant the same permission. A seat is confirmed only when you join successfully."
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="button button-outline" disabled={disabled}>
          <Link2 size={16} />
          Join with code
        </button>
      }
    >
      <form
        onSubmit={formAction(async () => {
          if (
            await commands.run(
              "/invitations/redeem",
              { code: code.trim() },
              "Join with invitation",
              true,
            )
          ) {
            setCode("");
            clearCode();
            setOpen(false);
          }
        })}
      >
        <label>
          Invitation code
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            minLength={22}
            maxLength={22}
            pattern="[A-Za-z0-9_-]{22}"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="Paste your 22-character code"
          />
        </label>
        <p className="form-note">
          You join directly when eligible. If the team is full, ask its leader
          for help. No seat is reserved by opening the link.
        </p>
        <CommandFeedback commands={commands} />
        <div className="form-footer">
          <SubmitButton busy={commands.busy} disabled={!!commands.pending}>
            Accept invitation
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}
export function ProfileEditor({
  profile,
  commands,
}: Props & { profile: Profile }) {
  const [open, setOpen] = useState(false);
  return (
    <Modal
      title="Your participant profile"
      description="Let people know what you bring and what you want to build with others."
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="button button-outline button-small">
          <Settings2 size={15} />
          Edit profile
        </button>
      }
    >
      <ProfileForm
        profile={profile}
        commands={commands}
        close={() => setOpen(false)}
      />
    </Modal>
  );
}
function ProfileForm({
  profile,
  commands,
  close,
}: Props & { profile: Profile; close: () => void }) {
  const [name, setName] = useState(profile.displayName);
  const [revision] = useState(profile.profileRevision);
  const [bio, setBio] = useState(profile.bio);
  const [offered, setOffered] = useState(profile.offeredSkills);
  const [wanted, setWanted] = useState(profile.wantedSkills);
  const [zone, setZone] = useState(profile.timeZone ?? "");
  const zones = Intl.supportedValuesOf("timeZone");
  return (
    <form
      onSubmit={formAction(async () => {
        if (
          await commands.run(
            "/profile",
            {
              expectedRevision: revision,
              displayName: name,
              bio,
              offeredSkills: offered,
              wantedSkills: wanted,
              timeZone: zone || null,
            },
            "Save profile",
          )
        )
          close();
      })}
    >
      <label>
        Display name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
        />
      </label>
      <label>
        A little about you
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          placeholder="What do you enjoy building?"
          rows={3}
        />
      </label>
      <SkillPicker
        label="Skills you offer"
        value={offered}
        onChange={setOffered}
        max={10}
      />
      <SkillPicker
        label="Skills you’re looking for (optional)"
        value={wanted}
        onChange={setWanted}
        max={5}
      />
      <label>
        Time zone (optional)
        <input
          list="time-zones"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          placeholder="For example, Asia/Kolkata"
          maxLength={64}
        />
        <datalist id="time-zones">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </label>
      <button
        className="text-button"
        type="button"
        onClick={() =>
          setZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
        }
      >
        Use my device’s time zone
      </button>
      <p className="form-note">
        Skills and time zone help explain suggestions. They do not verify
        expertise or promise availability. You can participate without them.
      </p>
      <CommandFeedback commands={commands} />
      <div className="form-footer">
        <SubmitButton busy={commands.busy} disabled={!!commands.pending} />
      </div>
    </form>
  );
}
export function TeamEditor({ team, commands }: Props & { team: Team }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);
  const [wanted, setWanted] = useState(team.wantedSkills);
  const [revision, setRevision] = useState(team.revision);
  return (
    <Modal
      title="Team details"
      description="Keep your name and recruiting needs current."
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          className="button button-outline button-small"
          onClick={() => {
            setName(team.name);
            setWanted(team.wantedSkills);
            setRevision(team.revision);
          }}
        >
          <Settings2 size={15} />
          Edit team
        </button>
      }
    >
      <form
        onSubmit={formAction(async () => {
          if (
            await commands.run(
              `/teams/${team.id}/profile`,
              { expectedRevision: revision, name, wantedSkills: wanted },
              "Update team",
            )
          )
            setOpen(false);
        })}
      >
        <label>
          Team name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </label>
        <SkillPicker
          label="Wanted skills (optional)"
          value={wanted}
          onChange={setWanted}
          max={5}
        />
        <CommandFeedback commands={commands} />
        <div className="form-footer">
          <SubmitButton busy={commands.busy} disabled={!!commands.pending} />
        </div>
      </form>
    </Modal>
  );
}
export function InvitationManager({
  team,
  eventId,
  commands,
}: Props & { team: Team; eventId: string }) {
  const actor = useContext(ActorContext);
  const [open, setOpen] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [personal, setPersonal] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [revealing, setRevealing] = useState(false);
  const issue = async (subjectId?: string) => {
    setError(null);
    setInvitation(null);
    const result = await commands.run(
      `/teams/${team.id}/invitations`,
      subjectId ? { kind: "personal", subjectId } : { kind: "shared" },
      subjectId ? "Personal return invitation" : "Create invitation",
    );
    const id = result?.result?.invitationId;
    if (typeof id !== "string") return;
    setRevealing(true);
    try {
      setInvitation(
        await read<Invitation>(
          `/events/${eventId}/teams/${team.id}/invitations/${id}`,
          actor ? { actorId: actor.id } : {},
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
        actor?.changed();
      setError(error);
    } finally {
      setRevealing(false);
    }
  };
  return (
    <Modal
      title="Invite someone to your crew"
      description="Only the current leader manages invitations. Anyone eligible with a shared invitation can join while there is room."
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setInvitation(null);
          setPersonal("");
        }
      }}
      trigger={
        <button className="button button-primary" disabled={team.frozen}>
          <UserRoundPlus size={17} />
          Invite teammates
        </button>
      }
    >
      <button
        className="button button-primary"
        onClick={() => void issue()}
        disabled={commands.busy || !!commands.pending || revealing}
      >
        Get shared invitation
      </button>
      {invitation && (
        <section className="invite-output" aria-label="Active invitation">
          <span className="eyebrow">Invitation code</span>
          <code>{invitation.code}</code>
          <div className="button-row">
            <CopyButton value={invitation.code} label="Copy code" />
            <CopyButton value={invitation.link} label="Copy link" />
          </div>
          <label>
            Invitation link
            <input
              readOnly
              value={invitation.link}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p className="hint">
            Expires {new Date(invitation.expiresAt).toLocaleString()}
          </p>
          <button
            className="text-button danger"
            disabled={commands.busy || !!commands.pending}
            onClick={() => {
              void commands
                .run(
                  `/teams/${team.id}/invitations/${invitation.invitationId}/revoke`,
                  {},
                  "Revoke invitation",
                )
                .then((result) => {
                  if (result) setInvitation(null);
                });
            }}
          >
            Revoke this invitation
          </button>
        </section>
      )}
      <details className="return-invitation">
        <summary>Personally re-invite a removed member</summary>
        <p className="form-note">
          A shared code cannot restore someone you removed. Create a fresh
          invitation bound to their participant ID.
        </p>
        <form onSubmit={formAction(() => issue(personal.trim()))}>
          <label>
            Removed participant ID
            <input
              value={personal}
              onChange={(e) => setPersonal(e.target.value)}
              required
              pattern="[A-Za-z0-9_-]{1,128}"
              maxLength={128}
            />
          </label>
          <SubmitButton
            busy={commands.busy || revealing}
            disabled={!!commands.pending}
          >
            Create personal invitation
          </SubmitButton>
        </form>
      </details>
      {!!error && <ErrorBox error={error} />}
      <CommandFeedback commands={commands} />
    </Modal>
  );
}
export function LeaveTeam({
  team,
  identity,
  commands,
}: Props & { team: Team; identity: Identity }) {
  const [open, setOpen] = useState(false);
  const [successor, setSuccessor] = useState("");
  const needsSuccessor = team.leaderId === identity.id && team.memberCount > 1;
  return (
    <Modal
      title="Leave this team?"
      description={
        team.memberCount === 1
          ? "You are the final member. Leaving closes the team and retains its audit history."
          : "Your spot will be released. Old cancelled requests will stay cancelled; you can send new ones after leaving."
      }
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="button button-outline danger" disabled={team.frozen}>
          Leave team
        </button>
      }
    >
      <form
        onSubmit={formAction(async () => {
          if (
            await commands.run(
              `/teams/${team.id}/leave`,
              needsSuccessor ? { successorId: successor } : {},
              "Leave team",
            )
          )
            setOpen(false);
        })}
      >
        {needsSuccessor && (
          <label>
            Choose the next leader
            <select
              value={successor}
              onChange={(e) => setSuccessor(e.target.value)}
              required
            >
              <option value="">Select a teammate</option>
              {team.members
                ?.filter((id) => id !== identity.id)
                .map((id) => (
                  <option value={id} key={id}>
                    {personName(id, identity, team)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="form-footer">
          <SubmitButton busy={commands.busy} disabled={!!commands.pending}>
            Confirm leave
          </SubmitButton>
        </div>
        <CommandFeedback commands={commands} />
      </form>
    </Modal>
  );
}
export function RemoveMember({
  id,
  team,
  identity,
  commands,
}: Props & { id: string; team: Team; identity: Identity }) {
  const [open, setOpen] = useState(false);
  return (
    <Modal
      title={`Remove ${personName(id, identity, team)}?`}
      description="Their membership ends immediately. They can return only with a fresh personal invitation from the current leader."
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className="text-button danger" disabled={team.frozen}>
          Remove
        </button>
      }
    >
      <div className="button-row">
        <button
          className="button button-danger"
          disabled={commands.busy || !!commands.pending}
          onClick={() => {
            void commands
              .run(
                `/teams/${team.id}/members/${id}/remove`,
                {},
                "Remove member",
              )
              .then((result) => {
                if (result) setOpen(false);
              });
          }}
        >
          Confirm removal
        </button>
      </div>
      <p className="hint">
        Participant ID: <code>{id}</code>
      </p>
      <CommandFeedback commands={commands} />
    </Modal>
  );
}
export function Roster({
  team,
  identity,
  commands,
}: Props & { team: Team; identity: Identity }) {
  return (
    <ul className="roster">
      {team.members?.map((id) => (
        <li key={id}>
          <Avatar name={personName(id, identity, team)} small />
          <div>
            <strong>
              {personName(id, identity, team)}{" "}
              {id === identity.id && <span className="hint">(you)</span>}
            </strong>
            <span className="hint">
              {id === team.leaderId ? "Team leader" : "Member"}
            </span>
          </div>
          {id === team.leaderId ? (
            <Check size={15} className="accent" aria-label="Leader" />
          ) : (
            team.leaderId === identity.id && (
              <RemoveMember
                id={id}
                team={team}
                identity={identity}
                commands={commands}
              />
            )
          )}
        </li>
      ))}
    </ul>
  );
}
