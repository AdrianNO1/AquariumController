import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test("combined schedule, exact point time, channel color, and schedule multiplier persist", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lights" }),
  ).toBeVisible();
  await expect(page.getByLabel("Combined UTC schedules")).toBeVisible();
  await expect(page.getByRole("button", { name: /Main light/u })).toBeVisible();

  await page.getByRole("button", { name: "Manage channels" }).click();
  const channelDialog = page.getByRole("dialog", {
    name: "Manage channels",
  });
  await channelDialog.getByLabel("New channel color").fill("#e07a2f");
  await channelDialog
    .getByLabel("New channel", { exact: true })
    .fill("Accent light");
  await channelDialog.getByRole("button", { name: "Add" }).click();
  await channelDialog
    .getByLabel("Channel name for Accent light")
    .fill("Accent blue");
  await channelDialog.getByRole("button", { name: "Save changes" }).click();

  let settled = await stack.waitForSettled();
  let accentChannel = settled.channels.find(
    (channel) => channel.name === "Accent blue",
  );
  if (accentChannel === undefined) {
    throw new Error("The channel manager did not create Accent blue");
  }
  const accentChannelId = accentChannel.id;
  expect(accentChannel.color).toBe("#e07a2f");
  expect(
    settled.schedules.find((schedule) => schedule.channelId === accentChannelId)
      ?.points,
  ).toHaveLength(2);

  const accentSelector = page.getByRole("button", {
    name: /Accent blue/u,
  });
  await expect(accentSelector).toBeVisible();
  await accentSelector.click();
  await page.getByRole("button", { name: "New point" }).click();
  const scheduleChart = page.getByRole("img", {
    name: "All channel output percentages across a UTC day",
  });
  const chartBox = await scheduleChart.boundingBox();
  if (chartBox === null) {
    throw new Error("The combined schedule chart has no rendered bounds");
  }
  await scheduleChart.click({
    position: {
      x: chartBox.width / 2,
      y: chartBox.height / 2,
    },
  });

  // Graph interaction snaps to five minutes. Direct entry deliberately does
  // not, so 12:03 proves the operator can retain an exact minute.
  await page.getByLabel("Accent blue selected point UTC time").fill("12:03");
  await page.getByLabel("Accent blue selected point output").fill("35");
  await page.getByRole("button", { name: "Apply point" }).click();
  await expect(page.getByLabel("Accent blue schedule points")).toContainText(
    "12:03 · 35%",
  );

  const multiplier = page.getByLabel("Lights schedule multiplier");
  await multiplier.fill("72");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(
    page.getByText(/Configuration accepted at revision \d+/u),
  ).toBeVisible();

  settled = await stack.waitForSettled();
  accentChannel = settled.channels.find(
    (channel) => channel.id === accentChannelId,
  );
  if (accentChannel === undefined) {
    throw new Error("Accent blue disappeared after saving its schedule");
  }
  const accentSchedule = settled.schedules.find(
    (schedule) => schedule.channelId === accentChannelId,
  );
  expect(accentSchedule?.points).toContainEqual(
    expect.objectContaining({
      minuteOfDay: 12 * 60 + 3,
      percentage: 35,
    }),
  );
  expect(
    settled.throttles.find((throttle) => throttle.typeKey === "light")
      ?.percentage,
  ).toBe(72);

  await page.reload();
  await page.getByRole("button", { name: /Accent blue/u }).click();
  await expect(page.getByLabel("Accent blue schedule points")).toContainText(
    "12:03 · 35%",
  );
  await expect(page.getByLabel("Lights schedule multiplier")).toHaveValue("72");
});

