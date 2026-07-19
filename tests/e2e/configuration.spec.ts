import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("channel, schedule, throttle, and mapping edits persist across reload", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lights" }),
  ).toBeVisible();
  await expect(
    page.locator("article.channel-card").filter({ hasText: "light-main" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create channel" }).click();
  await page.getByLabel("Channel ID").fill("light-accent");
  await page.getByLabel("Channel name").fill("Accent light");
  await page
    .getByRole("button", { name: "Create channel and schedule" })
    .click();

  let accentCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-accent" });
  await expect(accentCard).toContainText("Accent light");
  await expect(accentCard.locator(".schedule-point-row")).toHaveCount(3);
  let settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  await accentCard.getByLabel("New point ID").fill("light-accent-noon");
  await accentCard.getByLabel("UTC time", { exact: true }).fill("12:00");
  await accentCard.getByLabel("Output percent", { exact: true }).fill("35");
  await accentCard.getByRole("button", { name: "Add point" }).click();
  await accentCard.getByRole("button", { name: "Save schedule" }).click();
  await expect(accentCard).toContainText("Graph revision 1");
  settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  await accentCard.getByLabel("Rename channel").fill("Accent blue");
  await accentCard.getByRole("button", { name: "Rename" }).click();
  accentCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-accent" });
  await expect(
    accentCard.getByRole("heading", { name: "Accent blue" }),
  ).toBeVisible();
  settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  const throttleInput = page.getByRole("spinbutton", {
    name: "Throttle percentage",
  });
  await throttleInput.fill("72");
  await page.getByRole("button", { name: "Save throttle" }).click();
  await expect(throttleInput).toHaveValue("72");
  settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  await page.getByLabel("Output gain").fill("0.9");
  await page.getByRole("button", { name: "Save mapping profile" }).click();
  await expect(page.getByLabel("Output gain")).toHaveValue("0.9");
  settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  await page.reload();
  accentCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-accent" });
  await expect(
    accentCard.getByRole("heading", { name: "Accent blue" }),
  ).toBeVisible();
  await expect(accentCard).toContainText("light-accent-noon");
  await expect(
    page.getByRole("spinbutton", { name: "Throttle percentage" }),
  ).toHaveValue("72");
  await expect(page.getByLabel("Output gain")).toHaveValue("0.9");
});

test("device configuration and override outcomes come from real fake ESP responses", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  const deviceCard = page
    .locator("article.device-card")
    .filter({ hasText: "main-a" });
  await expect(deviceCard).toContainText("online");
  await deviceCard
    .getByRole("button", { name: "Edit main-a configuration" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Configure main-a" });
  await dialog.getByLabel("Device name").fill("main-primary");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await expect(
    page.locator("article.device-card").filter({ hasText: "main-primary" }),
  ).toContainText("online");
  const configurationOperation = page
    .locator(".operation-list > li")
    .filter({ hasText: "edit configuration" })
    .filter({ hasText: "A1B2C3D4" })
    .first();
  await expect(configurationOperation).toContainText("succeeded", {
    timeout: 10_000,
  });
  const settled = await stack.waitForSettled();
  await expect(page.locator(".control-page-heading")).toContainText(
    `revision ${settled.revision}`,
  );

  await page.getByLabel("Channel or output").selectOption("channel:light-main");
  await page.getByLabel("Override percentage").fill("42");
  await page.getByRole("button", { name: "Start manual override" }).click();
  const override = page
    .locator("article.override-card")
    .filter({ hasText: "light-main" });
  await expect(override).toContainText("active", { timeout: 10_000 });
  await expect(override).toContainText("42%");
});

test("a live device dialog keeps its opening revision when SSE advances", async ({
  audit,
  page,
  stack,
}) => {
  audit.allowExpectedHttpError(409);
  const before = await stack.fetchSnapshot();
  const device = before.devices.find(
    (candidate) => candidate.hardwareId === "A1B2C3D4",
  );
  if (device === undefined) {
    throw new Error("The production E2E seed is missing device A1B2C3D4");
  }

  await page.goto("/control/lights");
  await page
    .getByRole("button", {
      name: `Edit ${device.desired.name} configuration`,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Configure ${device.desired.name}`,
  });
  const nameInput = dialog.getByLabel("Device name");
  await nameInput.fill("browser-device-draft");

  const current = await stack.fetchSnapshot();
  const competingEdit = await fetch(
    `${stack.baseUrl}/api/devices/${device.id}/configuration`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: current.revision,
        name: "main-external-guard",
      }),
    },
  );
  expect(competingEdit.status).toBe(200);
  await stack.waitForSettled();
  await expect(
    page
      .locator("article.device-card")
      .filter({ hasText: "main-external-guard" }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Save configuration" }).click();

  await expect(dialog.getByRole("alert")).toContainText(
    /Controller state advanced to revision/u,
  );
  await expect(nameInput).toHaveValue("browser-device-draft");
  const after = await stack.fetchSnapshot();
  expect(
    after.devices.find((candidate) => candidate.id === device.id)?.desired.name,
  ).toBe("main-external-guard");
});

test("a stale editor receives a visible revision conflict instead of overwriting state", async ({
  audit,
  page,
  stack,
}) => {
  audit.allowExpectedHttpError(409);
  audit.allowExpectedNetworkErrors();
  const staleSnapshot = await stack.fetchSnapshot();
  const channelBefore = staleSnapshot.channels.find(
    (channel) => channel.id === "light-main",
  );
  if (channelBefore === undefined) {
    throw new Error("The production E2E seed is missing light-main");
  }
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staleSnapshot),
    }),
  );
  await page.route("**/api/events**", (route) =>
    route.abort("connectionfailed"),
  );
  await page.goto("/control/lights");
  const mainCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-main" });
  await expect(mainCard).toBeVisible();

  const currentSnapshot = await stack.fetchSnapshot();
  const competingEdit = await fetch(
    `${stack.baseUrl}/api/channels/light-main`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: currentSnapshot.revision,
        name: "Externally updated light",
      }),
    },
  );
  expect(competingEdit.status).toBe(200);

  await mainCard.getByLabel("Rename channel").fill("Browser stale edit");
  await mainCard.getByRole("button", { name: "Rename" }).click();
  await expect(mainCard.getByRole("alert")).toContainText(
    /Controller state advanced to revision/u,
  );
  const snapshotAfterConflict = await stack.fetchSnapshot();
  const channelAfterConflict = snapshotAfterConflict.channels.find(
    (channel) => channel.id === "light-main",
  );
  expect(channelAfterConflict).toMatchObject({
    ...channelBefore,
    name: "Externally updated light",
    updatedAt: expect.any(String),
  });
  expect(channelAfterConflict?.updatedAt).not.toBe(channelBefore.updatedAt);
});

test("an unmapped created channel can be deleted with its owned schedule", async ({
  page,
}) => {
  await page.goto("/control/lights");
  const accentCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-accent" });
  await accentCard
    .getByRole("button", { name: "Delete channel Accent blue" })
    .click();
  await accentCard.getByRole("button", { name: "Confirm delete" }).click();
  await expect(
    page.locator("article.channel-card").filter({ hasText: "light-accent" }),
  ).toHaveCount(0);
});
