import type {
  Device,
  FirmwareDeployment,
  FirmwareUpdateMode,
  MappingProfile,
  OperationSummary,
  PatchDeviceConfigurationRequest,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  patchDeviceConfiguration,
  requestDeviceFirmwareUpdate,
  setDeviceEnabled,
} from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { ModalDialog } from "./ModalDialog.js";
import { ModalBackdrop } from "./ModalBackdrop.js";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";
import { FirmwareUpdateDialog } from "./FirmwareUpdateDialog.js";

const SUCCEEDED_FIRMWARE_UPDATE_VISIBLE_MS = 10 * 60 * 1_000;

export interface DevicesPanelProps {
  readonly devices: readonly Device[];
  readonly mappingProfiles: readonly MappingProfile[];
  readonly operations: readonly OperationSummary[];
  readonly firmware: FirmwareDeployment;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

interface EditingDevice {
  readonly device: Device;
  readonly expectedRevision: number;
}

export function DevicesPanel({
  devices,
  mappingProfiles,
  operations,
  firmware,
  expectedRevision,
  refresh,
}: DevicesPanelProps): React.JSX.Element {
  const [editing, setEditing] = useState<EditingDevice | null>(null);
  const [updateDevice, setUpdateDevice] = useState<Device | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  const enabledMutation = useMutation({
    retry: false,
    mutationFn: ({
      deviceId,
      enabled,
    }: {
      readonly deviceId: string;
      readonly enabled: boolean;
    }) => setDeviceEnabled(deviceId, { expectedRevision, enabled }),
    onMutate: ({ deviceId }) => setPendingDeviceId(deviceId),
    onSuccess: refresh,
    onSettled: () => setPendingDeviceId(null),
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });
  const firmwareMutation = useMutation({
    retry: false,
    mutationFn: ({
      deviceId,
      mode,
      transitionSeconds,
    }: {
      readonly deviceId: string;
      readonly mode: FirmwareUpdateMode;
      readonly transitionSeconds: number;
    }) =>
      requestDeviceFirmwareUpdate(deviceId, {
        expectedRevision,
        mode,
        transitionSeconds,
      }),
    onSuccess: () => {
      setUpdateDevice(null);
      refresh();
    },
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });
  const profileNames = new Map(
    mappingProfiles.map((profile) => [profile.id, profile.name]),
  );
  const visibleDevices = devices.filter(
    (device) =>
      device.enabled || device.lastError?.code === "protocol_invalid_response",
  );

  return (
    <section className="devices-section" aria-labelledby="devices-heading">
      <div className="devices-heading">
        <div>
          <p className="eyebrow">Controller registry</p>
          <h2 id="devices-heading">ESP32 devices</h2>
        </div>
        <button className="secondary-button" type="button" onClick={refresh}>
          Refresh
        </button>
      </div>

      {visibleDevices.length === 0 ? (
        <p className="empty-panel">No ESP32 devices have announced yet.</p>
      ) : (
        <div className="device-grid">
          {visibleDevices.map((device) => {
            const status = device.enabled ? device.status : "excluded";
            const canExclude =
              device.enabled &&
              (device.status === "stale" || device.status === "offline");
            const firmwareStatus = firmwarePresentation(
              device,
              firmware.currentVersion,
            );
            const updateAvailable =
              device.reported.firmwareVersion !== null &&
              device.reported.firmwareVersion !== firmware.currentVersion;
            const wirelessUpdateSupported = supportsWirelessUpdate(device);
            const showFirmwareUpdate =
              device.firmwareUpdate !== null &&
              (device.firmwareUpdate.status !== "succeeded" ||
                nowMs - Date.parse(device.firmwareUpdate.updatedAt) <
                  SUCCEEDED_FIRMWARE_UPDATE_VISIBLE_MS);
            const configurationUpdatePending = operations.some(
              (operation) =>
                operation.deviceId === device.id &&
                operation.kind === "edit_configuration" &&
                ["pending", "in_flight"].includes(operation.status),
            );
            const mappingProfile =
              device.mappingProfileId === null
                ? "Unmapped"
                : (profileNames.get(device.mappingProfileId) ??
                  "Missing profile");
            return (
              <article
                className={`device-card device-card-${status}`}
                aria-label={`ESP32 device ${device.desired.name}`}
                key={device.id}
              >
                <div className="device-card-header">
                  <div>
                    <h3>{device.desired.name}</h3>
                    <span className="device-hardware-id">
                      ID: {device.hardwareId}
                    </span>
                  </div>
                  <div className="device-card-actions">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      disabled={
                        !device.enabled ||
                        !["online", "stale", "offline"].includes(device.status)
                      }
                      title={
                        device.enabled
                          ? undefined
                          : "Include this device before editing it"
                      }
                      onClick={() => setEditing({ device, expectedRevision })}
                    >
                      Edit
                    </button>
                    {canExclude ? (
                      <button
                        className="device-exclude-button"
                        type="button"
                        aria-label={`Hide ${device.desired.name} until it reconnects`}
                        title="Hide this device and stop sending commands until it reconnects"
                        disabled={pendingDeviceId === device.id}
                        onClick={() =>
                          enabledMutation.mutate({
                            deviceId: device.id,
                            enabled: false,
                          })
                        }
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                </div>
                <dl className="device-facts">
                  <div>
                    <dt>Status</dt>
                    <dd className={`device-status device-status-${status}`}>
                      {capitalize(status)}
                    </dd>
                  </div>
                  <div>
                    <dt>Firmware</dt>
                    <dd className={firmwareStatus.className}>
                      {firmwareStatus.label}
                    </dd>
                  </div>
                  <div>
                    <dt>Pin profile</dt>
                    <dd>{mappingProfile}</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{formatLastSeen(device.lastSeenAt, nowMs)}</dd>
                  </div>
                </dl>
                {configurationMatches(device) ? null : (
                  <p className="device-card-warning">
                    {configurationUpdatePending
                      ? "Update pending…"
                      : "Desired and reported configuration differ."}
                  </p>
                )}
                {device.lastError === null ||
                (configurationUpdatePending &&
                  device.lastError.code === "configuration_mismatch") ? null : (
                  <p
                    className="device-card-error"
                    title={device.lastError.message}
                  >
                    {device.lastError.message}
                  </p>
                )}
                {!showFirmwareUpdate ||
                device.firmwareUpdate === null ? null : (
                  <p
                    className={`firmware-update-state firmware-update-${device.firmwareUpdate.status}`}
                    role="status"
                  >
                    Update: {device.firmwareUpdate.status.replaceAll("_", " ")}
                    {device.firmwareUpdate.progress > 0
                      ? ` · ${device.firmwareUpdate.progress}%`
                      : ""}
                    {device.firmwareUpdate.error === null
                      ? ""
                      : ` · ${device.firmwareUpdate.error}`}
                  </p>
                )}
                {updateAvailable && wirelessUpdateSupported ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={
                      !device.enabled ||
                      firmwareMutation.isPending ||
                      (device.firmwareUpdate !== null &&
                        !["failed", "succeeded"].includes(
                          device.firmwareUpdate.status,
                        ))
                    }
                    onClick={() => setUpdateDevice(device)}
                  >
                    {device.firmwareUpdate?.status === "failed"
                      ? "Retry firmware update"
                      : `Update to ${firmware.currentVersion}`}
                  </button>
                ) : null}
                {updateAvailable && !wirelessUpdateSupported ? (
                  <p className="firmware-usb-required">
                    One USB update is required before this ESP can update
                    wirelessly.
                  </p>
                ) : null}
                {!device.enabled &&
                device.lastError?.code === "protocol_invalid_response" ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={pendingDeviceId === device.id}
                    onClick={() =>
                      enabledMutation.mutate({
                        deviceId: device.id,
                        enabled: true,
                      })
                    }
                  >
                    Include in controller commands
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      {enabledMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(enabledMutation.error)}
        </p>
      )}
      {editing === null ? null : (
        <DeviceConfigurationDialog
          device={editing.device}
          mappingProfiles={mappingProfiles}
          expectedRevision={editing.expectedRevision}
          refresh={refresh}
          onClose={() => setEditing(null)}
        />
      )}
      {updateDevice === null ? null : (
        <FirmwareUpdateDialog
          subject={updateDevice.desired.name}
          targetVersion={firmware.currentVersion}
          pending={firmwareMutation.isPending}
          onConfirm={(mode, transitionSeconds) =>
            firmwareMutation.mutate({
              deviceId: updateDevice.id,
              mode,
              transitionSeconds,
            })
          }
          onClose={() => setUpdateDevice(null)}
        />
      )}
      {firmwareMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(firmwareMutation.error)}
        </p>
      )}
    </section>
  );
}

function DeviceConfigurationDialog({
  device,
  mappingProfiles,
  expectedRevision,
  refresh,
  onClose,
}: {
  readonly device: Device;
  readonly mappingProfiles: readonly MappingProfile[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(device.desired.name);
  const [frequency, setFrequency] = useState(
    String(device.desired.pwmFrequencyHz),
  );
  const [resolution, setResolution] = useState(
    String(device.desired.pwmResolutionBits),
  );
  const [mappingProfileId, setMappingProfileId] = useState(
    device.mappingProfileId ?? "",
  );
  const [closeRequested, setCloseRequested] = useState(false);
  const parsedFrequency = Number(frequency);
  const parsedResolution = Number(resolution);
  const fieldsChanged =
    name !== device.desired.name ||
    parsedFrequency !== device.desired.pwmFrequencyHz ||
    parsedResolution !== device.desired.pwmResolutionBits ||
    mappingProfileId !== (device.mappingProfileId ?? "");
  const reapply = !fieldsChanged && !configurationMatches(device);
  const request = useMemo<PatchDeviceConfigurationRequest>(
    () =>
      reapply
        ? {
            expectedRevision,
            name: device.desired.name,
            pwmFrequencyHz: device.desired.pwmFrequencyHz,
            pwmResolutionBits: device.desired.pwmResolutionBits,
            mappingProfileId: device.mappingProfileId,
          }
        : {
            expectedRevision,
            ...(name === device.desired.name ? {} : { name }),
            ...(parsedFrequency === device.desired.pwmFrequencyHz
              ? {}
              : { pwmFrequencyHz: parsedFrequency }),
            ...(parsedResolution === device.desired.pwmResolutionBits
              ? {}
              : { pwmResolutionBits: parsedResolution }),
            ...(mappingProfileId === (device.mappingProfileId ?? "")
              ? {}
              : { mappingProfileId: mappingProfileId || null }),
          },
    [
      device,
      expectedRevision,
      name,
      parsedFrequency,
      parsedResolution,
      mappingProfileId,
      reapply,
    ],
  );
  const mutation = useMutation({
    retry: false,
    mutationFn: () => patchDeviceConfiguration(device.id, request),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });

  function requestClose(): void {
    if (fieldsChanged) {
      setCloseRequested(true);
      return;
    }
    onClose();
  }

  return (
    <ModalBackdrop onClose={requestClose}>
      <ModalDialog
        className="configuration-dialog device-dialog"
        labelledBy={`device-dialog-${device.id}`}
        onClose={requestClose}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">ESP32 configuration</p>
            <h2 id={`device-dialog-${device.id}`}>
              Edit {device.desired.name}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close device editor"
            onClick={requestClose}
          >
            ×
          </button>
        </div>
        <form
          className="dialog-body device-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label className="field">
            Device name
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
            />
          </label>
          <label className="field">
            PWM frequency (Hz)
            <input
              type="number"
              min="1"
              max="40000"
              value={frequency}
              onChange={(event) => setFrequency(event.currentTarget.value)}
              required
            />
          </label>
          <label className="field">
            PWM resolution (bits)
            <select
              value={resolution}
              onChange={(event) => setResolution(event.currentTarget.value)}
            >
              {Array.from({ length: 16 }, (_, index) => index + 1).map(
                (bits) => (
                  <option key={bits} value={bits}>
                    {bits}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="field">
            Pin mapping profile
            <select
              value={mappingProfileId}
              onChange={(event) =>
                setMappingProfileId(event.currentTarget.value)
              }
            >
              <option value="">None</option>
              {mappingProfiles
                .filter(
                  (profile) =>
                    profile.hardwareProfileId ===
                    device.reported.hardwareProfileId,
                )
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
            </select>
          </label>
          {mutation.error === null ? null : (
            <p className="field-error" role="alert">
              {configurationErrorMessage(mutation.error)}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              {fieldsChanged ? "Discard changes" : "Close"}
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={(!fieldsChanged && !reapply) || mutation.isPending}
            >
              {mutation.isPending
                ? "Sending…"
                : reapply
                  ? "Reapply configuration"
                  : "Save"}
            </button>
          </div>
        </form>
        <UnsavedChangesDialog
          open={closeRequested && fieldsChanged}
          saving={mutation.isPending}
          onSave={() => mutation.mutate()}
          onDiscard={onClose}
          onKeepEditing={() => setCloseRequested(false)}
        />
      </ModalDialog>
    </ModalBackdrop>
  );
}

function configurationMatches(device: Device): boolean {
  return (
    device.reported.name === device.desired.name &&
    device.reported.pwmFrequencyHz === device.desired.pwmFrequencyHz &&
    device.reported.pwmResolutionBits === device.desired.pwmResolutionBits
  );
}

function firmwarePresentation(
  device: Device,
  currentVersion: string,
): {
  readonly label: string;
  readonly className: string;
} {
  const version = device.reported.firmwareVersion;
  if (version === null) {
    return { label: "Not reported", className: "firmware-unknown" };
  }
  if (!supportsWirelessUpdate(device)) {
    return {
      label: `${version} · upgrade required`,
      className: "firmware-required",
    };
  }
  if (version !== currentVersion) {
    return {
      label: `${version} · update available`,
      className: "firmware-available",
    };
  }
  return { label: `${version} · current`, className: "firmware-current" };
}

function supportsWirelessUpdate(device: Device): boolean {
  const version = device.reported.firmwareVersion;
  if (version === null) return false;
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 5;
}

function formatLastSeen(value: string | null, nowMs: number): string {
  if (value === null) return "Never";
  const differenceSeconds = Math.max(
    0,
    Math.floor((nowMs - Date.parse(value)) / 1_000),
  );
  if (differenceSeconds < 60) return `${differenceSeconds}s ago`;
  if (differenceSeconds < 3_600) {
    return `${Math.floor(differenceSeconds / 60)}m ago`;
  }
  return `${Math.floor(differenceSeconds / 3_600)}h ago`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
