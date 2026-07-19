# Readiness report

Assessment date: 2026-07-19

Branch inspected: `codex/aquarium-rewrite`

Basis: the current uncommitted rewrite plus explicitly dated historical and
focused evidence recorded below. Final settled-tree validation after the latest
hardening is pending. This is not a claim that the local stack is currently
running or that the rewrite has been deployed to the production aquarium.

## Verdict

The repository is an **implemented release candidate awaiting final current-tree
validation**. Docker, real-broker integration, production-browser, firmware,
import, backup/restore, and amd64/ARM64 paths have historical or focused local
evidence, but the latest combined tree has not completed final verification.

The hosted repository is currently **public and untrusted as a release source**.
A historical Dropbox token must be revoked, the aquarium Wi-Fi password must be
rotated, and Git history must be sanitized. Secret scanning and push protection
are enabled; visibility changes do not revoke already exposed credentials.

The rewrite is **not yet approved to replace the legacy production controller**.
That decision still requires actions which local tests cannot perform:

- flash firmware 4.0.0 to every deployed ESP32 and confirm the reported version;
- close the public-history credential gate described above;
- run the workflow once on GitHub and configure the protected GHCR/repository
  settings;
- configure and start the immutable production image on the Raspberry Pi;
- dry-run, review, back up, and import the final Pi-side production snapshot
  during a controlled outage; and
- supervise a hardware soak and cutover with a tested rollback path.

The final settled-tree verification and the no-retry browser repetition audit
should also be completed before release. Historical R8 evidence has three
consecutive no-retry passes. This report records one historical complete 17/17
R12 browser pass; it does
not claim that the separate three-repeat R12 audit has finished.

## Readiness summary

| Boundary                                     | State on 2026-07-19                        | Meaning                                                                                     |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Framework, API, persistence, runtime, and UI | Implemented; final validation pending      | Latest combined-tree verification remains open                                              |
| Docker/Testcontainers                        | Closed locally                             | Docker Desktop 4.81.0 exposes engine 29.6.1, Linux/amd64                                    |
| R8 real-Mosquitto integration                | Historical evidence complete               | Three consecutive 5/5 retry-free runs passed before the latest hardening                    |
| R12 production browser                       | Historical 17/17; current repeats open     | No final current-tree three-repeat claim                                                     |
| Firmware defects                             | Fixed in source and compiler-tested        | Physical ESP32 fleet still needs firmware 4.0.0                                             |
| Production-shaped legacy data                | Valid locally                              | Final Pi-side dry-run/import remains a deployment action                                    |
| Backup/restore                               | Implemented; final validation pending      | Historical round trip plus focused backup-artifact verifier 21/21 across four files          |
| amd64/ARM64 containers                       | Historical evidence                        | Both architectures previously built/started; final current-tree rerun remains open           |
| GitHub CI                                    | Six validation jobs plus gated publish     | Hosted repo remains untrusted until credential/history remediation                           |
| Public credential/history gate               | Open, release-blocking                      | Revoke Dropbox token, rotate aquarium Wi-Fi, sanitize history                                |
| Raspberry Pi and physical aquarium           | Not exercised                              | Wiring, Wi-Fi, power loss, real disk/load, and actuator behavior need supervised validation |

## Executable local evidence

Unless a 2026-07-19 focused run is named, results in this section are historical
evidence and are not a final combined-tree validation claim.

### R8: real broker integration

The integration suite uses pinned Mosquitto
`eclipse-mosquitto:2.0.22-openssl@sha256:212f89e1eaeb2c322d6441b64396e3346026674db8fa9c27beac293405c32b3c`
through Testcontainers. Five tests cover the required real-wire matrix:

- multi-device discovery plus fake, controller, and broker restarts;
- canonical global command batching, local response indexes, and legacy command
  fixtures;
- UTF-8, chunking, schedules, hashes, evaluation, persistence, time boundaries,
  and EEPROM behavior;
- malformed, missing, duplicate, late, disconnect, and broker-loss outcomes with
  no actuator retry; and
- persisted schedule, time, refresh, and override safety across every restart
  boundary.

Three consecutive exact `npm run test:integration` runs passed 5/5 without
retries or weakened assertions. Their wall times were 13.9 seconds, 20.6
seconds, and 14.3 seconds. A lifecycle race exposed by the repetition audit was
fixed; the focused fake-MQTT lifecycle regression also passed 10/10. No
Testcontainers resources were intentionally retained by the suite.

### R12: production browser evidence

One complete retry-free Playwright Chromium run passed 17/17 in approximately
one minute. It ran production-built assets against fresh SQLite databases, the
real pinned broker, and two persistent fake ESP actors. The scenarios cover:

- all retained direct routes, reloads, useful 404 recovery, keyboard access,
  automated accessibility checks, and phone/tablet/desktop overflow;
