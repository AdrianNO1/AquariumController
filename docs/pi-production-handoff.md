# Raspberry Pi production handoff

Updated: 2026-08-02

This is the concise external-operator checklist for putting AquariumController
into production. Repository implementation and validation did **not** contact,
inspect, or change the Pi. Run the commands and detailed safety checks from
[the full production deployment and rollback runbook](production-deployment.md);
this checklist does not replace it.

## Current handoff state

The repository contains firmware 5.0.6, correlated-request, per-device-lane,
latest-only scheduler, and device-local failure implementation. Before this
checklist becomes a deployment handoff, the branch must pass protected CI,
merge, publish a new image, and record that image's exact digest.

Current firmware 5.0.6/per-device-lane local evidence:

- lint, all workspace/E2E typechecks, and production builds: green;
- unit: 111 files/775 tests;
- critical: 88 files/656 tests;
- real Mosquitto integration: 5/5;
- production Playwright: 21/21 with zero retries; and
- pinned firmware compile: 89% flash and 16% global RAM.

These results have not yet been confirmed by the protected pull-request or
default-branch workflows.

The following evidence is a historical pre-4.1 baseline only:

- real Mosquitto integration: 5/5;
- production Playwright: local, protected PR, and protected `master` runs at
  18/18 with zero retries;
- host verification: 97 files/638 unit tests and 82 files/571 critical tests;
- firmware 4.0 compile: 1,036,431 bytes program, 63,180 bytes global RAM, and
  264,500 bytes local-variable capacity remaining;
- production Compose render and Pi-preflight Bash syntax: green;
- protected PR and `master` runs: all six required validation jobs green; and
- an amd64/ARM64 image was publicly pullable, healthy as UID/GID 1000, and
  passed both SQLite integrity checks.

Historical inputs, which must not be deployed as the current release:

