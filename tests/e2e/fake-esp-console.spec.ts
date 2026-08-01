import { AxeBuilder } from "@axe-core/playwright";

import { expect, test } from "./fixtures.js";

test("fake ESP console controls real simulator lifecycle and faults", async ({
  page,
  stack,
}) => {
  await page.goto(stack.fakeEspConsoleUrl);
  await expect(
    page.getByRole("heading", { name: "Fake ESP32 devices" }),
  ).toBeVisible();
  await expect(page.getByText("2 / 2 on", { exact: true })).toBeVisible();

  const main = page.locator('.device-card[data-device-key="main"]');
  await expect(main.getByText("Online", { exact: true })).toBeVisible();
  await expect.poll(() => main.locator(".pin-row").count()).toBeGreaterThan(0);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  try {
    await main.getByRole("button", { name: "Power off" }).click();
    await expect(main.getByText("Power off", { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 2 on", { exact: true })).toBeVisible();

    await main.getByRole("button", { name: "Power on" }).click();
    await expect(main.getByText("Online", { exact: true })).toBeVisible();

    await main.getByRole("button", { name: "Disconnect MQTT" }).click();
    await expect(
      main.getByText("MQTT isolated", { exact: true }),
    ).toBeVisible();
    await main.getByRole("button", { name: "Reconnect MQTT" }).click();
    await expect(main.getByText("Online", { exact: true })).toBeVisible();

    await main.getByLabel("Delay ms").fill("250");
    await main.getByLabel("Drop responses").check();
    await main.getByRole("button", { name: "Apply faults" }).click();
    await expect(page.getByText("Simulator change applied.")).toBeVisible();

    await main.getByLabel("Delay ms").fill("0");
    await main.getByLabel("Drop responses").uncheck();
    await main.getByRole("button", { name: "Apply faults" }).click();
    await expect(page.getByText("Simulator change applied.")).toBeVisible();
  } finally {
    await stack.setFakeDevicePower("main", true);
    stack.setFakeDeviceNetworkEnabled("main", true);
    stack.setFakeResponseFaults("main", {});
  }
});
