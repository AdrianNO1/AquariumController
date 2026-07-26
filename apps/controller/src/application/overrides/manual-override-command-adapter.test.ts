import { describe, expect, it, vi } from "vitest";

import { ScheduledDeviceOperationDispatcher } from "../scheduling/index.js";
import { ManualOverrideCommandAdapter } from "./manual-override-command-adapter.js";

describe("manual override command adapter", () => {
  it("uses the scheduler command lane and forwards durable reconciliation", async () => {
    const executeDeviceOperation = vi.fn(async () => ({
      id: "child-unknown",
      status: "outcome_unknown" as const,
    }));
    const dispatcher = new ScheduledDeviceOperationDispatcher({
      executeDeviceOperation,
    });
    const reconciled: string[][] = [];
    const adapter = new ManualOverrideCommandAdapter(dispatcher, {
      acknowledgeReconciledOutcomes: async (operationIds) => {
        reconciled.push([...operationIds]);
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
      adapter.dispatch("device-b", {
        kind: "set_pwm",
        pin: 5,
        value: 180,
        overwrite: true,
      }),
    ).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "outcome_unknown" },
    });
    expect(executeDeviceOperation).toHaveBeenCalledTimes(2);

    await adapter.reconcileUnknownOutcomes(["child-unknown", "child-unknown"]);
    expect(reconciled).toEqual([["child-unknown", "child-unknown"]]);
    expect(dispatcher.blockedReason).toBeNull();
  });
});
