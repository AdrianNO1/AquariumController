import {
  roundHalfEven,
  type ScheduleSegment,
  type ValidatedScheduleGraph,
} from "./schedule.js";

export type FirmwareChannelKind = "light" | "pump";

export interface FirmwareScheduleChannelInput {
  readonly pin: number;
  readonly kind: FirmwareChannelKind;
  readonly graph: ValidatedScheduleGraph;
  readonly throttlePercent: number;
  readonly outputGain: number;
}

export interface CompiledFirmwarePoint {
  readonly minute: number;
  readonly percent: number;
}

export interface CompiledFirmwareLink {
  readonly source: CompiledFirmwarePoint;
  readonly target: CompiledFirmwarePoint;
}

export interface CompiledFirmwareChannel {
  readonly pin: number;
  readonly kind: FirmwareChannelKind;
  readonly links: readonly CompiledFirmwareLink[];
}

export interface CompiledFirmwareSchedule {
  readonly channels: readonly CompiledFirmwareChannel[];
}

/**
 * Compiles validated semantic graphs into the firmware schedule model while
 * preserving caller order. Throttle uses Python-compatible half-even rounding,
 * matching the active legacy schedulemaker. Mapping-profile output gain is
 * compiled into the stored fallback schedule so local ESP behavior matches
 * controller-driven output when the controller becomes unavailable.
 */
export function compileFirmwareSchedule(
  channels: readonly FirmwareScheduleChannelInput[],
): CompiledFirmwareSchedule {
  const pins = new Set<number>();
  const compiled = channels.map((channel) => {
    if (!Number.isInteger(channel.pin) || channel.pin < 0 || channel.pin > 63) {
      throw new RangeError(
        "Firmware schedule pins must be integers from 0 to 63",
      );
    }
    if (pins.has(channel.pin)) {
      throw new RangeError(
        `Firmware schedule pin ${channel.pin} is duplicated`,
      );
    }
    pins.add(channel.pin);
    if (
      !Number.isFinite(channel.throttlePercent) ||
      channel.throttlePercent < 0 ||
      channel.throttlePercent > 100
    ) {
      throw new RangeError("Schedule throttle must be between 0 and 100");
    }
    if (
      !Number.isFinite(channel.outputGain) ||
      channel.outputGain < 0 ||
      channel.outputGain > 1
    ) {
      throw new RangeError(
        "Mapping-profile output gain must be between 0 and 1",
      );
    }

    return Object.freeze({
      pin: channel.pin,
      kind: channel.kind,
      links: Object.freeze(
        channel.graph.segments.map((segment) =>
          Object.freeze(
            compileSegment(
              segment,
              channel.throttlePercent,
              channel.outputGain,
            ),
          ),
        ),
      ),
    });
  });

  return Object.freeze({ channels: Object.freeze(compiled) });
}

function compileSegment(
  segment: ScheduleSegment,
  throttlePercent: number,
  outputGain: number,
): CompiledFirmwareLink {
  return {
    source: Object.freeze({
      minute: segment.source.minute,
      percent: roundHalfEven(
        segment.source.percent * (throttlePercent / 100) * outputGain,
      ),
    }),
    target: Object.freeze({
      minute: segment.target.minute,
      percent: roundHalfEven(
        segment.target.percent * (throttlePercent / 100) * outputGain,
      ),
    }),
  };
}
