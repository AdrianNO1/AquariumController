import type { ManualOverrideOverlayOutput } from "./manual-override-types.js";

export interface ScheduledOutputRefreshCommand {
  readonly deviceId: string;
  readonly mappingId: string;
  readonly pin: number;
  readonly value: number;
  readonly overwrite: false;
}

export interface EffectiveOutputRefreshCommand {
  readonly deviceId: string;
  readonly mappingId: string;
  readonly pin: number;
  readonly value: number;
  readonly overwrite: boolean;
  readonly overrideId: string | null;
}

/**
 * Replaces scheduled commands by device-and-mapping identity, then appends
 * active overrides for output or unscheduled mappings that have no base row.
 */
export function applyManualOverrideOverlays(
  scheduled: readonly ScheduledOutputRefreshCommand[],
  overlays: readonly ManualOverrideOverlayOutput[],
): readonly EffectiveOutputRefreshCommand[] {
  const overlayByMapping = new Map<string, ManualOverrideOverlayOutput>();
  const overlayPins = new Set<string>();
  for (const overlay of overlays) {
    const mappingKey = key(overlay.deviceId, overlay.mappingId);
    const pinKey = key(overlay.deviceId, String(overlay.pin));
    if (overlayByMapping.has(mappingKey) || overlayPins.has(pinKey)) {
      throw new TypeError(
        `Manual override overlays overlap at ${overlay.deviceId} pin ${overlay.pin}`,
      );
    }
    overlayByMapping.set(mappingKey, overlay);
    overlayPins.add(pinKey);
  }

  const scheduledMappings = new Set<string>();
  const effectivePins = new Set<string>();
  const commands: EffectiveOutputRefreshCommand[] = [];
  for (const command of scheduled) {
    const mappingKey = key(command.deviceId, command.mappingId);
    if (scheduledMappings.has(mappingKey)) {
      throw new TypeError(
        `Scheduled refresh has duplicate mapping ${command.mappingId} for ${command.deviceId}`,
      );
    }
    scheduledMappings.add(mappingKey);
    const overlay = overlayByMapping.get(mappingKey);
    const effective =
      overlay === undefined
        ? {
            ...command,
            overrideId: null,
          }
        : {
            deviceId: overlay.deviceId,
            mappingId: overlay.mappingId,
            pin: overlay.pin,
            value: overlay.value,
            overwrite: true,
            overrideId: overlay.overrideId,
          };
    assertUniqueEffectivePin(effectivePins, effective);
    commands.push(effective);
  }

  const appended = overlays
    .filter(
      (overlay) =>
        !scheduledMappings.has(key(overlay.deviceId, overlay.mappingId)),
    )
    .sort(
      (left, right) =>
        left.deviceId.localeCompare(right.deviceId) ||
        left.mappingId.localeCompare(right.mappingId) ||
        left.pin - right.pin,
    );
  for (const overlay of appended) {
    const effective = {
      deviceId: overlay.deviceId,
      mappingId: overlay.mappingId,
      pin: overlay.pin,
      value: overlay.value,
      overwrite: true,
      overrideId: overlay.overrideId,
    } as const;
    assertUniqueEffectivePin(effectivePins, effective);
    commands.push(effective);
  }
  return commands;
}

function assertUniqueEffectivePin(
  pins: Set<string>,
  command: Pick<EffectiveOutputRefreshCommand, "deviceId" | "pin">,
): void {
  const pinKey = key(command.deviceId, String(command.pin));
  if (pins.has(pinKey)) {
    throw new TypeError(
      `Effective refresh commands overlap at ${command.deviceId} pin ${command.pin}`,
    );
  }
  pins.add(pinKey);
}

function key(deviceId: string, value: string): string {
  return `${deviceId}\0${value}`;
}
