import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { EventRetentionJobPort } from "../../application/maintenance/daily-event-retention-coordinator.js";
import type { EventsDatabaseSchema } from "../database/types.js";
import {
  runEventRetention,
  type EventRetentionRunResult,
} from "./event-retention.js";
import type { EventArchiveFileWriter } from "./event-archive.js";
import { InteractionRepository } from "./interaction-repository.js";

export interface RunEventRetentionJobOptions {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly archiveDirectory: string;
  readonly routineControlOperationRetention?: RoutineControlOperationRetentionPort;
  readonly notificationDeliveryRetention?: NotificationDeliveryRetentionPort;
  readonly stateRevisionRetention?: StateRevisionRetentionPort;
  readonly createRunId?: () => string;
  readonly archiveFileWriter?: EventArchiveFileWriter;
}

export interface RoutineControlOperationRetentionPort {
  pruneRoutineSucceededOperations(input: { readonly nowMs: number }): Promise<{
    readonly deletedCount: number;
  }>;
}

export interface StateRevisionRetentionPort {
  pruneOrphanedRevisions(): Promise<{ readonly deletedCount: number }>;
}

export interface NotificationDeliveryRetentionPort {
  pruneHistoricalDeliveries(input: { readonly nowMs: number }): Promise<{
    readonly deletedCount: number;
  }>;
}

type StateRetentionStage =
  "routine-control-operations" | "notification-deliveries" | "state-revisions";

const SAFE_ERROR_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;

export class RunEventRetentionJob implements EventRetentionJobPort {
  readonly #database: Kysely<EventsDatabaseSchema>;
  readonly #archiveDirectory: string;
  readonly #routineControlOperationRetention:
    RoutineControlOperationRetentionPort | undefined;
  readonly #notificationDeliveryRetention:
    NotificationDeliveryRetentionPort | undefined;
  readonly #stateRevisionRetention: StateRevisionRetentionPort | undefined;
  readonly #createRunId: () => string;
  readonly #archiveFileWriter: EventArchiveFileWriter | undefined;

  constructor(options: RunEventRetentionJobOptions) {
    if (options.archiveDirectory.trim().length === 0) {
      throw new TypeError("Archive directory must not be empty");
    }
    this.#database = options.database;
    this.#archiveDirectory = options.archiveDirectory;
    this.#routineControlOperationRetention =
      options.routineControlOperationRetention;
    this.#notificationDeliveryRetention = options.notificationDeliveryRetention;
    this.#stateRevisionRetention = options.stateRevisionRetention;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#archiveFileWriter = options.archiveFileWriter;
  }

  async run(input: {
    readonly runAtMs: number;
  }): Promise<EventRetentionRunResult> {
    const result = await runEventRetention({
      database: this.#database,
      archiveDirectory: this.#archiveDirectory,
      nowMs: input.runAtMs,
      runId: this.#createRunId(),
      ...(this.#archiveFileWriter === undefined
        ? {}
        : { archiveFileWriter: this.#archiveFileWriter }),
    });
    if (
      this.#routineControlOperationRetention !== undefined ||
      this.#notificationDeliveryRetention !== undefined ||
      this.#stateRevisionRetention !== undefined
    ) {
      const interactions = new InteractionRepository(this.#database);
      let stage: StateRetentionStage = "routine-control-operations";
      let routineOperationsDeleted = 0;
      let notificationDeliveriesDeleted = 0;
      let revisionsDeleted = 0;
      try {
        const operationRetention =
          this.#routineControlOperationRetention === undefined
            ? { deletedCount: 0 }
            : await this.#routineControlOperationRetention.pruneRoutineSucceededOperations(
                { nowMs: input.runAtMs },
              );
        routineOperationsDeleted = operationRetention.deletedCount;
        stage = "notification-deliveries";
        const deliveryRetention =
          this.#notificationDeliveryRetention === undefined
            ? { deletedCount: 0 }
            : await this.#notificationDeliveryRetention.pruneHistoricalDeliveries(
                { nowMs: input.runAtMs },
              );
        notificationDeliveriesDeleted = deliveryRetention.deletedCount;
        stage = "state-revisions";
        const revisionRetention =
          this.#stateRevisionRetention === undefined
            ? { deletedCount: 0 }
            : await this.#stateRevisionRetention.pruneOrphanedRevisions();
        revisionsDeleted = revisionRetention.deletedCount;
        await interactions.log({
          occurredAtMs: input.runAtMs,
          direction: "internal",
          kind: "maintenance.state-retention",
          severity: "info",
          outcome: "succeeded",
          byteCount: 0,
          retentionClass: "operational",
          payload: {
            notificationDeliveriesDeleted,
            routineOperationsDeleted,
            revisionsDeleted,
          },
          payloadSchemaVersion: 1,
        });
      } catch (error) {
        const retentionError = toError(error);
        try {
          await interactions.log({
            occurredAtMs: input.runAtMs,
            direction: "internal",
            kind: "maintenance.state-retention",
            severity: "error",
            outcome: "failed",
            byteCount: 0,
            retentionClass: "critical",
            payload: {
              failedStage: stage,
              errorClass: sanitizeErrorIdentifier(
                retentionError.constructor.name,
              ),
              notificationDeliveriesDeleted,
              routineOperationsDeleted,
              revisionsDeleted,
            },
            payloadSchemaVersion: 1,
          });
        } catch (logError) {
          throw new AggregateError(
            [retentionError, toError(logError)],
            "State retention and failure logging both failed",
            { cause: logError },
          );
        }
        throw retentionError;
      }
    }
    return result;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizeErrorIdentifier(identifier: string): string {
  return SAFE_ERROR_IDENTIFIER.test(identifier) ? identifier : "Error";
}
