import { describe, expect, it } from "vitest";

import {
  localMinuteToUtcMinute,
  utcMinuteToLocalMinute,
} from "./local-time.js";

describe("schedule local-time projection", () => {
  it("projects UTC points into the browser offset and converts edits back", () => {
    expect(utcMinuteToLocalMinute(23 * 60 + 30, -120)).toBe(90);
    expect(localMinuteToUtcMinute(90, -120)).toBe(23 * 60 + 30);
  });

  it("visually shifts the same UTC point when daylight-saving offset changes", () => {
    const utcMinute = 60;
    expect(utcMinuteToLocalMinute(utcMinute, -60)).toBe(120);
    expect(utcMinuteToLocalMinute(utcMinute, -120)).toBe(180);
  });
});