test("mapping profiles use global target search and support create and delete", async ({
  page,
  stack,
}) => {
  const before = await stack.fetchSnapshot();
  const accentChannel = before.channels.find(
    (channel) => channel.name === "Accent blue",
  );
  if (accentChannel === undefined) {
    throw new Error("The prior test did not create Accent blue");
  }

  await page.goto("/control/lights");
  await page.getByRole("button", { name: "Pin mappings" }).click();
  const dialog = page.getByRole("dialog", { name: "Mapping profiles" });
  await dialog.getByLabel("Mapping profile", { exact: true }).selectOption({
    label: "Main rack",
  });
  await dialog.getByLabel("Output multiplier").fill("0.9");
  await dialog.getByRole("button", { name: "Add mapping" }).click();

  const accentMapping = dialog.locator("article.mapping-profile-row").last();
  await accentMapping
    .getByRole("button", { name: /Target for mapping/u })
    .click();
  const accentTargetPicker = dialog.getByRole("dialog", {
    name: /Choose channel target for mapping/u,
  });
  await accentTargetPicker
    .getByLabel("Search all channel targets")
    .fill("Accent blue");
  await accentTargetPicker
    .getByRole("option", { name: "Lights · Accent blue" })
    .click();
  await dialog.getByRole("button", { name: "Save profile" }).click();

  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      const profile = snapshot.mappingProfiles.find(
        (candidate) => candidate.name === "Main rack",
      );
      return {
        gain: profile?.outputGain,
        mapped: profile?.mappings.some(
          (mapping) =>
            mapping.target.kind === "channel" &&
            mapping.target.id === accentChannel.id,
        ),
      };
    })
    .toEqual({ gain: 0.9, mapped: true });

  await dialog.getByRole("button", { name: "New profile" }).click();
  await dialog.getByLabel("Profile name").fill("Browser temporary profile");
  await dialog.getByLabel("Device-name prefix").fill("unused-e2e-");
  await dialog.getByLabel("Output multiplier").fill("0.75");
  await dialog.getByRole("button", { name: "Add mapping" }).click();
  await dialog.getByLabel("Target for mapping 1").click();
  const globalTargetPicker = dialog.getByRole("dialog", {
    name: "Choose channel target for mapping 1",
  });
  await globalTargetPicker
    .getByLabel("Search all channel targets")
    .fill("Return pump");
  await globalTargetPicker
    .getByRole("option", { name: "Pumps · Return pump" })
    .click();
  await dialog.getByRole("button", { name: "Save profile" }).click();

  let temporaryProfileId = "";
  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      const profile = snapshot.mappingProfiles.find(
        (candidate) => candidate.name === "Browser temporary profile",
      );
      temporaryProfileId = profile?.id ?? "";
      return profile === undefined
        ? null
        : {
            gain: profile.outputGain,
            prefix: profile.deviceNamePrefix,
            target: profile.mappings[0]?.target,
          };
    })
    .toEqual({
      gain: 0.75,
      prefix: "unused-e2e-",
      target: { kind: "channel", id: "pump-main" },
    });

  await expect(
    dialog.getByRole("button", { name: "Delete profile" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Delete profile" }).click();
  const confirmation = dialog.getByRole("alertdialog", {
    name: "Delete Browser temporary profile?",
  });
  await confirmation.getByRole("button", { name: "Delete profile" }).click();
  await expect
    .poll(async () =>
      (await stack.fetchSnapshot()).mappingProfiles.some(
        (profile) => profile.id === temporaryProfileId,
      ),
    )
    .toBe(false);

  await dialog.getByRole("button", { name: "Close mapping profiles" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Pin mappings" }).click();
  const reloadedDialog = page.getByRole("dialog", {
    name: "Mapping profiles",
  });
  await reloadedDialog
    .getByLabel("Mapping profile", { exact: true })
    .selectOption({
      label: "Main rack",
    });
  await expect(reloadedDialog.getByLabel("Output multiplier")).toHaveValue(
    "0.9",
  );
  await expect(
    reloadedDialog
      .locator("article.mapping-profile-row")
      .filter({ hasText: "Lights · Accent blue" }),
  ).toBeVisible();
});

test("an unmapped created channel can be deleted with its owned schedule", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  const before = await stack.fetchSnapshot();
  const accentChannel = before.channels.find(
    (channel) => channel.name === "Accent blue",
  );
  if (accentChannel === undefined) {
    throw new Error("Accent blue is missing before its deletion test");
  }

  await page.getByRole("button", { name: "Pin mappings" }).click();
  const mappingDialog = page.getByRole("dialog", {
    name: "Mapping profiles",
  });
  await mappingDialog
    .getByLabel("Mapping profile", { exact: true })
    .selectOption({
      label: "Main rack",
    });
  const accentMapping = mappingDialog
    .locator("article.mapping-profile-row")
    .filter({ hasText: "Lights · Accent blue" });
  await expect(accentMapping).toBeVisible();
  await accentMapping.getByRole("button", { name: /Remove mapping/u }).click();
  await mappingDialog.getByRole("button", { name: "Save profile" }).click();
  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      return snapshot.mappingProfiles.some((profile) =>
        profile.mappings.some(
          (mapping) =>
            mapping.target.kind === "channel" &&
            mapping.target.id === accentChannel.id,
        ),
      );
    })
    .toBe(false);
  await mappingDialog
    .getByRole("button", { name: "Close mapping profiles" })
    .click();

  await page.getByRole("button", { name: "Manage channels" }).click();
  const channelDialog = page.getByRole("dialog", {
    name: "Manage channels",
  });
  const accentRow = channelDialog
    .locator(".channel-management-row")
    .filter({ hasText: "Accent blue" });
  await accentRow.getByRole("button", { name: "Delete Accent blue" }).click();
  await channelDialog.getByRole("button", { name: "Save changes" }).click();

  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      return {
        channelExists: snapshot.channels.some(
          (channel) => channel.id === accentChannel.id,
        ),
        scheduleExists: snapshot.schedules.some(
          (schedule) => schedule.channelId === accentChannel.id,
        ),
      };
    })
    .toEqual({ channelExists: false, scheduleExists: false });
  await expect(page.getByRole("button", { name: /Accent blue/u })).toHaveCount(
    0,
  );
});

