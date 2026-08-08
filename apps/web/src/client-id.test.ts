import { describe, expect, it } from "vitest";

import { createClientId } from "./client-id.js";

describe("createClientId", () => {
  it("creates a version 4 identifier without crypto.randomUUID", () => {
    expect(createClientId("channel")).toMatch(
      /^channel-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
