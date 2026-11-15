import { expect, test } from "vitest";
import { validBoard } from "../scripts/load/contract.js";
const people = {
  eventId: "event",
  kind: "people",
  admissionsOpen: true,
  nextCursor: "19",
  items: Array.from({ length: 20 }, (_, id) => ({
    id: String(id).padStart(2, "0"),
    displayName: `Participant ${id}`,
    offeredSkills: ["typescript"],
    rankingReady: true,
  })),
};
test("the board measurement accepts meaningful correctly filtered pages", () => {
  expect(
    validBoard(people, "event", { kind: "people", skill: "typescript" }),
  ).toBe(true);
});
test.each([
  { ...people, items: [] },
  { ...people, items: Array(20).fill(people.items[0]) },
  { ...people, kind: "teams" },
  { ...people, eventId: "different" },
  { ...people, code: "sensitive" },
  {
    ...people,
    items: people.items.map((item) => ({
      ...item,
      email: "private@example.test",
    })),
  },
])(
  "a fast invalid board response cannot count as successful evidence",
  (body) => {
    expect(validBoard(body, "event", { kind: "people" })).toBe(false);
  },
);
test("a response which ignored the skill filter is invalid", () => {
  expect(validBoard(people, "event", { kind: "people", skill: "python" })).toBe(
    false,
  );
});
test("a repeated first page cannot satisfy a later-page measurement", () => {
  expect(validBoard(people, "event", { kind: "people", after: "19" })).toBe(
    false,
  );
});