- channel, schedule, throttle, mapping, device, and override workflows,
  persistence, deletion, and visible revision conflicts;
- bounded logs, URL-backed filters, pagination, details, exports, alerts, and
  explicit invalid filter states; and
- offline/reconnect behavior, SSE recovery, unknown actuator outcomes, and
  controller, fake-ESP, and broker restarts.

The suite also audits browser console errors and unexpected external requests.
The independent three-consecutive-run browser audit is not claimed complete in
this report.

### ESP32 firmware 4.0.0

The actual sketch at `.old/slaveCode/ESP32Code/ESP32Code.ino` is now a supported
part of this rewrite. Firmware 4.0.0 fixes all four identified failover hazards:

- override expiry uses rollover-safe unsigned elapsed-time comparison;
- schedule output is forced after override expiry;
- PWM frequency/resolution reattachment invalidates the scheduled-value cache;
  and
- boot and schedule replacement force the first write, including a replacement
  schedule whose target is zero.

Pin bookkeeping now stays synchronized with scheduled writes. The fake ESP
implements the same behavior and boundary fixtures. The controller requires the
exact version `4.0.0`: an older or unexpected version is visible as
`firmware_outdated`, is excluded from reconciliation and manual override work,
and produces an explicit frontend installation message. Compatibility with the
old firmware is deliberately not claimed.

Wire duty remains normalized from 0 through 255. Firmware scales that value into
the configured 1-16-bit LEDC range. Reattaching at a new resolution rescales the
scheduled/current-overwrite caches and physical output, including an active
override. All configuration boundaries enforce
`frequencyHz * 2^resolutionBits <= 80,000,000`. The `sync` command accepts Unix
epoch seconds from 1 through 2,147,483,647.

NTP setup is now asynchronous and its hostname comes from the ignored firmware
configuration. DNS/NTP failure no longer blocks MQTT or manual control startup:
attempts have a non-blocking 15-second bookkeeping deadline, retry after 60
seconds, and re-arm after six hours if periodic SNTP callbacks stop. The MQTT
`sync` command remains an immediate controller-provided time source. On every
boot, persisted schedule pins are explicitly held off until either source
confirms current time; restored EEPROM time alone cannot authorize actuation.

The real sketch compiles warning-free in the pinned firmware image using Arduino
CLI 1.5.0, ESP32 core 3.3.8, ArduinoJson 7.4.3, and PubSubClient 2.8. The compiled
program uses 1,036,431 bytes (79% of flash) and 63,180 bytes (19% of global RAM),
leaving 264,500 bytes for local variables.
The compiler image contains only the resulting firmware binary in its final
scratch stage.

This closes the firmware source gate. It does not prove that any physical ESP32
has been flashed, that its board/pin wiring matches production, or that it has
survived a real power/network failure.

The tracked sketch no longer contains Wi-Fi or MQTT credential values. A local
ignored header preserves this machine's configuration, and a safe example is
used only for compiler verification. Firmware 4.0.0 supports an MQTT username/
password pair but still uses plaintext MQTT. Production therefore needs an
authenticated broker listener restricted to the trusted aquarium LAN; `mqtts://`
would require a future firmware change and physical validation. Because the old
credential exists in now-public Git history, it must be rotated. Making the
repository private later would not revoke it or recall public clones.

### Production-shaped import

Importer `legacy-json-v2` analyzed the production-shaped `.old/data` snapshot
with fingerprint
`15580a1ec55c1181db2a5d78f494ba18bc195f47a135b4b700028d5854033275`.
The result is valid with zero errors and 85 explicit warnings:

| Imported entity  | Count |
| ---------------- | ----: |
| Throttles        |    11 |
| Channels         |    66 |
| Schedules        |    66 |
| Schedule points  |   318 |
| Mapping profiles |     7 |
| Pin mappings     |    34 |

The importer only performs safe, declared normalization: it removes exact
duplicate start/terminal segments and materializes an implicit final zero at
minute 1439 when the preceding final target is already zero. Ambiguous or
nonzero tails remain fatal. Sketch5-era and runtime-only files are intentionally
skipped rather than treated as active configuration.

The snapshot committed to a disposable `state.db` as revision 1 with the counts
above, and an independent SQLite integrity check returned `ok`. No production
database was opened or modified. A changed final source snapshot must be
dry-run again; matching this historical fingerprint must not be assumed.

### Backup, integrity, and restore

The exact backup-artifact verifier added on 2026-07-19 passed its focused
four-file selection, 21/21 tests. Startup and storage health share one reader
that verifies only the canonical `backup-<createdAt>/manifest.json` named by the
latest successful interaction. It performs full schema-v2 checksum, SQLite
integrity/foreign-key, and replay-boundary verification and does not scan or fall
back to an older backup. Missing, corrupt, replaced, escaped, and symlinked
artifacts are unverified. Its cache is reused only while strong `lstat` identity
for the root, backup directory, manifest, and both databases remains unchanged,
with identity checked before and after verification. This prevents a stale audit
row from producing false-green health. Final settled-tree validation is pending.

