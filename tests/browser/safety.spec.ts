import { expect, test } from "@playwright/test";

test("an invitation expires before delayed authentication completes", async ({
  page,
}) => {
  await page.clock.install();
  const landing = await page.request.get("/__test/login?user=incomplete");
  const eventId = new URL(landing.url()).searchParams.get("event")!;
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 503, json: { code: "IDENTITY_UNAVAILABLE" } }),
  );
  await page.goto(`/join?event=${eventId}#code=abcdefghijklmnopqrstuv`);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.clock.fastForward(300_001);
  expect(
    await page.evaluate(() => sessionStorage.getItem("crewhq.invitation")),
  ).toBeNull();
  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your people." }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an invitation's lost response offers accessible operation recovery", async ({
  page,
}) => {
  await page.goto("/__test/login?user=builder");
  await page.route(
    /\/api\/events\/[^/]+\/teams\/[^/]+\/invitations$/,
    async (route) => {
      await route.fetch();
      await route.abort("failed");
    },
  );
  await page
    .getByRole("button", { name: "Invite teammates", exact: true })
    .click();
  await page.getByRole("button", { name: "Get shared invitation" }).click();
  await page.getByRole("button", { name: "Review unconfirmed action" }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toHaveCount(0);
});

test("leadership handover closes another tab's private invitation view", async ({
  browser,
}) => {
  const leaderContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const privateView = await leaderContext.newPage();
    const leaving = await leaderContext.newPage();
    const successor = await memberContext.newPage();
    await privateView.goto("/__test/login?user=handover");
    const workspace = privateView.url();
    await leaving.goto(workspace);
    await successor.goto("/__test/login?user=successor");
    await successor
      .getByRole("button", { name: "Requests", exact: true })
      .click();
    await successor.getByRole("button", { name: "Next", exact: true }).click();
    const leaderQueue = successor.waitForRequest((request) =>
      /\/teams\/[^/]+\/requests\?/.test(request.url()),
    );
    await privateView
      .getByRole("button", { name: "Invite teammates", exact: true })
      .click();
    await privateView
      .getByRole("button", { name: "Get shared invitation" })
      .click();
    await expect(privateView.getByLabel("Invitation link")).toBeVisible();
    await leaving.getByRole("button", { name: "My team", exact: true }).click();
    await leaving
      .getByRole("button", { name: "Leave team", exact: true })
      .click();
    await leaving
      .getByLabel("Choose the next leader")
      .selectOption({ label: "Riley Park" });
    await leaving.getByRole("button", { name: "Confirm leave" }).click();
    expect(new URL((await leaderQueue).url()).searchParams.has("after")).toBe(
      false,
    );
    await expect(
      successor.getByRole("heading", { name: "Join requests" }),
    ).toBeVisible();
    await expect(privateView.getByRole("dialog")).toHaveCount(0);
    await expect(
      privateView.getByRole("heading", { name: "Your crew is out there." }),
    ).toBeVisible();
    await expect(
      successor.getByRole("button", { name: "Invite teammates", exact: true }),
    ).toBeEnabled();
  } finally {
    await leaderContext.close();
    await memberContext.close();
  }
});

test("a submitted roster becomes fixed in the live team interface", async ({
  page,
}) => {
  await page.goto("/__test/login?user=frozen");
  await page.getByRole("button", { name: "My team", exact: true }).click();
  expect((await page.request.post("/__test/freeze")).status()).toBe(200);
  await expect(
    page.getByText("This team has submitted. Its roster is now fixed."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Leave team", exact: true }),
  ).toBeDisabled();
  for (const button of await page
    .getByRole("button", { name: "Invite teammates", exact: true })
    .all())
    await expect(button).toBeDisabled();
  for (const button of await page
    .getByRole("button", { name: "Remove", exact: true })
    .all())
    await expect(button).toBeDisabled();
});

test("changing the shared session never replays the old actor's unresolved command", async ({
  page,
  context,
}) => {
  await page.goto("/__test/login?user=actor-a");
  const eventId = new URL(page.url()).searchParams.get("event")!;
  await page.route(/\/api\/events\/[^/]+\/teams$/, (route) =>
    route.abort("failed"),
  );
  await page
    .getByRole("button", { name: "Create a team", exact: true })
    .click();
  await page.getByLabel("Team name").fill("Must stay with original actor");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await page.getByRole("button", { name: "Review unconfirmed action" }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toBeVisible();
  await page.route(/\/api\/events\//, (route) =>
    route.request().url().includes("/operations/")
      ? route.continue()
      : route.abort("failed"),
  );
  const replacement = await context.newPage();
  await replacement.goto("/__test/login?user=actor-b");
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page.getByRole("region", { name: "Unconfirmed action" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Replacement Person Participant profile",
    }),
  ).toBeVisible();
  const mine = await (
    await replacement.request.get(`/api/events/${eventId}/me`)
  ).json();
  expect(mine.team).toBeNull();
});

test("invitation context expires and logout clears tab-local invitation data", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/__test/login?user=tester");
  const eventId = new URL(page.url()).searchParams.get("event")!;
  const link = `/join?event=${eventId}#code=abcdefghijklmnopqrstuv`;
  await page.goto(link);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.clock.fastForward(300_001);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("crewhq.invitation")),
  ).toBeNull();
  await page.goto(link);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("crewhq.invitation")),
  ).toBeNull();
});

test("sign-out preserves an unconfirmed action for the same participant's next sign-in", async ({
  page,
}) => {
  await page.goto("/__test/login?user=recovery");
  await page.route(/\/api\/events\/[^/]+\/teams$/, async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Create a team", exact: true })
    .click();
  await page.getByLabel("Team name").fill("Recovery Crew");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await page.getByRole("button", { name: "Review unconfirmed action" }).click();
  const pending = page.getByRole("region", { name: "Unconfirmed action" });
  const key = await pending.locator("code").textContent();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toContain(
    key,
  );
  await page.goto("/__test/login?user=recovery");
  await expect(pending.locator("code")).toHaveText(key!);
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(pending).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Recovery Crew", exact: true }),
  ).toBeVisible();
});

test("an unconfirmed invitation expires its recovery input without losing the operation key", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/__test/login?user=incomplete");
  const eventId = new URL(page.url()).searchParams.get("event")!;
  let posts = 0;
  await page.route("**/invitations/redeem", (route) => {
    posts++;
    return route.abort("failed");
  });
  await page.goto("/join?event=" + eventId + "#code=abcdefghijklmnopqrstuv");
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await page.getByRole("button", { name: "Review unconfirmed action" }).click();
  const pending = page.getByRole("region", { name: "Unconfirmed action" });
  const key = await pending.locator("code").textContent();
  await page
    .getByLabel("Original invitation code (only if retrying)")
    .fill("abcdefghijklmnopqrstuv");
  await page.clock.fastForward(300_001);
  await page.clock.resume();
  await expect
    .poll(
      async () =>
        (await page
          .getByLabel("Original invitation code (only if retrying)")
          .inputValue()) === "",
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => sessionStorage.getItem("crewhq.invitation") === null,
    ),
  ).toBe(true);
  await expect(pending.locator("code")).toHaveText(key!);
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Re-enter the original invitation code" }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
