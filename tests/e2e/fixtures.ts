import { expect, test as base } from "@playwright/test";

import {
  startProductionE2eStack,
  type ProductionE2eStack,
} from "./support/production-stack.js";

interface BrowserAudit {
  allowExpectedHttpError(statusCode: number): void;
  allowExpectedNetworkErrors(): void;
}

interface TestFixtures {
  readonly audit: BrowserAudit;
}

interface WorkerFixtures {
  readonly stack: ProductionE2eStack;
}

const expectedNetworkError =
  /(?:ERR_(?:CONNECTION_FAILED|CONNECTION_REFUSED|CONNECTION_RESET|INTERNET_DISCONNECTED|FAILED)|Failed to fetch|Load failed|NetworkError)/iu;
const staticResourceTypes = new Set(["font", "image", "script", "stylesheet"]);

export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    async ({ browserName }, use) => {
      if (browserName !== "chromium") {
        throw new Error(
          `Production E2E currently supports Chromium, received ${browserName}`,
        );
      }
      const stack = await startProductionE2eStack();
      try {
        await use(stack);
      } finally {
        await stack.stop();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.baseUrl);
  },
  audit: [
    async ({ context, page, stack }, use, testInfo) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedAssets: string[] = [];
      const externalRequests: string[] = [];
      const expectedHttpErrorStatuses = new Set<number>();
      let expectedNetworkErrorsAllowed = false;

      await context.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (
          requestUrl.protocol === "http:" ||
          requestUrl.protocol === "https:"
        ) {
          const host = requestUrl.hostname.toLowerCase();
          if (
            host !== "localhost" &&
            host !== "127.0.0.1" &&
            host !== "::1" &&
            host !== "[::1]"
          ) {
            externalRequests.push(requestUrl.toString());
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        if (staticResourceTypes.has(request.resourceType())) {
          failedAssets.push(
            `${request.resourceType()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`,
          );
        }
      });
      page.on("response", (response) => {
        if (
          staticResourceTypes.has(response.request().resourceType()) &&
          !response.ok()
        ) {
          failedAssets.push(
            `${response.request().resourceType()} ${response.url()}: HTTP ${response.status()}`,
          );
        }
      });

      await use({
        allowExpectedHttpError: (statusCode) => {
          expectedHttpErrorStatuses.add(statusCode);
        },
        allowExpectedNetworkErrors: () => {
          expectedNetworkErrorsAllowed = true;
        },
      });

      const unexpectedConsoleErrors = consoleErrors.filter(
        (message) =>
          !(
            expectedNetworkErrorsAllowed && expectedNetworkError.test(message)
          ) &&
          ![...expectedHttpErrorStatuses].some((statusCode) =>
            message.includes(`status of ${statusCode}`),
          ),
      );
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("controller.log", {
          body: stack.controllerLog,
          contentType: "text/plain",
        });
      }
      expect(externalRequests, "browser made an external request").toEqual([]);
      expect(failedAssets, "browser failed to load a production asset").toEqual(
        [],
      );
      expect(pageErrors, "browser emitted an uncaught page error").toEqual([]);
      expect(
        unexpectedConsoleErrors,
        "browser emitted an unexpected console error",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
