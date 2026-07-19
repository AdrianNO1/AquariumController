import { afterEach, describe, expect, it, vi } from "vitest";

import { runSignalShutdown } from "./signal-shutdown.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("signal shutdown", () => {
  it("settles a rejected shutdown, reports it, and marks the process failed", async () => {
    const failure = new Error("teardown failed");
    const reportFailure = vi.fn();

    await expect(
      runSignalShutdown({
        signal: "SIGTERM",
        shutdown: () => Promise.reject(failure),
        reportFailure,
      }),
    ).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(reportFailure).toHaveBeenCalledWith(failure, "SIGTERM");
  });

  it("still settles and marks failure when error reporting throws", async () => {
    await expect(
      runSignalShutdown({
        signal: "SIGINT",
        shutdown: () => Promise.reject(new Error("teardown failed")),
        reportFailure: () => {
          throw new Error("logger failed");
        },
      }),
    ).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
  });
});