In the historical 2026-07-15 round trip, the disposable imported state database
and a migrated events database were
backed up with SQLite's online backup API using coherent manifest schema v2.
The events-first copy intentionally captured no mirrored state event while the
later state copy contained import revision 1, exercising the replayable copy
gap. The verified manifest recorded boundaries `B=1`, `E=0`, and `S=1` and:

| Database    |   Bytes | SHA-256                                                            | Integrity |
| ----------- | ------: | ------------------------------------------------------------------ | --------- |
| `state.db`  | 684,032 | `ee796b489c814816ef0417d4b24def828e56a7383e392d1fe77471a0c34cb712` | `ok`      |
| `events.db` | 167,936 | `b116ad2c0d3bb8870b10310664af7f820284274459201713b551153626461ac0` | `ok`      |

Manifest verification passed, restore to two new paths passed, and both
restored databases passed integrity checks. The application reopened revision 1
with 66 channels, 66 schedules, seven mapping profiles, and one import run. Its
normalized pending outbox then replayed revision 1 into the restored earlier
events snapshot, producing events revision 1 without conflict. The original
disposable databases were not replaced. Production restore still requires a
controlled outage, new destination paths, application-open checks, an
operator-managed path switch, and retention of the prior files for rollback.

### Production containers and local stack

The following is historical container evidence, not a current running-status
claim. The production image uses a pinned Node 24 Bookworm base, runs as the
non-root `node` user, and has read-only filesystem support with only declared data
volumes and `/tmp` writable. The two verified local images are:

| Platform      | Image ID                                                                  |             Size |
| ------------- | ------------------------------------------------------------------------- | ---------------: |
| `linux/amd64` | `sha256:ab7b8a1d95d52b5f291456cf4a4b8dbbfbcad53875b18e0db0a283fc404e073a` | 92,990,812 bytes |
| `linux/arm64` | `sha256:c8caeb5db5673a1b3cb6ae8dc03d752f81d394fa5d394137dd0599b500be51ad` | 92,876,759 bytes |

The native amd64 image and emulated ARM64 image both reached readiness, served
the production SPA with HTTP 200, and created/opened both SQLite databases. The
ARM64 result is useful compatibility evidence, but it is not a substitute for
running under the production Pi's real kernel, disk, and load.

The pinned local Compose stack contains the controller, Mosquitto, and two
persistent fake ESP actors. A prior run reached healthy state, kept the A1/B2
device identity/configuration and fake EEPROM documents across restart, and
captured MQTT traffic only inside the test namespace. This report does not claim
that those services are running now.

The production Compose template fails closed without an explicit immutable
image, bind address/port, broker URL, MQTT safety interlock, and four host
storage directories. It drops capabilities, enables `no-new-privileges`, and
uses Docker's compressed `local` log driver capped at five 10 MiB files per
service. No production Pi deployment is encoded or performed by the repository.

## Database, logs, storage, and compression

The rewrite does not use a JSON-document database. `state.db` is the normalized,
authoritative configuration and controller-state database. `events.db` is a
separate append-oriented store for structured interactions, alert history,
maintenance diagnostics, and retained operational evidence. Filterable fields
are relational and indexed. Variable-shaped bodies use explicit schema-version
columns and strict parsers; they are not an unstructured substitute for the
relational model.

Cross-cutting API hardening caps identifiers and Fastify route parameters at 128
characters. `/api/events` and `/api/logs/export` are GET-only with implicit HEAD
disabled. Automatic built-in alert-rule seeding and delivery transitions through
`attempting`, `delivered`, `failed`, and `outcome_unknown` commit global
revision/outbox events with precise invalidations, but do not advance the
operator concurrency floor.

Pino writes redacted structured operational logs to stdout. In containers,
Docker stores and compresses those logs with the bounded `local` driver
described above. Durable application evidence belongs in structured
`events.db` rows, not in stdout log files. MQTT evidence stores metadata rather
than raw wire payloads; ordinary successful PWM traffic is short-lived `raw`
retention, healthy five-second scheduler ticks are omitted, mutation and HTTP
5xx interactions store bounded method/route/status metadata, and callback
failures store sanitized error classes without messages or stacks.

Default live logical event budgets total 6.5 GiB:

