import {
  createLogFilterFingerprint,
  encodeLogCursor,
  logsListRequestSchema,
} from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLogSearchParams,
  logFilterFormFromRequest,
  parseLogSearchParams,
} from "./log-search-state.js";

describe("log URL state", () => {
  it("parses every supported filter and pagination field", () => {
    const filters = {
      startAtMs: 10,
      endAtMs: 20,
      direction: "inbound",
      kind: "mqtt.command",
      severity: "warning",
      deviceId: "device-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
      outcome: "succeeded",
      retentionClass: "audit",
    } as const;
    const cursor = encodeLogCursor({
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint: createLogFilterFingerprint(filters),
      occurredAtMs: 15,
      id: 2,
    });
    const search = new URLSearchParams({
      startAtMs: "10",
      endAtMs: "20",
      direction: "inbound",
      kind: "mqtt.command",
      severity: "warning",
      deviceId: "device-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
      outcome: "succeeded",
      retentionClass: "audit",
      cursor,
      pageSize: "25",
    });

    expect(parseLogSearchParams(search)).toEqual({
      success: true,
      request: { filters, cursor, pageSize: 25 },
    });
  });

  it("rejects unknown, duplicate, noncanonical, and inconsistent URL input", () => {
    expect(parseLogSearchParams(new URLSearchParams("extra=true"))).toEqual({
      success: false,
      message: "Unsupported log filter: extra",
    });
    expect(
      parseLogSearchParams(
        new URLSearchParams("direction=inbound&direction=outbound"),
      ),
    ).toEqual({
      success: false,
      message: "Duplicate log filter: direction",
    });
    expect(
      parseLogSearchParams(new URLSearchParams("startAtMs=01")),
    ).toMatchObject({ success: false });
    expect(
      parseLogSearchParams(new URLSearchParams("startAtMs=20&endAtMs=10")),
    ).toMatchObject({ success: false });
  });

  it("serializes edited filters without a stale cursor", () => {
    const request = logsListRequestSchema.parse({
      filters: { direction: "inbound" },
      pageSize: 50,
    });
    const form = {
      ...logFilterFormFromRequest(request),
      kind: "mqtt.response",
      pageSize: "25",
    };
    const result = buildLogSearchParams(form);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.search.toString()).toBe(
        "direction=inbound&kind=mqtt.response&pageSize=25",
      );
      expect(result.search.has("cursor")).toBe(false);
    }
  });
});
