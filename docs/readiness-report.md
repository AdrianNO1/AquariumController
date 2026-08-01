# Readiness report

Assessment date: 2026-07-26

Basis: the current firmware 4.1 and per-device-lane branch, plus the explicitly
historical pre-4.1 release evidence recorded below. The aquarium Raspberry Pi
was not contacted or used for this assessment.

## Verdict

The current repository implementation is **prepared for protected release
validation**, but it is not yet the Pi handoff release. It still needs a
protected pull-request run, merge, protected default-branch run, image
publication, and selection of the resulting immutable multi-architecture
digest. The earlier source and image below prove the pre-4.1 baseline only.

This is not production approval. No production input has been imported, no
ESP32 has been flashed as part of this work, and the Pi has not been contacted
or validated. Follow the
[Pi production handoff](pi-production-handoff.md) and the full
[deployment/rollback runbook](production-deployment.md).

Reachable history on all hosted branches has been checked and contains only the
redacted credential sentinels while preserving the original commit topology.
An older, now-unreachable GitHub object is still directly addressable and its
secret-scanning alert remains open. Confirm the affected credential was
independently revoked, ask GitHub Support to purge the orphaned object/cached
view, then resolve the alert as revoked. Keep secret scanning and push
protection enabled.

## Historical pre-4.1 release evidence

- Historical source commit:
  `886ed05be89a1abed8e076d91ce2802f5d5668dd`.