| Class         |      Age |  Budget | Disposal path                                   |
| ------------- | -------: | ------: | ----------------------------------------------- |
| `raw`         |   7 days | 512 MiB | Aggregate to five-minute summaries, then delete |
| `operational` | 180 days |   2 GiB | Verify Zstandard archive, then delete           |
| `aggregate`   |  3 years |   1 GiB | Verify Zstandard archive, then delete           |
| `audit`       |  3 years |   2 GiB | Verify Zstandard archive, then delete           |
| `critical`    | 10 years |   1 GiB | Verify Zstandard archive, then delete           |

Archives are deterministic NDJSON compressed as `.ndjson.zst`. The system
verifies compressed/content hashes, byte counts, schema, record counts, range,
and retention class before deleting live rows. Internal deletion batches are
capped at 10,000 records. Storage-health checks monitor available bytes,
one-year growth projection, unresolved retention/archive failures, and latest
backup outcome and freshness of the exact verified artifact. Backups remain
independent SQLite files plus a hash/integrity manifest; they are not the
retention archive format. Concurrent archive creation is monotonic: a completed
winner cannot be returned to pending/failed by a losing creator, and source rows
are deleted only after the winning artifact verifies.

## CI status

`.github/workflows/ci.yml` defines six independent validation jobs for:

- formatting, lint, typechecks, unit tests, and production builds;
- the critical suite;
- pinned-Mosquitto integration;
- production Chromium/Playwright;
- the pinned ESP32 compiler; and
- amd64/ARM64 container builds, health, hardening, restart, and SQLite checks.

Jobs install from the lockfile with `npm ci`. A separate optional
`publish-image` job runs only for pushes on the repository's default branch when
`AQUARIUM_GHCR_IMAGE` names the intended lowercase GHCR repository. It fails
closed unless registry inspection proves its
run-unique tag absent, publishes with provenance and SBOM metadata, captures the
returned manifest digest, and smoke-tests that exact digest on amd64 and ARM64.
Only the digest is a deployment identity; the tag is not treated as immutable.
Pull requests cannot publish, and there is deliberately no Pi deployment job.

GitHub Free does not charge standard hosted Actions minutes for public
repositories; private repositories use the included Actions quota. Free-plan
protected branches apply to public repositories, while private branch
protection requires an eligible paid plan. See GitHub's official
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation. Public visibility is not credential remediation.

This is repository evidence only. The workflow still needs a trusted hosted
run after history sanitization, repository/GHCR variable configuration,
appropriate branch protection, and review of the resulting artifacts.

## Resolved repository gates

### D1: Docker/Testcontainers

Resolved. Docker Desktop 4.81.0 exposes engine 29.6.1 on Linux/amd64. Real
Testcontainers, local Compose, native amd64, and emulated ARM64 evidence have
all run against that engine.

### D2: firmware failover defects

Resolved in firmware source 4.0.0 and its pinned compiler/fake fixtures. The
remaining fleet flash and physical validation are deployment gates, not an
unresolved controller-code fallback.

### D3: production-shaped legacy data

Resolved for the supplied local snapshot: analysis, disposable commit, counts,
and integrity all pass. The final Pi-side dry-run, operator review, target
backup, import, and cutover remain external. Any changed fingerprint or fatal
finding must stop migration; the importer must not silently repair it.

## Remaining release gates

### Finish locally

1. Run the complete settled-tree verification from a clean Linux `npm ci`
   context and record the final test/build counts.
2. Finish the independent three-consecutive-run, no-retry R12 audit and resolve
   any repeat-only failure before release.
3. Run the final source-safety, skipped-test, leaked-container, and documentation
   consistency audit.

### Complete outside this repository

1. Revoke the historical Dropbox token, rotate the aquarium Wi-Fi password, and
   publish only independently verified sanitized history. Keep secret scanning
   and push protection enabled afterward.
2. Flash every deployed ESP32 with 4.0.0, verify the exact reported version in
   the UI, and bench-test override expiry, schedule restoration, Wi-Fi loss, and
   power cycling before connecting production actuators.
3. Run CI on GitHub, configure branch protection and the intended lowercase
   `AQUARIUM_GHCR_IMAGE`, review artifacts, and select the reported immutable
   manifest digest.
4. Configure the Pi bind address, four storage directories, broker URL,
   production MQTT interlock, backup/rollback paths, and optional real alert
   webhook. Follow `docs/production-deployment.md` and start the digest without
   changing the legacy service yet.
5. Re-run the importer against the final source files, review all warnings,
   back up the intended target, commit during a controlled outage, and verify
   integrity, application health, devices, schedules, overrides, logs, and
   alerts. Retain the old data and controller for rollback.
6. Perform a supervised soak and cutover that exercises real wiring, Wi-Fi,
   Raspberry Pi disk/load, controller/broker/ESP restarts, and sudden power
   loss. Roll back on any unexplained actuator state or unresolved operation.

Until those steps are complete, the local evidence supports release preparation
and staging—not unattended production replacement.
