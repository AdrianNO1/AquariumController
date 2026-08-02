import { z } from "zod";

export const NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID = "nodemcu-esp32s-v1.1";
export const NODEMCU_ESP32S_V1_1_HARDWARE_MODEL = "Ai-Thinker NodeMCU-32S V1.1";

export const hardwareProfileIdSchema = z.enum([
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
]);

export type HardwareProfileId = z.infer<typeof hardwareProfileIdSchema>;

export interface HardwarePinWarning {
  readonly pin: number;
  readonly message: string;
}

export interface HardwareProfile {
  readonly id: HardwareProfileId;
  readonly label: string;
  readonly model: string;
  readonly pwmPins: readonly number[];
  readonly analogInputPins: readonly number[];
  readonly pinWarnings: readonly HardwarePinWarning[];
}

export const HARDWARE_PROFILES: readonly HardwareProfile[] = Object.freeze([
  Object.freeze({
    id: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
    label: "NodeMCU ESP-32S V1.1",
    model: NODEMCU_ESP32S_V1_1_HARDWARE_MODEL,
    // Excludes reset strapping GPIO0/2/5/15, serial GPIO1/3, flash GPIO6-11,
    // and input-only GPIO34-39. GPIO12 is the documented exception for the
    // already-proven aquarium driver wiring.
    pwmPins: Object.freeze([
      4, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33,
    ]),
    analogInputPins: Object.freeze([32, 33, 34, 35, 36, 39]),
    pinWarnings: Object.freeze([
      Object.freeze({
        pin: 12,
        message:
          "GPIO12 controls the ESP32 flash voltage during reset. The deployed aquarium wiring is known to boot with it, but replacement circuitry must not pull it high while the ESP starts.",
      }),
    ]),
  }),
]);

export function hardwareProfileById(id: HardwareProfileId): HardwareProfile {
  const profile = HARDWARE_PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new RangeError(`Unknown hardware profile ${id}`);
  }
  return profile;
}

export function isAllowedPwmPin(
  hardwareProfileId: HardwareProfileId,
  pin: number,
): boolean {
  return hardwareProfileById(hardwareProfileId).pwmPins.includes(pin);
}
