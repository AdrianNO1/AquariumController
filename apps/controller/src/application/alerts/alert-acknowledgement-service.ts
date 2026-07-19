import type {
  AcknowledgeAlertRequest,
  MutationResult,
} from "@aquarium/contracts";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
  type AlertAcknowledgementCommandPort,
} from "../configuration/configuration-service.js";
import {
  AlertNotFoundError,
  AlertRevisionConflictError,
  InvalidAlertTransitionError,
} from "./alert-service.js";
import type { AlertService } from "./alert-service.js";

export class AlertAcknowledgementService implements AlertAcknowledgementCommandPort {
  constructor(
    private readonly alerts: Pick<AlertService, "acknowledgeAtRevision">,
    private readonly actor = "controller-api",
  ) {}

  async acknowledgeAlert(
    alertId: string,
    request: AcknowledgeAlertRequest,
  ): Promise<MutationResult> {
    try {
      return await this.alerts.acknowledgeAtRevision(
        alertId,
        this.actor,
        request.note,
        request.expectedRevision,
      );
    } catch (error) {
      if (error instanceof AlertNotFoundError) {
        throw new ConfigurationNotFoundError("alert", alertId);
      }
      if (error instanceof AlertRevisionConflictError) {
        throw new ConfigurationRevisionConflictError(
          error.expectedRevision,
          error.currentRevision,
        );
      }
      if (error instanceof InvalidAlertTransitionError) {
        throw new ConfigurationRelationalConflictError([
          {
            resource: "alert",
            id: alertId,
            relation: "state",
            message: error.message,
          },
        ]);
      }
      throw error;
    }
  }
}
