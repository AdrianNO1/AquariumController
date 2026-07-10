import { healthResponseSchema, type HealthResponse } from "@aquarium/contracts";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Health request failed with HTTP ${response.status}`);
  }

  return healthResponseSchema.parse(await response.json());
}