- source: `886ed05be89a1abed8e076d91ce2802f5d5668dd`;
- validation/publication:
  [GitHub Actions run 30158994132](https://github.com/AdrianNO1/AquariumController/actions/runs/30158994132);
- repository: `ghcr.io/adrianno1/aquarium-controller`; and
- digest:
  `sha256:0629bacbd1744eafd2c98b7c96890e6bf1a5d891dc44e77bd77702da1fb2becc`.

Pi health, production storage, broker access, legacy-data validity, and physical
actuators are not claimed verified.

## 1. Release-source and GitHub gates

- [ ] Confirm the exposed credential was independently revoked.
- [ ] Ask GitHub Support to purge the directly addressable unreachable
      historical object and cached view.
- [ ] Resolve its open secret-scanning alert as `revoked`; keep secret scanning
      and push protection enabled.
- [ ] Run all six hosted validation jobs successfully for the current branch
      and its protected default-branch merge.
- [x] Protect `master` using the actual hosted check names; require pull
      requests/current branches/admin enforcement and block deletion and
      ordinary force-pushes.
- [x] Set `AQUARIUM_GHCR_IMAGE` to the reviewed lowercase GHCR repository.
- [ ] Publish the current package and verify its newly selected exact digest is
      anonymously pullable.
- [ ] Run the gated image publisher for the current merge and record the
      returned multi-platform `sha256` manifest digest. Do not deploy a mutable
      tag or the historical pre-4.1 digest.

There is deliberately no CI job that deploys to the Pi.

## 2. Pi platform gaps

- [ ] Confirm the intended host is 64-bit Linux on ARM64.
- [ ] Install and validate Docker Engine and the Docker Compose plugin.
- [ ] Install the runbook prerequisites: Bash, `curl`, `jq`, `rsync`,
      `sha256sum`, `find`, and standard core utilities.
- [ ] Confirm the deployment account and container storage ownership model use
      UID/GID 1000.
- [ ] Confirm correct system time, DNS, and enough free disk for images,
      databases, backups, archives, and rollback copies.
- [ ] Decide the explicit Pi LAN bind address and controller port. Do not expose
      the plain-HTTP UI beyond the trusted LAN.
- [ ] Confirm the Pi deployment account can pull the exact GHCR digest
      anonymously while the package remains public.
- [ ] Record the previously running service/supervisor and its reviewed
      stop/start/prove-state commands.

## 3. Network, MQTT, and notifications

- [ ] Provision a production MQTT account for the controller and a credential
      for firmware 5.0.6.
- [ ] Restrict the plaintext MQTT listener to the trusted aquarium LAN.
- [ ] Record the explicit broker URL and the exact production MQTT confirmation
      interlock.
- [ ] Verify firewall rules prevent unintended HTTP/MQTT exposure.
- [ ] Choose whether alert notifications are enabled.
- [ ] If enabled, provision the webhook URL, destination key, timeout, and
      paired authentication header outside the repository.
- [ ] If disabled, ensure all optional webhook variables are absent rather than
      exported as empty strings.

The current ESP32 firmware does not provide MQTT TLS. Adding `mqtts://` requires
future firmware work and physical validation.

## 4. Storage, backup, and rollback locations

- [ ] Choose four distinct, absolute, non-nested host directories for state,
      events, archives, and backups.
- [ ] Create them as UID/GID 1000 with mode `0700`; do not let Docker create
      root-owned bind paths implicitly.
- [ ] Choose a separate off-host or removable-media destination for the matched
      database-backup/archive recovery set.
- [ ] Set a reviewed minimum-free-space threshold for preflight.
- [ ] Define archive/offsite retention. Database backups do not contain
      `.ndjson.zst` event archives.
- [ ] Confirm the automated database-backup policy keeps one verified backup
      per UTC day for 14 days and then one per UTC week for 183 days.
- [ ] Record the prior image digest and prior storage paths for an upgrade.
- [ ] For a first migration, record the legacy service, data path, and immutable
      rollback-snapshot destination instead; there is no prior SQLite release.

## 5. ESP32 fleet gate

- [ ] Build firmware 5.0.6 with an ignored local configuration containing the
      intended Wi-Fi, MQTT username/password, and NTP host.
- [ ] Flash every deployed ESP32.
- [ ] Confirm every device reports firmware 5.0.6 and hardware profile
      `nodemcu-esp32s-v1.1`; firmware older than 5.0.0 is intentionally marked
      `firmware_unsupported` and receives no actuator work.
- [ ] Review each device's explicit mapping-profile selection after import.
      Names no longer select profiles. Investigate every GPIO12 warning and
      confirm the existing driver still does not pull that strapping pin high
      during reset.
- [ ] Review any disabled legacy pin mappings and remap or remove them. The
      upgrade preserves unsupported rows but prevents them from driving pins.
- [ ] Bench-test pin assignments, normalized PWM at configured resolutions,
      override expiry, schedule restoration, resolution reattachment, NTP/DNS
      loss, EEPROM-time fallback, broker/Wi-Fi loss, reboot, power cycling,
      per-pin best-effort activation, and diagnostic reporting.
- [ ] Keep production actuators disconnected or otherwise made safe until the
      expected output behavior is observed.

## 6. Production input and first migration

`.old/data` is intentionally ignored operator-local production input. CI uses
deterministic synthetic migration fixtures and does not certify the aquarium's
files.

- [ ] Stop the legacy publisher and prove it cannot send MQTT commands.
- [ ] Copy the actual stopped source into a new immutable rollback snapshot.
- [ ] Reject symlinks; create and verify its deterministic SHA-256 inventory.
- [ ] Dry-run that exact snapshot using the exact release digest and no network.
- [ ] Preserve the complete report and newly calculated fingerprint.
- [ ] Review every count and warning. Any error or unexplained transformation
      stops the migration.
- [ ] Commit the same immutable snapshot only into a newly claimed `state.db`.
- [ ] Initialize `events.db`, run both integrity checks, create and verify a
      schema-v2 backup, and create the matching archive-set manifest.
- [ ] Copy the complete database/archive recovery set off-host and verify it
      again.

Never accept production because it matches an old documented fingerprint. Never
delete and reuse a failed first-import target.

## 7. Preflight and supervised start

- [ ] Load values from an operator-managed secret store outside the checkout;
      do not use or commit a repository `.env`.
- [ ] Set the exact newly selected GHCR repository and 64-character digest, Pi
      bind address, port, broker URL/interlock, and four storage paths.
- [ ] Run `bash deployment/pi-preflight.sh compose.production.yaml` on the Pi.
- [ ] Stop on any architecture, digest-pull, configuration, ownership, mode,
      nesting, free-space, or Compose-rendering failure.
- [ ] Start only the immutable digest using the full runbook.
- [ ] Verify readiness, exact running image reference, and both SQLite integrity
      checks.
- [ ] Verify UI/snapshot, device discovery, firmware versions, schedules,
      overrides, logs, alerts, storage health, and latest verified backup.
- [ ] Confirm a nonresponding ESP is shown offline while healthy devices continue
      receiving work, and confirm explicit operator exclusion stops further
      attempts to that device.

## 8. Choose the rollback branch before cutover

### First migration

- [ ] Keep the original legacy installation and raw-data snapshot unchanged.
- [ ] If the candidate fails, stop and prove the new controller inactive.
- [ ] Restart the preserved legacy supervisor only after the new publisher is
      inactive.
- [ ] Verify the legacy UI, broker connection, devices, schedules, and physical
      output.
- [ ] Preserve all failed candidate databases, reports, and archives for
      diagnosis.

The post-import schema-v2 backup is a recovery copy of the new candidate. It is
not a backup of the pre-migration legacy controller.

### Subsequent SQLite upgrade

- [ ] Stop the failed release.
- [ ] Restore the verified pre-upgrade database backup into new paths.
- [ ] Copy and verify its matching archive set.
- [ ] Select the recorded prior image digest and new rollback paths.
- [ ] Re-run preflight, readiness, exact-image, integrity, and functional checks.
- [ ] Keep the failed release's paths unchanged for diagnosis.

The exact commands for both branches are in
[section 5 of the full runbook](production-deployment.md#5-roll-back-without-overwriting-evidence).

## 9. Soak and acceptance

- [ ] Supervise controller, broker, and ESP restart sequences.
- [ ] Exercise Wi-Fi interruption, broker interruption, and sudden power loss.
- [ ] Observe real disk usage/load, archive/backup behavior, and storage alerts.
- [ ] Confirm no unexplained actuator state, blind retry, stale override, or
      firmware-outdated device.
- [ ] Test the selected alert destination and recovery path.
- [ ] Record the release digest, migration fingerprint/report, recovery-set
      location, checks, observations, and final operator approval.

Any readiness/integrity failure or unexplained actuator output means rollback,
not continued unattended operation.
