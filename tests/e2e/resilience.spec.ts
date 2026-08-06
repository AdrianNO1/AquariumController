import { operationDetailsResponseSchema } from "@aquarium/contracts";
import { z } from "zod";

import { expect, test } from "./fixtures.js";
import { countCompletedScheduledPwmExchanges } from "./support/production-stack.js";

test.describe.configure({ mode: "serial" });

const reconciledDeviceOutcomeSchema = z.object({
  status: z.literal("outcome_unknown"),
  reconciledAtMs: z.number().int().nonnegative(),
});

interface MqttPublication {
  readonly topic: string;
  readonly payload: string;
}

test("the open UI reconnects after controller restart and replays persisted changes", async ({
  audit,
  page,
  stack,
}) => {
  const beforeRestart = await stack.fetchSnapshot();
  const mainChannel = beforeRestart.channels.find(
    (channel) => channel.id === "light-main",
  );
  if (mainChannel === undefined) {
    throw new Error("The production E2E seed is missing light-main");
  }
  await page.goto("/control/lights");
  const channelList = page.getByRole("list", { name: "Schedule channels" });
  await expect(
    channelList.getByRole("listitem").filter({ hasText: mainChannel.name }),
  ).toBeVisible();

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
    channelList
      .getByRole("listitem")
      .filter({ hasText: "Recovered after restart" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("an offline browser marks state stale, then reconnects and catches up without reload", async ({
  audit,
  context,
  page,
  stack,
}) => {
  const beforeDisconnect = await stack.fetchSnapshot();
  const pumpChannel = beforeDisconnect.channels.find(
    (channel) => channel.id === "pump-main",
  );
  if (pumpChannel === undefined) {
    throw new Error("The production E2E seed is missing pump-main");
  }
  await page.goto("/control/pumps");
  const channelList = page.getByRole("list", { name: "Schedule channels" });
  await expect(
    channelList.getByRole("listitem").filter({ hasText: pumpChannel.name }),
  ).toBeVisible();

  audit.allowExpectedNetworkErrors();
  await context.setOffline(true);
  await expect(page.locator(".stale-banner")).toContainText(
    /Controller state is (?:error|reconnecting|stale)\. This view may be stale;/u,
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
    channelList
      .getByRole("listitem")
      .filter({ hasText: "Pump changed while disconnected" }),
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
  await expect(primaryDevice).toContainText("Online");

  await stack.restartFakeDevices();
  await expect(
    page.locator("article.device-card").filter({ hasText: "A1B2C3D4" }),
  ).toContainText("Online", { timeout: 10_000 });
  // Identical announcements intentionally coalesce last-seen persistence, so
  // restartFakeDevices proves fresh MQTT announcements at the broker instead.
  const primaryAfter = (await stack.fetchSnapshot()).devices.find(
    (device) => device.hardwareId === primaryBefore.hardwareId,
  );
  expect(primaryAfter?.reported).toEqual(primaryBefore.reported);
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
  await deviceCard.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: `Edit ${primary.desired.name}`,
  });
  await dialog.getByLabel("PWM frequency (Hz)").fill("1400");
  const baselineOperationIds = new Set(
    (await stack.fetchSnapshot()).operations.items.map(
      (operation) => operation.id,
    ),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(
      async () => {
        const current = await stack.fetchSnapshot();
        return (
          current.operations.items.find(
            (operation) =>
              operation.kind === "edit_configuration" &&
              operation.deviceId === primary.id &&
              !baselineOperationIds.has(operation.id),
          )?.status ?? "not_created"
        );
      },
      {
        message:
          "the configuration submit should create and complete a new operation",
        timeout: 10_000,
      },
    )
    .toBe("succeeded");
});

test("a dropped fake ESP response remains an explicit unknown outcome", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
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
    await deviceCard.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: `Edit ${primary.desired.name}`,
    });
    await dialog.getByLabel("PWM frequency (Hz)").fill("1200");
    const preSaveSnapshot = await stack.fetchSnapshot();
    const baselineOperationIds = new Set(
      preSaveSnapshot.operations.items.map((operation) => operation.id),
    );
    const editCommandPrefix = `${primary.hardwareId} e `;
    const editPublicationCountBefore = countCorrelatedCommandPublications(
      stack.mqttPublications(),
      editCommandPrefix,
    );
    stack.setFakeResponseFaults("main", {
      dropNextResponseForCommand: "edit_configuration",
    });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    const settled = await stack.waitForSettled();
    const completedScheduledPwmExchangesBeforeReconciliation =
      countCompletedScheduledPwmExchanges(stack.mqttPublications());
    const unknownOperation = settled.operations.items.find(
      (operation) =>
        operation.kind === "edit_configuration" &&
        operation.deviceId === primary.id &&
        !baselineOperationIds.has(operation.id),
    );
    if (unknownOperation === undefined) {
      throw new Error(
        "The dropped response did not create a new configuration operation",
      );
    }
    expect(unknownOperation.status).toBe("outcome_unknown");
    if (unknownOperation.completedAt === null) {
      throw new Error("The unknown configuration operation is not terminal");
    }

    await page.goto("/operations");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Device operation outcomes",
      }),
    ).toBeVisible();
    const operationItem = page
      .locator(".operation-list > li")
      .filter({ hasText: unknownOperation.id });
    await expect(operationItem).toContainText("outcome_unknown");
    await operationItem
      .getByRole("button", { name: `Inspect ${unknownOperation.id}` })
      .click();

    const operationDetails = page.locator(".operation-details");
    await expect(
      operationDetails.getByRole("heading", {
        name: `Operation ${unknownOperation.id}`,
      }),
    ).toBeVisible();
    await expect(
      operationDetails.locator(".operation-detail-summary dd").first(),
    ).toHaveText("outcome_unknown");
    await expect(
      operationDetails.getByText("Device outcome is unknown."),
    ).toBeVisible();

    const verified = operationDetails.getByLabel(
      "I have verified the physical and device state.",
    );
    const reconcile = operationDetails.getByRole("button", {
      name: "Reconcile this unknown device outcome",
    });
    await expect(verified).not.toBeChecked();
    await expect(reconcile).toBeDisabled();

    stack.setFakeResponseFaults("main", {});
    await verified.check();
    await expect(reconcile).toBeEnabled();

    let reconciliationRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/operations/${unknownOperation.id}/reconcile`
      ) {
        reconciliationRequests += 1;
      }
    });
    await reconcile.click();
    await expect.poll(() => reconciliationRequests).toBe(1);

    const completedAtMs = Date.parse(unknownOperation.completedAt);
    await expect
      .poll(async () => {
        const response = await fetch(
          `${stack.baseUrl}/api/operations/${encodeURIComponent(unknownOperation.id)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!response.ok) {
          throw new Error(
            `Operation details request failed with HTTP ${response.status}`,
          );
        }
        const details = operationDetailsResponseSchema.parse(
          await response.json(),
        );
        const result = reconciledDeviceOutcomeSchema.safeParse(
          details.result?.data,
        );
        return (
          details.operation.status === "outcome_unknown" &&
          result.success &&
          result.data.reconciledAtMs >= completedAtMs
        );
      })
      .toBe(true);
    await expect(operationItem).toHaveCount(0);

    await expect
      .poll(
        () =>
          countCompletedScheduledPwmExchanges(stack.mqttPublications()) >
          completedScheduledPwmExchangesBeforeReconciliation,
        {
          message:
            "scheduled output delivery should resume after reconciliation",
          timeout: 15_000,
        },
      )
      .toBe(true);
    const editPublicationCountAfter = countCorrelatedCommandPublications(
      stack.mqttPublications(),
      editCommandPrefix,
    );
    expect(editPublicationCountAfter - editPublicationCountBefore).toBe(1);
  } finally {
    stack.setFakeResponseFaults("main", {});
  }
});

function countCorrelatedCommandPublications(
  publications: readonly MqttPublication[],
  commandPrefix: string,
): number {
  const deviceId = commandPrefix.split(" ", 1)[0];
  return publications.filter(({ topic, payload }) => {
    if (topic !== `test/aquarium/v1/devices/${deviceId}/command`) {
      return false;
    }
    try {
      const request = JSON.parse(payload) as {
        readonly commands?: readonly { readonly kind?: string }[];
      };
      return request.commands?.some(({ kind }) => kind === "edit_configuration") ?? false;
    } catch {
      return false;
    }
  }).length;
}

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
