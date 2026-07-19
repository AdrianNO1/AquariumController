import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("the open UI reconnects after controller restart and replays persisted changes", async ({
  audit,
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  const mainCard = page
    .locator("article.channel-card")
    .filter({ hasText: "light-main" });
  await expect(mainCard).toBeVisible();

  audit.allowExpectedNetworkErrors();
  await stack.restartController();
  const snapshot = await stack.waitForSettled();
  const response = await fetch(`${stack.baseUrl}/api/channels/light-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: snapshot.revision,
      name: "Recovered after restart",
    }),
  });
  expect(response.status).toBe(200);

  await expect(
    page
      .locator("article.channel-card")
      .filter({ hasText: "light-main" })
      .getByRole("heading", { name: "Recovered after restart" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("an offline browser marks state stale, then reconnects and catches up without reload", async ({
  audit,
  context,
  page,
  stack,
}) => {
  await page.goto("/control/pumps");
  const pumpCard = page
    .locator("article.channel-card")
    .filter({ hasText: "pump-main" });
  await expect(pumpCard).toBeVisible();

  audit.allowExpectedNetworkErrors();
  await context.setOffline(true);
  await expect(page.locator(".stale-banner")).toContainText(
    /Controller state is (?:error|reconnecting|stale).*This view may be stale/su,
  );

  const snapshot = await stack.waitForSettled();
  const response = await fetch(`${stack.baseUrl}/api/channels/pump-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: snapshot.revision,
      name: "Pump changed while disconnected",
    }),
  });
  expect(response.status).toBe(200);

  await context.setOffline(false);
  await expect(
    page
      .locator("article.channel-card")
      .filter({ hasText: "pump-main" })
      .getByRole("heading", { name: "Pump changed while disconnected" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".stale-banner")).toHaveCount(0);
});

test("fake ESP persistent state survives actor restart", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  const beforeRestart = await stack.fetchSnapshot();
  const primaryBefore = beforeRestart.devices.find(
    (device) => device.hardwareId === "A1B2C3D4",
  );
  if (primaryBefore === undefined) {
    throw new Error("Primary fake ESP is missing from the snapshot");
  }
  const primaryDevice = page
    .locator("article.device-card")
    .filter({ hasText: "A1B2C3D4" });
  await expect(primaryDevice).toContainText("online");

  await stack.restartFakeDevices();
  await expect(
    page.locator("article.device-card").filter({ hasText: "A1B2C3D4" }),
  ).toContainText("online", { timeout: 10_000 });
  if (primaryBefore.reported.name !== null) {
    await expect(
      page.locator("article.device-card").filter({ hasText: "A1B2C3D4" }),
    ).toContainText(`Reported: ${primaryBefore.reported.name}`);
  }
});

test("controller and fake ESP clients recover after a real broker restart", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  await stack.restartBroker();

  const snapshot = await stack.waitForSettled();
  const primary = snapshot.devices.find(
    (device) => device.hardwareId === "A1B2C3D4",
  );
  if (primary === undefined) {
    throw new Error("Primary fake ESP is missing after broker restart");
  }
  const deviceCard = page
    .locator("article.device-card")
    .filter({ hasText: "A1B2C3D4" });
  await deviceCard
    .getByRole("button", {
      name: `Edit ${primary.desired.name} configuration`,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Configure ${primary.desired.name}`,
  });
  await dialog.getByLabel("PWM frequency (Hz)").fill("1400");
  await dialog.getByRole("button", { name: "Save configuration" }).click();

  const operation = page
    .locator(".operation-list > li")
    .filter({ hasText: "edit configuration" })
    .filter({ hasText: "A1B2C3D4" })
    .first();
  await expect(operation).toContainText("succeeded", { timeout: 10_000 });
});

test("a dropped fake ESP response remains an explicit unknown outcome", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  stack.setFakeResponseFaults("main", { drop: true });
  try {
    const snapshot = await stack.fetchSnapshot();
    const primary = snapshot.devices.find(
      (device) => device.hardwareId === "A1B2C3D4",
    );
    if (primary === undefined) {
      throw new Error("Primary fake ESP is missing from the snapshot");
    }
    const deviceCard = page
      .locator("article.device-card")
      .filter({ hasText: "A1B2C3D4" });
    await deviceCard
      .getByRole("button", {
        name: `Edit ${primary.desired.name} configuration`,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Configure ${primary.desired.name}`,
    });
    await dialog.getByLabel("PWM frequency (Hz)").fill("1200");
    await dialog.getByRole("button", { name: "Save configuration" }).click();
    await expect(
      page.getByRole("heading", { name: "Recent operations" }),
    ).toBeVisible();
    await expect(page.locator(".operation-list")).toContainText(
      "outcome_unknown",
      { timeout: 10_000 },
    );
  } finally {
    stack.setFakeResponseFaults("main", {});
  }
});

test("device-offline alert can be acknowledged and recovers when fakes resume", async ({
  page,
  stack,
}) => {
  await page.goto("/alerts");
  await stack.pauseFakeDevices();
  try {
    const alertCard = page
      .locator("article.alert-card")
      .filter({ hasText: "A1B2C3D4" });
    await expect(alertCard).toContainText("Device health:", {
      timeout: 25_000,
    });
    await alertCard
      .getByLabel("Acknowledgement note (optional)")
      .fill("Verified by Playwright");
    await alertCard.getByRole("button", { name: "Acknowledge alert" }).click();
    await expect(alertCard).toContainText("acknowledged");
  } finally {
    await stack.resumeFakeDevices();
  }

  await page.getByLabel("Lifecycle state").selectOption("recovered");
  await expect(
    page.locator("article.alert-card").filter({ hasText: "A1B2C3D4" }),
  ).toContainText("recovered", { timeout: 10_000 });
});
