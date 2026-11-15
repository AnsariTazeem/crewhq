/** Response checks are part of the benchmark, not a substitute for API tests. */
export function validBoard(body, eventId, query) {
  if (
    !body ||
    body.eventId !== eventId ||
    body.kind !== query.kind ||
    body.admissionsOpen !== true ||
    !Array.isArray(body.items) ||
    body.items.length !== 20 ||
    typeof body.nextCursor !== "string"
  )
    return false;
  if (new Set(body.items.map((item) => item.id)).size !== 20) return false;
  if (
    body.nextCursor !== body.items[19]?.id ||
    body.items.some(
      (item, index) =>
        typeof item.id !== "string" ||
        (query.after && item.id <= query.after) ||
        (index > 0 && item.id <= body.items[index - 1].id),
    )
  )
    return false;
  const forbidden = new Set([
    "email",
    "code",
    "encryptedCode",
    "cookie",
    "token",
    "session",
    "requests",
    "restrictions",
  ]);
  const safe = (value) =>
    value === null ||
    typeof value !== "object" ||
    Object.entries(value).every(
      ([key, child]) => !forbidden.has(key) && safe(child),
    );
  if (!safe(body)) return false;
  return body.items.every((item) => {
    if (typeof item.id !== "string") return false;
    if (query.kind === "people")
      return (
        typeof item.displayName === "string" &&
        Array.isArray(item.offeredSkills) &&
        typeof item.rankingReady === "boolean" &&
        (!query.skill || item.offeredSkills.includes(query.skill)) &&
        (!query.search ||
          item.displayName.toLowerCase().includes(query.search.toLowerCase()))
      );
    return (
      typeof item.name === "string" &&
      Number.isInteger(item.memberCount) &&
      item.memberCount >= 1 &&
      item.memberCount < item.maxSize &&
      item.minSize === 2 &&
      item.maxSize === 4 &&
      item.sizeEligible === item.memberCount >= item.minSize &&
      Array.isArray(item.wantedSkills) &&
      (!query.skill || item.wantedSkills.includes(query.skill)) &&
      (!query.search ||
        item.name.toLowerCase().includes(query.search.toLowerCase()))
    );
  });
}

export function boardQueries(cursors) {
  return [
    { kind: "people" },
    { kind: "teams" },
    { kind: "people", skill: "typescript" },
    { kind: "teams", skill: "ui-design" },
    { kind: "people", search: "Participant 09" },
    { kind: "teams", search: "Crew 01" },
    { kind: "people", after: cursors.people },
    { kind: "teams", after: cursors.teams },
  ];
}
