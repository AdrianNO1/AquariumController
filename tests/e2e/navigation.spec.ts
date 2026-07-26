import { AxeBuilder } from "@axe-core/playwright";

import { expect, test } from "./fixtures.js";

const combinedScheduleChartName =
  "All channel output percentages across a UTC day";

const controlAreaRoutes = [
  {
    path: "/control/lights",
    linkName: /^Lights\b/u,
    heading: "Lights",
  },
  {
    path: "/control/pumps",
    linkName: /^Pumps\b/u,
    heading: "Pumps",
  },
  {
    path: "/control/testlights",
    linkName: /^Test lights\b/u,
    heading: "Test lights",
  },
  {
    path: "/control/bad",
    linkName: /^Bad\b/u,
    heading: "Bad",
  },
  {
    path: "/control/loft",
    linkName: /^Loft\b/u,
    heading: "Loft",
  },
  {
    path: "/control/biljard",
    linkName: /^Biljard\b/u,
    heading: "Biljard",
  },
  {
    path: "/control/frag",
    linkName: /^Frag tank\b/u,
    heading: "Frag",
  },
  {
    path: "/control/qt1",
    linkName: /^Quarantine 1\b/u,
    heading: "QT1",
  },
  {
    path: "/control/qt2",
    linkName: /^Quarantine 2\b/u,
    heading: "QT2",
  },
  {
    path: "/control/qt3",
    linkName: /^Quarantine 3\b/u,
    heading: "QT3",
  },
  {
    path: "/control/qt4",
    linkName: /^Quarantine 4\b/u,
    heading: "QT4",
  },
] as const;

const retainedRoutes = [
  ["/", "Overview"],
  ...controlAreaRoutes.map(({ path, heading }) => [path, heading] as const),
  ["/operations", "Device operation outcomes"],
  ["/alerts", "Alerts"],
  ["/logs", "Logs"],
] as const;

test("overview links to every maintained control area", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Overview" }),
  ).toBeVisible();

  for (const { path, linkName } of controlAreaRoutes) {
    await expect(page.getByRole("link", { name: linkName })).toHaveAttribute(
      "href",
      path,
    );
  }
});

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
  for (const [path, heading] of [
    ["/", "Overview"],
    ["/control/lights", "Lights"],
    ["/alerts", "Alerts"],
    ["/logs", "Logs"],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("img", { name: combinedScheduleChartName }),
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

test("area navigation and configuration dialogs work from the keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^Lights\b/u }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lights" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: combinedScheduleChartName }),
  ).toBeVisible();

  const manageChannelsButton = page.getByRole("button", {
    name: "Manage channels",
  });
  await manageChannelsButton.focus();
  await page.keyboard.press("Enter");
  const channelDialog = page.getByRole("dialog", {
    name: "Manage channels",
  });
  await expect(channelDialog).toBeVisible();

  const closeChannelDialog = channelDialog.getByRole("button", {
    name: "Close channel manager",
  });
  await closeChannelDialog.focus();
  await page.keyboard.press("Enter");
  await expect(channelDialog).toBeHidden();

  const pinMappingsButton = page.getByRole("button", {
    name: "Pin mappings",
  });
  await pinMappingsButton.focus();
  await page.keyboard.press("Enter");
  const mappingsDialog = page.getByRole("dialog", {
    name: "Mapping profiles",
  });
  await expect(mappingsDialog).toBeVisible();
  const closeMappingsDialog = mappingsDialog.getByRole("button", {
    name: "Close mapping profiles",
  });
  await expect(closeMappingsDialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      mappingsDialog.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(mappingsDialog).toBeHidden();
});
