import { readFile } from "node:fs/promises";

import { logsListResponseSchema, type LogEntry } from "@aquarium/contracts";

import { expect, test } from "./fixtures.js";

const generatedOutcomeQuery =
  "/api/logs?direction=outbound&kind=http.response-outcome&pageSize=100";

function isGeneratedValidationOutcome(entry: LogEntry): boolean {
  return (
    entry.payload?.method === "PUT" &&
    entry.payload.routeTemplate === "/api/throttles/:typeKey" &&
    entry.payload.statusCode === 400
  );
}

async function fetchGeneratedOutcomeIds(baseUrl: string): Promise<Set<number>> {
  const response = await fetch(`${baseUrl}${generatedOutcomeQuery}`);
  expect(response.status).toBe(200);
  const page = logsListResponseSchema.parse(await response.json());
  return new Set(
    page.items.filter(isGeneratedValidationOutcome).map(({ id }) => id),
  );
}

test("logs support stable URL filters, pagination, details, and bounded export", async ({
  page,
  stack,
}) => {
  const snapshotBefore = await stack.fetchSnapshot();
  const throttleBefore = snapshotBefore.throttles.find(
    (throttle) => throttle.typeKey === "bad",
  );
  if (throttleBefore === undefined) {
    throw new Error("The production E2E seed is missing the bad throttle");
  }
  const baselineOutcomeIds = await fetchGeneratedOutcomeIds(stack.baseUrl);

  // Generate real, durable HTTP outcome logs without changing controller state.
  // A shared production stack has legitimate background revision producers, so
  // successful chained mutations would make this pagination test inherently racy.
  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(`${stack.baseUrl}/api/throttles/bad`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: snapshotBefore.revision,
        percentage: 101,
      }),
    });
    expect(response.status).toBe(400);
  }

  await expect
    .poll(async () => {
      const currentIds = await fetchGeneratedOutcomeIds(stack.baseUrl);
      return [...currentIds].filter((id) => !baselineOutcomeIds.has(id)).length;
    })
    .toBeGreaterThanOrEqual(30);

  await page.goto(
    "/logs?direction=outbound&kind=http.response-outcome&pageSize=25",
  );
  await expect(page.getByLabel("Log page summary")).toContainText("25");
  await expect(page.locator(".log-entry")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Next page" })).toBeEnabled();

  const firstDetails = page.locator(".log-entry").first().getByRole("group");
  const inspectSummary = page
    .locator(".log-entry")
    .first()
    .locator("summary", { hasText: "Inspect log" });
  await inspectSummary.click();
  await expect(firstDetails).toContainText("Retention");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download CSV export" }).click(),
  ]);
  const downloadPath = await download.path();
  if (downloadPath === null) {
    throw new Error("Playwright did not provide the completed log export path");
  }
  const csv = await readFile(downloadPath, "utf8");
  expect(csv).toContain("http.response-outcome");
  expect(csv.split(/\r?\n/u).length).toBeGreaterThan(2);

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=/u);
  await expect(page.locator(".log-entry")).not.toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(/direction=outbound/u);
  await expect(page).toHaveURL(/kind=http(?:\.|%2E)response-outcome/u);
  await expect(
    page.getByRole("button", { name: "Previous page" }),
  ).toBeDisabled();

  const snapshot = await stack.fetchSnapshot();
  expect(snapshot.revision).toBeGreaterThanOrEqual(snapshotBefore.revision);
  expect(
    snapshot.throttles.find((throttle) => throttle.typeKey === "bad"),
  ).toEqual(throttleBefore);
});

test("invalid log URL state is explicit and never starts an unbounded query", async ({
  page,
}) => {
  await page.goto("/logs?pageSize=1000000");
  await expect(page.getByRole("alert")).toContainText(/invalid|page size/iu);
  await expect(page.locator(".log-entry")).toHaveCount(0);
});
