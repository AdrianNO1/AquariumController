import type { MutationResult } from "@aquarium/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
} from "../configuration/index.js";
import { AlertAcknowledgementService } from "./alert-acknowledgement-service.js";
import {
  AlertNotFoundError,
  AlertRevisionConflictError,
  InvalidAlertTransitionError,
} from "./alert-service.js";

describe("AlertAcknowledgementService", () => {
  it("delegates the API actor and preserves the mutation result", async () => {
    const result: MutationResult = {
      changed: false,
      revision: 4,
      event: null,
    };
    const acknowledgeAtRevision = vi.fn(
      async (): Promise<MutationResult> => result,
    );
    const service = new AlertAcknowledgementService(
      { acknowledgeAtRevision },
      "test-api",
    );

    await expect(
      service.acknowledgeAlert("alert-main", {
        expectedRevision: 4,
        note: "Checked",
      }),
    ).resolves.toEqual(result);
    expect(acknowledgeAtRevision).toHaveBeenCalledWith(
      "alert-main",
      "test-api",
      "Checked",
      4,
    );
  });

  it.each([
    {
      failure: new AlertNotFoundError("alert-main"),
      mapped: ConfigurationNotFoundError,
    },
    {
      failure: new AlertRevisionConflictError(3, 4),
      mapped: ConfigurationRevisionConflictError,
    },
    {
      failure: new InvalidAlertTransitionError(
        "alert-main",
        "recovered",
        "acknowledged",
      ),
      mapped: ConfigurationRelationalConflictError,
    },
  ])(
    "maps $failure.name to a typed route error",
    async ({ failure, mapped }) => {
      const service = new AlertAcknowledgementService({
        acknowledgeAtRevision: async () => {
          throw failure;
        },
      });

      await expect(
        service.acknowledgeAlert("alert-main", {
          expectedRevision: 3,
          note: null,
        }),
      ).rejects.toBeInstanceOf(mapped);
    },
  );
});
