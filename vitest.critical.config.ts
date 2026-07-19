import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: [
      "packages/contracts/**/*.test.ts",
      "packages/domain/**/*.test.ts",
      "packages/esp-protocol/**/*.test.ts",
      "packages/fake-esp/**/*.test.ts",
      "apps/controller/src/**/*.test.ts",
    ],
    exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts"],
  },
});
