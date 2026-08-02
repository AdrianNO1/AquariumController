import { describe, expect, it } from "vitest";

import {
  hardwareProfileById,
  isAllowedPwmPin,
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
} from "./hardware-profiles.js";

describe("hardware profiles", () => {
  it("allows only usable NodeMCU ESP-32S PWM pins", () => {
    expect(
      hardwareProfileById(NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID).pwmPins,
    ).toEqual([4, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33]);
    for (const pin of [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 15, 20, 24, 34, 39]) {
      expect(
        isAllowedPwmPin(NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID, pin),
      ).toBe(false);
    }
  });

  it("keeps GPIO12 allowed with an explicit reset-strapping warning", () => {
    const profile = hardwareProfileById(
      NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
    );

    expect(isAllowedPwmPin(profile.id, 12)).toBe(true);
    expect(profile.pinWarnings).toEqual([
      expect.objectContaining({
        pin: 12,
        message: expect.stringMatching(/flash voltage/u),
      }),
    ]);
  });
});
