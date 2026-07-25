import { describe, expect, it, vi } from "vitest";

import { ScheduledDeviceOperationDispatcher } from "../scheduling/index.js";
import { ManualOverrideCommandAdapter } from "./manual-override-command-adapter.js";

describe("manual override command adapter", () => {
  it("uses the scheduler command lane and clears it only after durable reconciliation", async () => {
    const executeDeviceOperation = vi.fn(async () => ({
      id: "child-unknown",
      status: "outcome_unknown" as const,
    }));
    const dispatcher = new ScheduledDeviceOperationDispatcher({
      executeDeviceOperation,
    });
    const reconciled: string[] = [];
    const adapter = new ManualOverrideCommandAdapter(dispatcher, {
      acknowledgeReconciledOutcome: async (operationId) => {
        reconciled.push(operationId);
        await dispatcher.acknowledgeReconciledOutcome();
      },
    });

    await expect(
      adapter.dispatch("device-a", {
        kind: "set_pwm",
        pin: 4,
        value: 200,
        overwrite: true,
      }),
    ).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "outcome_unknown" },
    });
    await expect(
      adapter.dispatch("device-a", {
        kind: "set_pwm",
        pin: 4,
        value: 200,
        overwrite: true,
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "outcome_unknown" });
    expect(executeDeviceOperation).toHaveBeenCalledTimes(1);

    await adapter.reconcileUnknownOutcome("child-unknown");
    expect(reconciled).toEqual(["child-unknown"]);
    expect(dispatcher.blockedReason).toBeNull();
  });
});