- Historical protected pull-request validation:
  [run 30158546118](https://github.com/AdrianNO1/AquariumController/actions/runs/30158546118),
  six of six required jobs green.
- Historical protected `master` validation and publication:
  [run 30158994132](https://github.com/AdrianNO1/AquariumController/actions/runs/30158994132),
  six of six required jobs green plus the publication job.
- Historical image:
  `ghcr.io/adrianno1/aquarium-controller@sha256:0629bacbd1744eafd2c98b7c96890e6bf1a5d891dc44e77bd77702da1fb2becc`.
- Package access at evidence time: publicly pullable without a registry
  credential.

This source and digest predate firmware 4.1, correlated requests, per-device
lanes, and the current failover changes. Do not deploy them as the current
release. Select and record a new source commit and digest only after this
branch's protected validation and merge succeed.

## Current and historical evidence

| Boundary                          | Evidence                                                                    | Remaining boundary                                                         |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Current ESP32 firmware 4.1.0      | Pinned compiler build passes at 80% flash and 19% global RAM                | Protected firmware job, fleet flash, and physical soak                     |
| Current transport/schedulers      | Local verification passes 98 files/684 unit and 83 files/616 critical tests | Full protected branch validation                                           |
| Historical host verification      | Unit 97 files/638 tests; critical 82 files/571 tests                        | Historical pre-4.1 result; not current-branch evidence                     |
| Current real Mosquitto            | Local current-branch integration passes 5/5                                 | Current protected integration job; production broker and LAN not contacted |
| Current production Chromium       | Local current-branch run passes 18/18 with zero retries                     | Current protected browser job; real Pi/browser clients                     |
| Historical firmware 4.0.0 compile | Warning-free; exact resource figures recorded below                         | Superseded by 4.1                                                          |
| Historical production Compose     | Pre-4.1 template rendered with fail-closed inputs                           | Current protected container job, Pi values, and storage paths              |
| Historical Pi preflight           | Pre-4.1 Bash syntax passed                                                  | Must run for real on the intended Pi                                       |
| Historical ARM64 container        | Historical digest healthy as UID/GID 1000; both SQLite checks passed        | New current digest; real Pi validation                                     |
| Current GitHub CI/GHCR            | Workflow and protected branch exist                                         | Current PR/default-branch runs and a newly selected published digest       |
| Production migration              | Importer and synthetic fixtures implemented                                 | Actual stopped production snapshot must be dry-run and reviewed            |

The historical one-test difference between pre-refactor host verification and clean
Docker verification is intentional. `.old/data` is operator-local production
input and is ignored by Git, Docker build contexts, and CI. The former
environment-dependent fixture assertion was removed; the importer is now
exercised with deterministic synthetic JSON created in temporary directories.
The clean run therefore has one fewer unit test and one fewer critical test,
without reducing importer behavior coverage.

## Verification details

### Current branch verification

The current firmware 4.1/per-device-lane source passed local formatting, lint,
all workspace and E2E typechecks, and production builds. Its current test
counts are:

- unit: 98 files, 684 tests;
- critical: 83 files, 616 tests;
- real-Mosquitto integration: 5/5; and
- production Playwright: 18/18 with retries disabled.

The browser run used production-built assets, fresh SQLite databases, real
Mosquitto, and independent fake ESPs. These local results still require
confirmation by the protected pull-request and default-branch workflows.

### Historical host and clean-source verification

Before the fixture isolation change, the host `npm run verify` completed with:

- unit: 95 files, 619 tests;
- critical: 81 files, 558 tests; and
- formatting, lint, workspace typechecks, and production builds green.

After migration tests became hermetic, a clean Linux Docker verification
installed from the lockfile and completed with:

- unit: 95 files, 618 tests;
- critical: 81 files, 557 tests; and
- formatting, lint, workspace typechecks, and production builds green.

That clean Docker result established the hermetic baseline before the final
unknown-outcome reconciliation work.

The historical pre-4.1 release source then passed complete host verification after
the reconciliation work: 97 files/638 unit tests, 82 files/571 critical tests,
and every static/build gate. The same source passed both protected hosted runs.
Those counts are retained as historical evidence and are not claimed for the
current branch.

### Real broker integration

The current firmware 4.1/per-device-lane real-wire suite passes 5/5 against
digest-pinned Mosquitto
`eclipse-mosquitto:2.0.22-openssl@sha256:212f89e1eaeb2c322d6441b64396e3346026674db8fa9c27beac293405c32b3c`.
It covers multi-device discovery, controller/broker/fake restarts, command and
chunk boundaries, persisted schedules and fake EEPROM state, time/override
safety, malformed and late replies, disconnects, broker loss, and the
no-actuator-retry rule. Test traffic is restricted to `test/aquarium/*`.

The current branch additionally proves that a healthy ESP can complete while
another response is delayed and that each chunk sequence is published
atomically. Hosted confirmation still belongs in the protected run.

### Production-browser stability

The current local Playwright Chromium run passes 18/18 with retries disabled.
The historical protected pull-request and protected `master` runs also passed
their pre-4.1 18/18 suites. The current run uses production-built assets, fresh
SQLite databases, real Mosquitto, and two independent fake ESPs. Coverage
includes:

- every retained route, direct reload, useful 404 recovery, responsive layouts,
  keyboard access, and automated accessibility checks;
- channel, schedule, throttle, mapping, device, and override workflows;
- revision conflicts, persistence, logs, exports, alerts, and invalid filters;
- SSE recovery, offline/reconnect, unknown-outcome discovery, explicit
  physical-state reconciliation, and no command resend; and
- controller, broker, and fake-ESP restart behavior.

The harness rejects unexpected external requests and browser console errors.

### ESP32 firmware 4.1.0 and historical 4.0 compile evidence

The supported sketch is `.old/slaveCode/ESP32Code/ESP32Code.ino`, now version
4.1.0. Its pinned Arduino CLI 1.5.0, ESP32 core 3.3.8, ArduinoJson 7.4.3, and
PubSubClient 2.8 build passes. The compiler image verifies the official Arduino
CLI archive SHA-256 before extraction.

The exact resource figures below are from the focused 2026-07-19 firmware 4.0
build. They are historical and are not claimed for 4.1:

| Resource                          |          Result |
| --------------------------------- | --------------: |
| Program flash                     | 1,036,431 bytes |
| Global RAM                        |    63,180 bytes |
| Local-variable capacity remaining |   264,500 bytes |

Firmware 4.1.0 retains rollover-safe override expiry, schedule restoration,
cache invalidation, and normalized 0-255 duty scaling. It adds correlated
request IDs, wear-limited diagnostics, controller-owned overwrite behavior, and
valid-EEPROM-time fallback when neither Pi nor NTP is reachable. Per-pin
schedule activation is best effort and reports failures without stopping
healthy pins. The controller supports firmware 5.0.0 and newer; older versions
are marked `firmware_unsupported` and excluded from actuator work.

Compilation and fake-firmware tests cannot prove physical pin assignments,
power-loss behavior, Wi-Fi quality, NTP reachability, or deployed output.

### Containers, Compose, and ARM64

The historical pre-4.1 release validation rendered the production Compose
template with explicit placeholder inputs, and `deployment/pi-preflight.sh`
passed Bash syntax checking. The template still fails closed without an
immutable image reference, bind address, broker URL, MQTT confirmation, and
four explicit storage directories. Preflight also rejects Compose installations
that lack the `up --wait`, `--wait-timeout`, or `ps --status` capabilities used
by the start and single-publisher safety procedures.

The historical clean ARM64 image built and reached health under emulation. The
running process reported UID/GID 1000, and `state.db` and `events.db` both
passed SQLite integrity checks. The image is non-root and supports a read-only
application filesystem with only declared data directories and `/tmp` writable.

This demonstrates image-level ARM64 compatibility, not the production Pi's
kernel, filesystem, storage latency, memory pressure, or LAN.

### Dependency security

`npm audit --omit=dev` reports zero production vulnerabilities. CI rejects high
or critical production advisories after installing the lockfile.

The full development tree reports
[`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
through Testcontainers 12.0.4 and its Archiver 7 dependency. It is not shipped
in the runtime image, current test code supplies no attacker-controlled glob
pattern, and no compatible Testcontainers release exposes the repaired Archiver
tree. npm's automated proposal is an unsafe five-major Testcontainers
downgrade; a direct `brace-expansion` override is API-incompatible. Revisit this
exception when Testcontainers supports Archiver 8 or publishes a compatible
backport.

### Storage and backup safety

`state.db` remains normalized authoritative control state. `events.db` stores
structured operational history. Variable-shaped JSON is limited to versioned,
validated payload columns rather than used as a document database.

Pino logs are redacted JSON on stdout. Compose uses Docker's compressed `local`
driver, capped at five 10 MiB files per service. Queryable interactions live in
`events.db`; high-volume raw rows are short-lived, and longer-lived rows are
archived as deterministic Zstandard-compressed NDJSON before deletion.

Schema-v2 backups include independent SQLite files, SHA-256 values, integrity
results, and a cross-database replay boundary. Startup and storage health verify
the exact artifact named by the latest successful backup interaction; a missing,
changed, corrupt, escaped, or symlinked artifact is not accepted. Restore writes
only to new paths during a controlled outage.

## Production-data boundary

`.old/data` is intentionally ignored operator-local production input. It is not
a repository fixture, CI dependency, Docker build input, or immutable expected
snapshot. CI and clean verification generate deterministic synthetic migration
fixtures in temporary directories.

Synthetic fixtures prove parsing, strict JSON handling, normalization,
all-or-nothing commit behavior, provenance, revision/outbox creation, and
failure cases. They do not prove that the aquarium's current files are valid.
For production:

1. stop and prove the legacy publisher inactive;
2. copy the actual source to an immutable rollback snapshot;
3. dry-run that snapshot with the exact release digest;
4. review every warning, count, and its newly calculated fingerprint;
5. commit that same snapshot only into new storage; and
6. preserve the legacy installation until the new controller completes its
   supervised soak.

Never compare production against a fingerprint copied from old documentation,
and never silently repair a fatal report.

## CI status

`.github/workflows/ci.yml` defines six validation jobs:

1. static/unit;
2. critical;
3. real-Mosquitto integration;
4. production Chromium;
5. pinned ESP32 firmware compilation; and
6. amd64/ARM64 container smoke and hardening.

An independently gated `publish-image` job is restricted to default-branch
pushes and requires the explicit lowercase `AQUARIUM_GHCR_IMAGE` repository
variable. It publishes by a run-unique tag, captures the returned
multi-platform manifest digest, and smoke-tests that exact digest. There is no
Pi deployment job. The static lane also fails on high or critical production
dependency advisories.

The protected pull-request and `master` runs cited above are historical
pre-4.1 evidence. `master` requires the six checks, pull requests, a current
branch, and administrator enforcement; force-pushes and deletion are blocked.
The current branch must pass those checks, merge, publish, and select its own
exact digest before the Pi handoff starts.

## Remaining release gates

### GitHub security

- Confirm the affected credential was revoked independently of history
  rewriting, request GitHub Support cleanup of the directly addressable
  unreachable object, and close the remaining alert only as `revoked`.

### Current release selection

- Pass all six protected jobs for the current branch.
- Merge through the protected default branch and confirm its hosted run.
- Publish, smoke-test, and record the new exact multi-platform digest.

### ESP32 fleet

- Build the ignored local firmware configuration without committing secrets.
- Flash every deployed board with 4.1.0 and confirm its reported version.
- Bench-test override expiry, schedule restoration, resolution changes, time
  acquisition, Wi-Fi/broker loss, reboot, and power cycling before enabling
  aquarium actuators.

### Pi and production

- Complete every unchecked item in
  [the Pi production handoff](pi-production-handoff.md).
- Run preflight on the intended Pi with operator-managed values and the exact
  published digest.
- Dry-run and review the actual stopped production JSON snapshot.
- Choose the explicit first-migration rollback branch; there is no prior SQLite
  release to restore on the first cutover.
- Perform a supervised soak covering real wiring, broker, Wi-Fi, disk/load,
  restart, and sudden power loss.

Until current protected release evidence and immutable digest selection succeed,
the correct claim is **repository implementation prepared for protected release
validation**. After that, the remaining Pi, migration, fleet, and soak steps are
external production acceptance.
