# Readiness report

Assessment date: 2026-07-25

Basis: the locally settled rewrite tree and the exact evidence recorded below.
The hosted GitHub workflow and the aquarium Raspberry Pi were not used for this
assessment.

## Verdict

The repository is a **locally validated release candidate**. The current tree
has passed real-broker integration, three consecutive retry-free
production-browser runs, host verification, clean Linux Docker verification,
firmware compilation, production-Compose rendering, preflight syntax, and an
emulated ARM64 image smoke.

This is not production approval. Hosted CI has not yet produced trusted green
checks or a release manifest digest, no production input has been imported, no
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

## Current evidence

| Boundary                                               | 2026-07-25 result                                                               | Remaining boundary                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Host verification before hermetic fixture refactor     | Unit 95 files/619 tests; critical 81 files/558 tests                            | Superseded by the clean Docker run for reproducibility          |
| Settled-tree host verification                         | Unit 95 files/618 tests; critical 81 files/557 tests                            | Hosted CI still must run                                        |
| Clean Linux Docker verification after fixture refactor | Unit 95 files/618 tests; critical 81 files/557 tests                            | Hosted CI still must run                                        |
| Real Mosquitto                                         | 5/5                                                                             | Production broker and LAN not contacted                         |
| Production Chromium                                    | Three consecutive 18/18 runs, zero retries                                      | Real Pi/browser clients not tested                              |
| ESP32 firmware 4.0.0                                   | Warning-free pinned compile                                                     | Fleet flash and physical soak                                   |
| Production Compose                                     | Rendered successfully with fail-closed inputs                                   | Pi values and exact release digest                              |
| Pi preflight                                           | Bash syntax passed                                                              | Must run for real on the intended Pi                            |
| ARM64 container                                        | Built, became healthy, ran as UID/GID 1000, both SQLite integrity checks passed | Emulation is not real Pi validation                             |
| Hosted GitHub CI/GHCR                                  | Workflow implemented                                                            | No hosted-green or published-digest claim                       |
| Production migration                                   | Importer and synthetic fixtures implemented                                     | Actual stopped production snapshot must be dry-run and reviewed |

The one-test difference between the pre-refactor host verification and the clean
Docker verification is intentional. `.old/data` is operator-local production
input and is ignored by Git, Docker build contexts, and CI. The former
environment-dependent fixture assertion was removed; the importer is now
exercised with deterministic synthetic JSON created in temporary directories.
The clean run therefore has one fewer unit test and one fewer critical test,
without reducing importer behavior coverage.

## Verification details

### Host and clean-source verification

Before the fixture isolation change, the host `npm run verify` completed with:

- unit: 95 files, 619 tests;
- critical: 81 files, 558 tests; and
- formatting, lint, workspace typechecks, and production builds green.

After migration tests became hermetic, a clean Linux Docker verification
installed from the lockfile and completed with:

- unit: 95 files, 618 tests;
- critical: 81 files, 557 tests; and
- formatting, lint, workspace typechecks, and production builds green.

The clean Docker result is the current reproducibility evidence. It does not
substitute for the first hosted Actions run.

The same settled tree also passed the complete host verification after the
Fastify/static and React Router security upgrades: 95 files/618 unit tests, 81
files/557 critical tests, and every static/build gate.

### Real broker integration

The current real-wire suite passed 5/5 against digest-pinned Mosquitto
`eclipse-mosquitto:2.0.22-openssl@sha256:212f89e1eaeb2c322d6441b64396e3346026674db8fa9c27beac293405c32b3c`.
It covers multi-device discovery, controller/broker/fake restarts, command and
chunk boundaries, persisted schedules and fake EEPROM state, time/override
safety, malformed and late replies, disconnects, broker loss, and the
no-actuator-retry rule. Test traffic is restricted to `test/aquarium/*`.

### Production-browser stability

Three consecutive Playwright Chromium runs passed 18/18 with retries disabled.
They used production-built assets, fresh SQLite databases, real Mosquitto, and
two independent fake ESPs. Coverage includes:

- every retained route, direct reload, useful 404 recovery, responsive layouts,
  keyboard access, and automated accessibility checks;
- channel, schedule, throttle, mapping, device, and override workflows;
- revision conflicts, persistence, logs, exports, alerts, and invalid filters;
- SSE recovery, offline/reconnect and unknown outcomes; and
- controller, broker, and fake-ESP restart behavior.

The harness rejects unexpected external requests and browser console errors.

### ESP32 firmware 4.0.0

The supported sketch is `.old/slaveCode/ESP32Code/ESP32Code.ino`. It compiles
warning-free with pinned Arduino CLI 1.5.0, ESP32 core 3.3.8, ArduinoJson 7.4.3,
and PubSubClient 2.8. The compiler image verifies the official Arduino CLI
archive SHA-256 before extraction:

| Resource                          |          Result |
| --------------------------------- | --------------: |
| Program flash                     | 1,036,431 bytes |
| Global RAM                        |    63,180 bytes |
| Local-variable capacity remaining |   264,500 bytes |

Firmware 4.0.0 fixes rollover-safe override expiry, forces schedule restoration,
invalidates output caches after PWM reattachment or schedule replacement, and
holds persisted schedule pins off until current time is freshly confirmed.
Wire duty is normalized 0-255 and scaled to the configured 1-16-bit resolution.
The controller marks other versions `firmware_outdated` and excludes them from
actuator work.

Compilation and fake-firmware tests cannot prove physical pin assignments,
power-loss behavior, Wi-Fi quality, NTP reachability, or deployed output.

### Containers, Compose, and ARM64

The production Compose template rendered successfully with explicit placeholder
inputs, and `deployment/pi-preflight.sh` passed Bash syntax checking. The
template still fails closed without an immutable image reference, bind address,
broker URL, MQTT confirmation, and four explicit storage directories.
Preflight also rejects Compose installations that lack the `up --wait`,
`--wait-timeout`, or `ps --status` capabilities used by the start and
single-publisher safety procedures.

The clean ARM64 image built and reached health under emulation. The running
process reported UID/GID 1000, and `state.db` and `events.db` both passed SQLite
integrity checks. The image is non-root and supports a read-only application
filesystem with only declared data directories and `/tmp` writable.

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

Local workflow-equivalent evidence is green, but **hosted CI is not claimed
green**. The first trusted run must complete before branch-protection check
names and a deployment digest are selected.

## Remaining release gates

### GitHub and release image

- Confirm the affected credential was revoked independently of history
  rewriting, request GitHub Support cleanup of the directly addressable
  unreachable object, and close the remaining alert only as `revoked`.
- Run all six hosted validation jobs and require their actual check names on
  `master`.
- Configure the intended lowercase `AQUARIUM_GHCR_IMAGE`, review package
  visibility, run the gated publisher, and record its immutable manifest digest.

### ESP32 fleet

- Build the ignored local firmware configuration without committing secrets.
- Flash every deployed board with 4.0.0 and confirm its reported version.
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

Until those external steps succeed, the correct claim is **locally validated
release candidate**, not deployed production controller.
