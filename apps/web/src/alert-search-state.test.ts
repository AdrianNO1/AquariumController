import { describe, expect, it } from "vitest";

import {
  buildAlertSearchParams,
  parseAlertSearchParams,
} from "./alert-search-state.js";

describe("alert URL state", () => {
  it("parses a bounded recovered-history page", () => {
    expect(
      parseAlertSearchParams(
        new URLSearchParams({
          state: "recovered",
          pageSize: "10",
          cursor: "cursor_2",
        }),
      ),
    ).toEqual({
      success: true,
      request: {
        state: "recovered",
        pageSize: 10,
        cursor: "cursor_2",
      },
    });
  });

  it("rejects duplicate, unknown, and out-of-range fields", () => {
    expect(
      parseAlertSearchParams(new URLSearchParams("state=open&state=all")),
    ).toMatchObject({ success: false });
    expect(
      parseAlertSearchParams(new URLSearchParams("state=invalid")),
    ).toMatchObject({ success: false });
    expect(
      parseAlertSearchParams(new URLSearchParams("pageSize=51")),
    ).toMatchObject({ success: false });
    expect(parseAlertSearchParams(new URLSearchParams("extra=true"))).toEqual({
      success: false,
      message: "Unsupported alert filter: extra",
    });
  });

  it("changes filters without carrying a state-bound cursor", () => {
    const search = buildAlertSearchParams("acknowledged", 25);
    expect(search.toString()).toBe("state=acknowledged&pageSize=25");
    expect(search.has("cursor")).toBe(false);
  });
});
