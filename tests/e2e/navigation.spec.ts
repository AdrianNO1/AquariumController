import { AxeBuilder } from "@axe-core/playwright";

import { expect, test } from "./fixtures.js";

const retainedRoutes = [
  ["/", "One controller, clear boundaries."],
  ["/control/lights", "Lights"],
  ["/control/pumps", "Pumps"],
  ["/control/testlights", "Test lights"],
  ["/control/bad", "Bad"],
  ["/control/loft", "Loft"],
  ["/control/biljard", "Biljard"],
  ["/control/frag", "Frag"],
  ["/control/qt1", "QT1"],
  ["/control/qt2", "QT2"],
  ["/control/qt3", "QT3"],
  ["/control/qt4", "QT4"],
  ["/alerts", "Alerts"],
  ["/logs", "Logs"],
] as const;

test("all retained direct routes are served by the production SPA and survive reload", async ({
  page,
}) => {
  test.setTimeout(90_000);
  for (const [path, heading] of retainedRoutes) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} initial response`).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();

    const reloadResponse = await page.reload();
    expect(reloadResponse?.status(), `${path} reload response`).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
  }
});

test("invalid routes present a useful 404 and keyboard-accessible recovery", async ({
  page,
}) => {
  const response = await page.goto("/not-a-retained-route");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 1, name: "That page does not exist." }),
  ).toBeVisible();

  const backLink = page.getByRole("link", { name: "Back to overview" });
  await backLink.focus();
  await expect(backLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/u);
});

test("representative production pages pass automated accessibility checks", async ({
  page,
}) => {
  for (const path of ["/", "/control/lights", "/alerts", "/logs"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${path} should have no axe violations`).toEqual(
      [],
    );
  }
});

test("phone, tablet, and desktop layouts avoid page-level horizontal overflow", async ({
  page,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/control/lights");
    await expect(
      page.getByRole("heading", { level: 1, name: "Lights" }),
    ).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
    await expect(
      page.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeVisible();
  }
});

test("primary navigation and channel creation work from the keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Lights", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lights" }),
  ).toBeVisible();

  const createButton = page.getByRole("button", { name: "Create channel" });
  await createButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Channel ID")).toBeVisible();
  await expect(page.getByLabel("Channel name")).toBeVisible();
});
