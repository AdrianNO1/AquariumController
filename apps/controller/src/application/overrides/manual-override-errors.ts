export class ManualOverrideRevisionConflictError extends Error {
  override readonly name = "ManualOverrideRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Expected state revision ${expectedRevision}, but current revision is ${currentRevision}`,
    );
  }
}

export class ManualOverrideNotFoundError extends Error {
  override readonly name = "ManualOverrideNotFoundError";

  constructor(
    readonly resource: "channel" | "output" | "override" | "operation",
    readonly resourceId: string,
  ) {
    super(`${resource} ${resourceId} does not exist`);
  }
}

export class ManualOverrideConflictError extends Error {
  override readonly name = "ManualOverrideConflictError";

  constructor(
    readonly resource: "channel" | "output" | "override",
    readonly resourceId: string,
    readonly relation: string,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidManualOverrideTransitionError extends Error {
  override readonly name = "InvalidManualOverrideTransitionError";
}

export class ManualOverrideUnavailableError extends Error {
  override readonly name = "ManualOverrideUnavailableError";

  constructor(message = "Manual override service is not accepting operations") {
    super(message);
  }
}
