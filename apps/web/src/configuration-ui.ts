import { AquariumApiError } from "./api.js";

export function configurationErrorMessage(error: Error): string {
  if (!(error instanceof AquariumApiError)) return error.message;
  switch (error.details.code) {
    case "revision_conflict":
      return `Controller state advanced to revision ${error.details.currentRevision}. Review the refreshed state before saving again.`;
    case "invalid_request":
      return error.details.issues.map((issue) => issue.message).join(" ");
    case "relational_conflict":
      return error.details.conflicts
        .map((conflict) => conflict.message)
        .join(" ");
    default:
      return error.details.message;
  }
}

export function currentRevisionFromError(error: Error): number | null {
  return error instanceof AquariumApiError &&
    error.details.code === "revision_conflict"
    ? error.details.currentRevision
    : null;
}
