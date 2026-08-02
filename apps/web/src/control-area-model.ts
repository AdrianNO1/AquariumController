import type {
  Channel,
  ControlArea,
  ControllerSnapshot,
  Device,
  FirmwareDeployment,
  MappingProfile,
  OperationSummary,
  Output,
  Override,
  ScheduleGraph,
  Throttle,
} from "@aquarium/contracts";

export interface ControlAreaChannel {
  readonly channel: Channel;
  readonly schedule: ScheduleGraph | null;
}

export interface ControlAreaModel {
  readonly area: ControlArea;
  readonly revision: number;
  readonly channels: readonly ControlAreaChannel[];
  readonly throttle: Throttle | null;
  readonly outputs: readonly Output[];
  readonly mappingProfiles: readonly MappingProfile[];
  readonly relevantProfileIds: ReadonlySet<string>;
  readonly devices: readonly Device[];
  readonly firmware: FirmwareDeployment;
  readonly operations: readonly OperationSummary[];
  readonly overrides: readonly Override[];
}

export function projectControlArea(
  snapshot: ControllerSnapshot,
  slug: ControlArea["slug"],
): ControlAreaModel | null {
  const area = snapshot.controlAreas.find(
    (candidate) => candidate.slug === slug,
  );
  if (area === undefined) return null;

  const schedulesByChannelId = new Map(
    snapshot.schedules.map((schedule) => [schedule.channelId, schedule]),
  );
  const channels = snapshot.channels
    .filter((channel) => channel.typeKey === area.typeKey)
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        compareIdentifiers(left.id, right.id),
    )
    .map((channel) => ({
      channel,
      schedule: schedulesByChannelId.get(channel.id) ?? null,
    }));
  const outputs = snapshot.outputs
    .filter((output) => output.typeKey === area.typeKey)
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        compareIdentifiers(left.id, right.id),
    );
  const targetKeys = new Set([
    ...channels.map(({ channel }) => `channel:${channel.id}`),
    ...outputs.map((output) => `output:${output.id}`),
  ]);
  const relevantProfileIds = new Set(
    snapshot.mappingProfiles
      .filter((profile) =>
        profile.mappings.some((mapping) =>
          targetKeys.has(`${mapping.target.kind}:${mapping.target.id}`),
        ),
      )
      .map((profile) => profile.id),
  );
  const devices = [...snapshot.devices].sort((left, right) =>
    compareIdentifiers(left.id, right.id),
  );
  const overrides = snapshot.overrides.filter((override) =>
    targetKeys.has(`${override.targetType}:${override.targetId}`),
  );

  return {
    area,
    revision: snapshot.revision,
    channels,
    throttle:
      snapshot.throttles.find(
        (throttle) => throttle.typeKey === area.typeKey,
      ) ?? null,
    outputs,
    mappingProfiles: [...snapshot.mappingProfiles].sort((left, right) =>
      compareIdentifiers(left.id, right.id),
    ),
    relevantProfileIds,
    devices,
    firmware: snapshot.firmware,
    operations: snapshot.operations.items,
    overrides,
  };
}

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
