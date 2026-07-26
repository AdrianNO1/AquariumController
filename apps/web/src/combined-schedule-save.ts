export class CombinedScheduleSaveError extends Error {
  override readonly name = "CombinedScheduleSaveError";

  constructor(
    readonly completedCount: number,
    readonly totalCount: number,
    cause: Error,
  ) {
    super(
      `${
        completedCount === 0
          ? "No schedule changes were saved."
          : `${completedCount} of ${totalCount} schedule changes were saved.`
      } ${cause.message}`,
      { cause },
    );
  }
}
