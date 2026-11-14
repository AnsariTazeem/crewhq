import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("a participant registers, edits a profile and creates a team with keyboard controls", async ({
  page,
}) => {
  await page.goto("/__test/login?user=newcomer");
  await page.getByRole("button", { name: "Register for this event" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your people." }),
  ).toBeVisible();
  const selectedEvent = new URL(page.url()).searchParams.get("event");
  await page.getByRole("link", { name: "CrewHQ home" }).click();
  expect(new URL(page.url()).searchParams.get("event")).toBe(selectedEvent);
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Morgan Builder");
  await page
    .getByRole("textbox", { name: "A little about you" })
    .fill("Building useful tools for curious people.");
  await page
    .getByRole("group", { name: "Skills you offer" })
    .getByLabel("React", { exact: true })
    .check();
  await page.getByLabel("Time zone (optional)").fill("Asia/Kolkata");
  await page.getByRole("button", { name: "Save changes" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create a team", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Team name" })
    .fill("Quietly Brilliant");
  await page
    .getByRole("button", { name: "Create team", exact: true })
    .press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .getByRole("complementary", { name: "Your participation" })
      .getByRole("heading", { name: "Quietly Brilliant", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "My team", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Quietly Brilliant." }),
  ).toBeVisible();
  await expect(page.getByText("Morgan Builder (you)").first()).toBeVisible();
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
});

test("live requests, acceptance and departure converge across independent signed sessions", async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const leader = await a.newPage();
    const applicant = await b.newPage();
    await leader.goto("/__test/login?user=leader");
    await applicant.goto("/__test/login?user=participant");
    const teams = applicant.getByRole("article");
    await teams
      .filter({
        has: applicant.getByRole("heading", {
          name: "Field Notes",
          exact: true,
        }),
      })
      .getByRole("button", { name: "Request to join" })
      .click();
    await expect(
      teams
        .filter({ hasText: "Field Notes" })
        .getByRole("button", { name: "Request sent" }),
    ).toBeVisible();
    await teams
      .filter({
        has: applicant.getByRole("heading", {
          name: "Open Circuit",
          exact: true,
        }),
      })
      .getByRole("button", { name: "Request to join" })
      .click();
    await leader.getByRole("button", { name: "Requests", exact: true }).click();
    const row = leader
      .getByRole("listitem")
      .filter({ hasText: "Samira Patel" });
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(
      applicant
        .getByRole("complementary", { name: "Your participation" })
        .getByRole("heading", { name: "Open Circuit" }),
    ).toBeVisible();
    await applicant
      .getByRole("button", { name: "Requests", exact: true })
      .click();
    await expect(
      applicant.getByText("accepted", { exact: true }),
    ).toBeVisible();
    await expect(
      applicant.getByText("cancelled", { exact: true }),
    ).toBeVisible();
    await applicant
      .getByRole("button", { name: "My team", exact: true })
      .click();
    await applicant
      .getByRole("button", { name: "Leave team", exact: true })
      .click();
    await applicant.getByRole("button", { name: "Confirm leave" }).click();
    await expect(applicant.getByRole("dialog")).toHaveCount(0);
    await expect(
      applicant.getByRole("heading", { name: "Your crew is out there." }),
    ).toBeVisible();
    await leader.getByRole("button", { name: "My team", exact: true }).click();
    await expect(leader.getByText("Samira Patel", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("invitations require confirmation and removed members require a personal return invitation", async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const leader = await a.newPage();
    const invitee = await b.newPage();
    await leader.goto("/__test/login?user=leader");
    await invitee.goto("/__test/login?user=engineer");
    const eventId = new URL(invitee.url()).searchParams.get("event")!;
    const identity = await (await invitee.request.get("/api/me")).json();
    await leader
      .getByRole("button", { name: "Invite teammates", exact: true })
      .click();
    await leader.getByRole("button", { name: "Get shared invitation" }).click();
    const sharedLink = await leader.getByLabel("Invitation link").inputValue();
    await leader.getByRole("button", { name: "Close dialog" }).click();
    await invitee.goto(sharedLink);
    await expect(invitee.getByRole("dialog")).toBeVisible();
    expect(new URL(invitee.url()).hash).toBe("");
    expect(
      (await (await invitee.request.get(`/api/events/${eventId}/me`)).json())
        .team,
    ).toBeNull();
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await expect(invitee.getByRole("dialog")).toHaveCount(0);
    await expect(
      invitee
        .getByRole("complementary", { name: "Your participation" })
        .getByRole("heading", { name: "Open Circuit" }),
    ).toBeVisible();
    const memberRow = leader
      .getByRole("listitem")
      .filter({ hasText: "Luca Rossi" });
    await memberRow
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await leader.getByRole("button", { name: "Confirm removal" }).click();
    await expect(leader.getByRole("dialog")).toHaveCount(0);
    await expect(
      invitee.getByRole("heading", { name: "Your crew is out there." }),
    ).toBeVisible();
    await invitee.goto(sharedLink);
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await expect(invitee.getByRole("dialog").getByRole("alert")).toContainText(
      "fresh personal invitation",
    );
    await invitee.getByRole("button", { name: "Close dialog" }).click();
    await leader
      .getByRole("button", { name: "Invite teammates", exact: true })
      .click();
    await leader
      .getByText("Personally re-invite a removed member", { exact: true })
      .click();
    await leader
      .getByRole("textbox", { name: "Removed participant ID" })
      .fill(identity.id);
    await leader
      .getByRole("button", { name: "Create personal invitation" })
      .click();
    const personalLink = await leader
      .getByLabel("Invitation link")
      .inputValue();
    await leader.getByRole("button", { name: "Close dialog" }).click();
    await invitee.goto(personalLink);
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await expect(invitee.getByRole("dialog")).toHaveCount(0);
    await expect(
      invitee
        .getByRole("complementary", { name: "Your participation" })
        .getByRole("heading", { name: "Open Circuit" }),
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

test("the phone layout supports navigation, keyboard focus and accessible dialogs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__test/login?user=designer");
  await expect(
    page.getByRole("heading", { name: "Find your people." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Discover", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).press("Enter");
  await page
    .getByRole("button", { name: "Suggestions", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: "A useful starting point." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Display name").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
});

test("a lost create response stays uncertain across reload and reconciles its durable receipt", async ({
  page,
}) => {
  await page.goto("/__test/login?user=second");
  await page.getByRole("button", { name: "Register for this event" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your people." }),
  ).toBeVisible();
  let posts = 0;
  await page.route(/\/api\/events\/[^/]+\/teams$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts++;
    await route.fetch();
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Create a team", exact: true })
    .click();
  await page.getByLabel("Team name").fill("Receipt Keepers");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("complementary", { name: "Your participation" })
      .getByRole("heading", { name: "Receipt Keepers", exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
