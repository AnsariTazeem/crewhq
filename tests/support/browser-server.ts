import express from "express";
import { createTestHarness } from "./harness.js";
import type { Event, Team } from "../../src/membership.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV !== "test")
  throw new Error("Browser fixtures require NODE_ENV=test");
const h = await createTestHarness({
  live: true,
  webDirectory: path.resolve("dist/web"),
});
const eventId = await h.event(4, 2);
await h.db.collection<Event>("events").updateOne(
  { _id: eventId },
  {
    $set: {
      name: "Builders Weekend",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86_400_000),
    },
  },
);
const people = new Map<string, Awaited<ReturnType<typeof h.person>>>();
const definitions = [
  [
    "leader",
    "Avery Chen",
    ["react", "typescript"],
    "Designing thoughtful tools for everyday problems.",
    "America/New_York",
  ],
  [
    "participant",
    "Samira Patel",
    ["python", "ml"],
    "Curious about data, climate and small ideas with a big purpose.",
    "Asia/Kolkata",
  ],
  [
    "designer",
    "Mei Torres",
    ["ui-design", "ux-research"],
    "Turning messy questions into clear, useful experiences.",
    "Europe/London",
  ],
  [
    "engineer",
    "Luca Rossi",
    ["nodejs", "mongodb"],
    "APIs, distributed systems and a very good README.",
    "Europe/Rome",
  ],
  [
    "product",
    "Noah Williams",
    ["product", "pitching"],
    "Good products start with better questions.",
    "America/Chicago",
  ],
  [
    "builder",
    "Jordan Lee",
    ["go", "devops"],
    "Building reliable services, one small improvement at a time.",
    "Asia/Singapore",
  ],
  [
    "tester",
    "Nia Brooks",
    ["testing", "javascript"],
    "Finding the edge cases so your users don’t have to.",
    "America/Toronto",
  ],
  ["incomplete", "Alex Rivera", [], "", null],
] as const;
for (const [alias, name, offered, bio, timeZone] of definitions) {
  const person = await h.person(name);
  people.set(alias, person);
  await h.command(`/api/events/${eventId}/enroll`, person).expect(201);
  await h
    .command(`/api/events/${eventId}/profile`, person, {
      expectedRevision: 0,
      displayName: name,
      offeredSkills: [...offered],
      bio,
      timeZone,
      wantedSkills: ["ui-design", "nodejs"],
    })
    .expect(200);
}
for (const [alias, name, wanted] of [
  ["leader", "Open Circuit", ["ui-design", "python"]],
  ["product", "Field Notes", ["react", "ux-research"]],
  ["builder", "Orbit Studio", ["typescript", "testing"]],
] as const) {
  const person = people.get(alias)!;
  const created = await h
    .command(`/api/events/${eventId}/teams`, person, { name })
    .expect(201);
  await h
    .command(
      `/api/events/${eventId}/teams/${created.body.result.teamId}/profile`,
      person,
      { expectedRevision: 1, name, wantedSkills: [...wanted] },
    )
    .expect(200);
}
people.set("newcomer", await h.person("Morgan Reed"));
people.set("second", await h.person("Taylor Quinn"));
for (const [alias, name] of [
  ["handover", "Casey Lane"],
  ["successor", "Riley Park"],
  ["frozen", "Jamie Stone"],
  ["fixed-member", "Quinn Ellis"],
  ["actor-a", "Original Person"],
  ["actor-b", "Replacement Person"],
]) {
  const person = await h.person(name!);
  people.set(alias!, person);
  await h.command(`/api/events/${eventId}/enroll`, person).expect(201);
}
const handover = people.get("handover")!;
const handoverCreated = await h
  .command(`/api/events/${eventId}/teams`, handover, { name: "Relay Crew" })
  .expect(201);
const handoverTeam = handoverCreated.body.result.teamId as string;
const handoverCode = await h.sharedCode(eventId, handoverTeam, handover);
await h
  .command(
    `/api/events/${eventId}/invitations/redeem`,
    people.get("successor")!,
    { code: handoverCode },
  )
  .expect(201);
const frozenCreated = await h
  .command(`/api/events/${eventId}/teams`, people.get("frozen")!, {
    name: "Fixed Crew",
  })
  .expect(201);
const frozenTeam = frozenCreated.body.result.teamId as string;
const fixedCode = await h.sharedCode(
  eventId,
  frozenTeam,
  people.get("frozen")!,
);
await h
  .command(
    `/api/events/${eventId}/invitations/redeem`,
    people.get("fixed-member")!,
    { code: fixedCode },
  )
  .expect(201);
const app = express();
app.post("/__test/freeze", async (request, response) => {
  if (
    !request
      .get("cookie")
      ?.includes(people.get("frozen")!.cookie.split(";")[0]!)
  ) {
    response.sendStatus(403);
    return;
  }
  const session = h.client.startSession();
  try {
    await session.withTransaction(async () => {
      await h.db
        .collection<Team>("teams")
        .updateOne(
          { _id: frozenTeam },
          { $set: { frozen: true }, $inc: { revision: 1 } },
          { session },
        );
      await h.db
        .collection<{
          _id: string;
          eventId: string;
          category: string;
          teamId: string;
          at: Date;
          expiresAt: Date;
        }>("outbox")
        .insertOne(
          {
            _id: randomUUID(),
            eventId,
            category: "team",
            teamId: frozenTeam,
            at: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
          { session },
        );
    });
    response.sendStatus(200);
  } finally {
    await session.endSession();
  }
});
app.get("/__test/ready", (_request, response) =>
  response.json({ ready: true }),
);
app.get("/__test/login", (request, response) => {
  const person = people.get(String(request.query.user));
  if (!person) {
    response.sendStatus(404);
    return;
  }
  response.setHeader(
    "Set-Cookie",
    `${person.cookie}; Path=/; HttpOnly; SameSite=Lax`,
  );
  response.setHeader("Cache-Control", "no-store");
  response.redirect(`/?event=${eventId}`);
});
app.use(h.app);
const server = app.listen(3000, "127.0.0.1");
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await h.live?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.close();
};
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
