import { z } from "zod";

import { skillCatalog } from "./skill-catalog.js";
export { skillCatalog } from "./skill-catalog.js";

const aliases: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  postgres: "postgresql",
  "react.js": "react",
  "node.js": "nodejs",
  "next.js": "nextjs",
  "c++": "cpp",
};
export const skillTag = z
  .string()
  .max(40)
  .transform((value) => {
    const normalized = value.trim().toLowerCase();
    return aliases[normalized] ?? normalized;
  })
  .pipe(z.enum(skillCatalog));
const tags = (max: number) =>
  z
    .array(skillTag)
    .max(max)
    .transform((values) => [...new Set(values)].sort());
export function resolveNamedTimeZone(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value) || value.length > 64)
    return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
const namedTimeZone = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/)
  .transform((value, context) => {
    const resolved = resolveNamedTimeZone(value);
    if (!resolved) {
      context.addIssue({
        code: "custom",
        message: "A supported named time zone is required",
      });
      return z.NEVER;
    }
    return resolved;
  });
export const profileInput = z.strictObject({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  displayName: z.string().trim().min(1).max(80),
  bio: z.string().trim().max(280).default(""),
  offeredSkills: tags(10).default([]),
  wantedSkills: tags(5).default([]),
  timeZone: namedTimeZone.nullable().default(null),
});
export type ParticipantProfile = Omit<
  z.output<typeof profileInput>,
  "expectedRevision"
> & { profileRevision: number };
export const teamProfileInput = z.strictObject({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(80),
  wantedSkills: tags(5).default([]),
});
export type TeamProfileInput = z.output<typeof teamProfileInput>;

export function publicProfile(
  profile: ParticipantProfile | undefined,
  displayName: string,
) {
  const offeredSkills = profile?.offeredSkills ?? [];
  const timeZone = profile?.timeZone ?? null;
  const missing = [
    ...(!offeredSkills.length ? ["offeredSkills"] : []),
    ...(!timeZone ? ["timeZone"] : []),
  ];
  return {
    displayName: profile?.displayName ?? displayName,
    bio: profile?.bio ?? "",
    offeredSkills,
    wantedSkills: profile?.wantedSkills ?? [],
    timeZone,
    rankingReady: missing.length === 0,
    missingInformation: missing,
    rankingLabel: missing.length
      ? "Insufficient information to rank"
      : "Declared skills and time zone available",
  };
}
