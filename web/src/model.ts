import { skillCatalog } from "../../src/skill-catalog";
export type Identity = { id: string; name: string };
export type EventInfo = {
  id: string;
  name: string;
  minSize: number;
  maxSize: number;
  admissionClosesAt: string;
  admissionsOpen: boolean;
  startsAt: string | null;
  endsAt: string | null;
};
export type Profile = {
  displayName: string;
  bio: string;
  offeredSkills: string[];
  wantedSkills: string[];
  timeZone: string | null;
  rankingReady: boolean;
  rankingLabel: string;
  missingInformation: string[];
  profileRevision: number;
};
export type Person = Omit<Profile, "profileRevision"> & {
  id: string;
  skillScore?: number | null;
  zoneScore?: number | null;
  matchedSkills?: string[];
};
export type Team = {
  id: string;
  eventId?: string;
  name: string;
  leaderId: string;
  memberCount: number;
  minSize: number;
  maxSize: number;
  sizeEligible: boolean;
  revision: number;
  frozen?: boolean;
  wantedSkills: string[];
  members?: string[];
  roster?: { id: string; displayName: string }[];
};
export type Membership = {
  eventId: string;
  participantId: string;
  team: Team | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Board<T> = Page<T> & { admissionsOpen: boolean };
export type JoinRequest = {
  id: string;
  teamId: string;
  applicantId: string;
  applicantName?: string;
  teamName?: string;
  status: string;
  reason: string | null;
  at: string;
};
export type HistoryEntry = {
  id: string;
  actorId: string;
  action: string;
  at: string;
  targetIds: string[];
};
export type Invitation = {
  invitationId: string;
  code: string;
  link: string;
  expiresAt: string;
};
export type Suggestions = {
  items: Person[];
  unranked: Person[];
  unrankedNextCursor: string | null;
  rankedCount: number;
  unrankedCount: number;
  context: { kind: string; mode: string; wantedSkills: string[] };
  explanation: { zoneMeaning: string };
};
export type Decision = {
  outcome?: "committed" | "rejected" | "unresolved";
  code?: string;
  operationKey?: string;
  result?: Record<string, unknown>;
  originalStatus?: number;
};

export const skills = skillCatalog;
const labels: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  cpp: "C++",
  react: "React",
  nextjs: "Next.js",
  nodejs: "Node.js",
  ui: "UI",
  "ui-design": "UI design",
  "ux-research": "UX research",
  aws: "AWS",
  ml: "Machine learning",
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  fastapi: "FastAPI",
  devops: "DevOps",
};
export function skillLabel(value: string) {
  return (
    labels[value] ??
    value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ")
  );
}
export function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}
export function personName(id: string, identity: Identity, team?: Team | null) {
  return (
    team?.roster?.find((p) => p.id === id)?.displayName ??
    (id === identity.id ? identity.name : `Participant ${id.slice(-6)}`)
  );
}
