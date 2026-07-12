import { describe, expect, it } from "vitest";

import { parseJsonDocument } from "./strict-json.js";

describe("strict JSON parsing", () => {
  it("parses the complete JSON value grammar", () => {
    const parsed = parseJsonDocument(
      '{"text":"line\\n\\u00f8","values":[null,true,false,-1.25e2]}',
    );

    expect(parsed.value).toEqual({
      text: "line\nø",
      values: [null, true, false, -125],
    });
    expect(parsed.duplicateKeys).toEqual([]);
  });

  it("reports exact duplicate keys at every object path", () => {
    const parsed = parseJsonDocument(
      '{"name":1,"name":2,"nested":{"pin":1,"pin":2},"rows":[{"id":1,"id":2}]}',
      "fixture.json",
    );

    expect(parsed.duplicateKeys).toEqual([
      expect.objectContaining({ key: "name", objectPath: "$" }),
      expect.objectContaining({ key: "pin", objectPath: '$["nested"]' }),
      expect.objectContaining({ key: "id", objectPath: '$["rows"][0]' }),
    ]);
  });

  it("preserves case-distinct keys", () => {
    const parsed = parseJsonDocument('{"bad Uv":1,"Bad Uv":2}');

    expect(parsed.duplicateKeys).toEqual([]);
    expect(parsed.value).toEqual({ "bad Uv": 1, "Bad Uv": 2 });
  });

  it.each([
    "{",
    "[1,]",
    '{"key" 1}',
    '{"key":"unterminated}',
    "01",
    "true false",
  ])("rejects malformed JSON: %s", (source) => {
    expect(() => parseJsonDocument(source, "broken.json")).toThrow(
      /broken\.json/,
    );
  });
});