test("device and temporary override outcomes come from real fake ESP responses", async ({
  page,
  stack,
}) => {
  await page.goto("/control/lights");
  const deviceCard = page.getByRole("article", {
    name: "ESP32 device main-a",
  });
  await expect(deviceCard).toContainText("Online");
  const beforeConfiguration = await stack.fetchSnapshot();
  const baselineConfigurationOperationIds = new Set(
    beforeConfiguration.operations.items.map((operation) => operation.id),
  );

  await deviceCard.getByRole("button", { name: "Edit", exact: true }).click();
  const deviceDialog = page.getByRole("dialog", { name: "Edit main-a" });
  await deviceDialog.getByLabel("Device name").fill("main-primary");
  await deviceDialog.getByRole("button", { name: "Save" }).click();

  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      const device = snapshot.devices.find(
        (candidate) => candidate.hardwareId === "A1B2C3D4",
      );
      const operation = snapshot.operations.items.find(
        (candidate) =>
          candidate.kind === "edit_configuration" &&
          candidate.deviceId === device?.id &&
          !baselineConfigurationOperationIds.has(candidate.id),
      );
      return {
        desiredName: device?.desired.name,
        reportedName: device?.reported.name,
        operationStatus: operation?.status,
      };
    })
    .toEqual({
      desiredName: "main-primary",
      reportedName: "main-primary",
      operationStatus: "succeeded",
    });
  await expect(
    page.getByRole("article", { name: "ESP32 device main-primary" }),
  ).toContainText("Online");

  const mainSlider = page.getByLabel("Main light temporary override");
  const scheduledValue = await mainSlider.inputValue();
  await page.getByLabel("Duration").selectOption("300");
  await mainSlider.fill("42");
  const beforeOverrides = await stack.fetchSnapshot();
  const baselineOverrideIds = new Set(
    beforeOverrides.overrides.map((override) => override.id),
  );
  await page.getByRole("button", { name: "Apply test levels" }).click();
  await expect(page.locator(".override-command-notice")).toContainText(
    "does not claim actuator success",
  );

  let startedOverrideIds: readonly string[] = [];
  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      const started = snapshot.overrides.filter(
        (override) => !baselineOverrideIds.has(override.id),
      );
      startedOverrideIds = started.map((override) => override.id);
      return started
        .map((override) => ({
          durationMs:
            Date.parse(override.expiresAt) - Date.parse(override.requestedAt),
          status: override.status,
          targetId: override.targetId,
          value:
            override.targetId === "light-main"
              ? override.valuePercentage
              : undefined,
        }))
        .sort((left, right) => left.targetId.localeCompare(right.targetId));
    })
    .toEqual([
      {
        durationMs: 300_000,
        status: "active",
        targetId: "light-main",
        value: 42,
      },
    ]);

  await expect(page.getByRole("button", { name: "Release all" })).toBeEnabled();
  const beforeRelease = await stack.fetchSnapshot();
  const baselineReleaseOperationIds = new Set(
    beforeRelease.operations.items.map((operation) => operation.id),
  );
  await page.getByRole("button", { name: "Release all" }).click();
  await expect(page.locator(".override-command-notice")).toContainText(
    "does not claim actuator success",
  );
  await expect
    .poll(async () => {
      const snapshot = await stack.fetchSnapshot();
      const releaseOperation = snapshot.operations.items.find(
        (operation) =>
          operation.kind === "manual_override_cancel" &&
          operation.deviceId === null &&
          !baselineReleaseOperationIds.has(operation.id),
      );
      return {
        liveOverrideIds: snapshot.overrides
          .filter((override) => startedOverrideIds.includes(override.id))
          .map((override) => override.id),
        releaseStatus: releaseOperation?.status,
      };
    })
    .toEqual({
      liveOverrideIds: [],
      releaseStatus: "succeeded",
    });
  await expect(mainSlider).toHaveValue(scheduledValue);
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
  const deviceCard = page.getByRole("article", {
    name: `ESP32 device ${device.desired.name}`,
  });
  await deviceCard.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: `Edit ${device.desired.name}`,
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
    page.getByRole("article", {
      name: "ESP32 device main-external-guard",
    }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(dialog.getByRole("alert")).toContainText(
    /Controller state advanced to revision/u,
  );
  await expect(nameInput).toHaveValue("browser-device-draft");
  const after = await stack.fetchSnapshot();
  expect(
    after.devices.find((candidate) => candidate.id === device.id)?.desired.name,
  ).toBe("main-external-guard");
});

test("a stale combined schedule draft cannot overwrite newer controller state", async ({
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
  const scheduleBefore = staleSnapshot.schedules.find(
    (schedule) => schedule.channelId === "light-main",
  );
  if (channelBefore === undefined || scheduleBefore === undefined) {
    throw new Error("The production E2E seed is missing the main light");
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

  await page
    .getByRole("button", { name: new RegExp(channelBefore.name, "u") })
    .click();
  await page
    .getByLabel(`${channelBefore.name} selected point UTC time`)
    .fill("00:07");
  await page
    .getByLabel(`${channelBefore.name} selected point output`)
    .fill("10");
  await page.getByRole("button", { name: "Apply point" }).click();

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

  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /schedule changed at controller revision/u }),
  ).toBeVisible();
  const snapshotAfterConflict = await stack.fetchSnapshot();
  expect(
    snapshotAfterConflict.channels.find(
      (channel) => channel.id === "light-main",
    )?.name,
  ).toBe("Externally updated light");
  expect(
    snapshotAfterConflict.schedules.find(
      (schedule) => schedule.channelId === "light-main",
    )?.points,
  ).toEqual(scheduleBefore.points);
});
