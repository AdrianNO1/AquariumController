# Aquarium Controller

This repository is a strict TypeScript rewrite of the Raspberry Pi aquarium
controller. The previous Python and Flask application remains under `.old/` as
migration evidence. The supported ESP32 source is
`firmware/esp32/ESP32Code/ESP32Code.ino`; firmware 6.0.1 is compiled and bundled
with the controller release.

Historical pre-4.1 release evidence dated 2026-07-25 includes 97 files/638 unit
tests, 82 files/571 critical tests, real-Mosquitto 5/5, and retry-free
Playwright 18/18. The protected pull-request and `master` runs passed all six
hosted validation jobs. That historical release source is
`886ed05be89a1abed8e076d91ce2802f5d5668dd`; its published amd64/ARM64 image is
`ghcr.io/adrianno1/aquarium-controller@sha256:0629bacbd1744eafd2c98b7c96890e6bf1a5d891dc44e77bd77702da1fb2becc`. That
exact digest passed health and both SQLite integrity checks as UID/GID 1000 on
both platforms. It predates firmware 4.1 and the per-device command-lane work,
so it must not be deployed as the current release. Select and record a new
source commit and exact image digest from a successful protected `master`
publication; the supervised deployment command performs that selection.

Firmware 6.0 adds the versioned structured MQTT protocol and per-device topics
to the existing pull OTA, output telemetry, persistent update-all policy,
SHA-256 verification, and probation rollback. Run the repository verification
lanes against the final source before selecting a new published image digest.

All reachable hosted branches contain only redacted credential sentinels and
retain the original commit topology. One unreachable historical GitHub object
remains directly addressable; credential revocation, GitHub Support cleanup,
and resolution of its open secret-scanning alert remain external gates. The
rewrite is deployed on the aquarium Pi, and a supported ESP has completed a
multi-day live schedule test. Firmware 3.x devices are command-gated and
continue using their local schedules; the new controller does not promise UI
discovery compatibility for them. The canonical
evidence and remaining fleet/operator gates are in the
[readiness report](docs/readiness-report.md).

## Frameworks and technology stack

| Layer         | Technology                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Runtime       | Node.js 24 LTS, npm 11, strict TypeScript 5.9                                                              |
| Controller    | Fastify 5 modular monolith with native SSE and Pino logs                                                   |
| Browser       | React 19, Vite 8, React Router 8, TanStack Query 5                                                         |
| Contracts     | Zod 4 schemas shared by controller and browser                                                             |
| Persistence   | Two SQLite WAL databases through Kysely and `better-sqlite3`                                               |
| ESP transport | MQTT.js 5 using MQTT 3.1.1/QoS 0 with versioned JSON and per-device topics                                 |
| Tests         | Vitest, Testing Library, Testcontainers with pinned Mosquitto, Playwright/axe, and an independent fake ESP |

One controller process owns HTTP, SSE, scheduling, persistence, alerts, and the
MQTT adapter. Mosquitto remains a separate process. The controller is
deliberately not horizontally scalable because device queues, schedules, and
state revisions need one owner. Firmware 6.0 uses correlated JSON requests and
responses on isolated per-device MQTT topics. The controller runs bounded
per-device command lanes, so an unresponsive ESP cannot block healthy devices.
Legacy broadcast topics remain passive discovery inputs only. The controller
never sends actuator, configuration, schedule, time, or OTA commands through
them; every pre-v6 device requires one USB bootstrap.

ESP pin mappings use explicit hardware profiles and explicit per-device profile
selection; device names no longer choose mappings. The bundled NodeMCU ESP-32S
profile permits only pins usable by the deployed boards. Profiles assigned to
an ESP warn when they use GPIO12 because it controls flash voltage during reset.
Fallback schedule artifacts include both the area and mapping-profile
multipliers, matching controller-driven intensity after Pi silence.

The global state revision is the contiguous snapshot/SSE cursor. User mutations
also serialize through a separate operator revision floor, so background device
or scheduler traffic does not create false edit conflicts while an intervening
operator change still rejects a stale draft. Forms pin that token when editing
begins and never substitute a newer live cursor for older form data.

Automatic built-in alert-rule seeding and notification delivery transitions
(`attempting`, `delivered`, `failed`, and `outcome_unknown`) also commit a global
revision/outbox event with precise owning-alert invalidations. They deliberately
do not advance the operator floor because they are background state changes.

HTTP identifiers are capped at 128 characters, aligned with Fastify's route-
parameter limit. `/api/events` and `/api/logs/export` are GET-only; implicit HEAD
handling is disabled. Firmware sync accepts Unix epoch seconds from 1 through
2,147,483,647. Device PWM configuration additionally enforces
`frequencyHz * 2^resolutionBits <= 80,000,000` across the supported 1-16-bit
resolution range.

See [the architecture](docs/architecture.md), [feature parity ledger](docs/feature-parity.md),
and [remaining-work plan](docs/remaining-work-plan.md) for the full design and
readiness boundary.

## Data, logs, and storage

The database is relational first, not a JSON document store:

- `state.db` is authoritative. Devices, mappings, channels, schedule points,
  throttles, operations, overrides, alerts, scheduler guards, and revisions are
  normalized `STRICT` tables with foreign keys and checks.
- `events.db` contains replayed state events, structured interactions,
  aggregates, retention runs/policies, and archive metadata. Keeping it separate
  prevents event maintenance from sharing the authoritative control-state file.
- JSON columns are reserved for variable-shaped payloads such as versioned
  operation requests/results, event envelopes, alert details, metadata, and
  compiled firmware documents. Each has a schema-version column and is validated
  at the application boundary; raw imported JSON also rejects duplicate keys.

Fastify/Pino service logs are structured JSON on stdout. Queryable operational
history is written separately to structured `events.db` rows. Authorization,
cookies, secrets, passwords, and tokens are redacted from Pino fields; durable
interaction payloads support sensitive-key redaction and are hashed after
redaction. Routine five-second PWM successes and normal wire acknowledgements
use the short-lived `raw` class; failures and outcome-unknown events use longer
operational, audit, or critical classes. Healthy scheduler ticks are not copied
into the durable event log. Every POST/PUT/PATCH/DELETE response and every HTTP
5xx response is recorded as method/route-template/status metadata only; healthy
reads are skipped. Runtime callback failures persist only a sanitized error class
and name, never messages or stacks. Detached writes report failures through Pino
and drain before `events.db` closes. Alert transitions remain immediate, while
repeated unchanged still-true observations are limited to one additional state
event per hour.

Daily retention is scheduled for 03:00 UTC with a persisted non-overlap guard.
The live logical event budgets total 6.5 GiB: 512 MiB raw, 2 GiB operational,
1 GiB aggregate, 2 GiB audit, and 1 GiB critical. Raw rows retain seven days and
are aggregated before deletion. Longer-lived classes are archived before
deletion as deterministic NDJSON compressed with native Zstandard, with both
compressed and uncompressed checksums/counts verified first. The same daily job
processes deterministic cross-table event candidates in internal batches capped
at 10,000, then prunes only unreferenced successful PWM operations older than
seven days, terminal notification deliveries older than 180 days when a newer
terminal result exists for the same alert/destination, and orphan revision
metadata in bounded batches, with durable success/failure diagnostics. Pending/
attempting deliveries and each destination's newest terminal result remain;
sanitized terminal outcome metadata is retained in `events.db`.

Storage health runs immediately at startup and then every five minutes by
default without overlap or catch-up. It monitors the lowest free space across
the state DB, events DB, archive, and backup filesystems; the one-year event
storage projection; retention failures after the latest successfully completed
run; archive failures after the latest completed archive; whether the latest
backup attempt failed; and whether a successful backup is missing or older than
36 hours. Six built-in typed rules open and recover alerts at a 1 GiB minimum-
free and 10 GiB projected-year default. Backup freshness is based on the actual
canonical artifact referenced by the latest successful audit row, not the audit
row alone. The controller fully verifies that schema-v2 backup and rejects a
missing, corrupt, replaced, escaped, or symlinked artifact; a stable filesystem
identity cache avoids redundant verification without hiding later changes. A
missing verified artifact makes startup create a fresh backup and keeps health
from reporting a false-green success. The controller creates a backup at 02:00
UTC and keeps the newest verified backup from each UTC day for 14 days, then
the newest verified backup from each UTC week for 183 days, without deleting
unknown or damaged entries. Compose uses Docker's compressed `local` log driver with
five 10 MiB files per service.

## Local development

Requirements: Node.js 24 and npm 11. MQTT is disabled by default.

```sh
npm ci
npm run dev
```

The Vite development UI listens on all interfaces at port `5173` and proxies
`/api` to the controller at `http://127.0.0.1:3001`. Open it locally at
`http://127.0.0.1:5173` or from another device on the trusted LAN using the
development computer's LAN address. This development UI has no authentication;
do not expose port `5173` beyond the trusted LAN. The controller remains bound
to loopback unless `AQUARIUM_HOST` is explicitly changed. The complete
variable/default/interlock reference is in
[the architecture](docs/architecture.md#configuration-reference).

The production-built single-origin UI/controller, pinned Mosquitto, and two
persistent fake ESPs can instead be started with:

```sh
npm run stack:test:up
npm run stack:test:status
```

The UI and API are at `http://127.0.0.1:3001`; the test-only broker is at
`mqtt://127.0.0.1:18883`. The stack uses only `test/aquarium/*`. Controller
state, events, archives, backups, broker state, and fake EEPROMs live in named
`aquarium-test_*` volumes and survive `npm run stack:test:down`. The containers
run non-root with read-only application filesystems; only those storage volumes
and `/tmp` are writable.

Useful checks:

```sh
npm run lint
npm run typecheck
npm run test:unit
npm run test:critical
npm run test:integration
npm run test:e2e
npm run build
npm run verify
docker build --file firmware/esp32/Dockerfile.compile --tag aquarium-esp32-compile:6.0.1 .
```

For a new OTA release, use `npm run firmware:release -- <version>` rather than
copying a local Arduino build. The complete versioning, artifact, and review
checklist is in [the ESP32 firmware guide](firmware/esp32/README.md#preparing-a-firmware-release).

CI defines six validation jobs: static/unit, critical, real-Mosquitto
integration, production-Chromium, firmware, and amd64/ARM64 container. It also
renders the fail-closed production Compose template and rejects
tracked/generated build artifacts. A separate GHCR `publish-image` job is
limited to pushes on the repository's default branch. The configured
`AQUARIUM_GHCR_IMAGE` is `ghcr.io/adrianno1/aquarium-controller`. Publication
uses a run-unique tag, reports the resulting manifest digest, and smoke-tests
that exact digest on amd64 and ARM64.
Pull-request code never runs on a Pi, and no deploy job exists.
After a successful protected `master` publication, a maintainer can run the
approval-gated `npm run production:deploy` command from a trusted workstation.
It selects the exact CI digest, copies a verified recovery bundle off the Pi,
and verifies or rolls back the supervised update.

The historical pre-4.1
[pull-request run](https://github.com/AdrianNO1/AquariumController/actions/runs/30158546118)
and [`master` run](https://github.com/AdrianNO1/AquariumController/actions/runs/30158994132)
are green. The current branch still requires its own protected run and a new
published digest. `master` requires pull requests, a current branch, all six
exact check contexts, and administrator enforcement; force-pushes and deletion
are blocked. GitHub Free provides standard hosted Actions without a minutes
charge for public repositories. See GitHub's official
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and
[protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation.

## Safe storage commands

Every storage command requires explicit paths. The CLI never infers a production
database and restore refuses existing destination files.

```sh
npm run storage -- initialize-events --events-db <new-events.db>
npm run storage -- backup --state-db <existing-state.db> --events-db <existing-events.db> --destination <backup-parent-directory>
npm run storage -- verify-backup --manifest <backup-directory/manifest.json>
npm run storage -- integrity --state-db <existing-state.db> --events-db <existing-events.db>
npm run storage -- retention --events-db <existing-events.db> --archive-dir <archive-directory>
npm run storage -- verify-archive --events-db <existing-events.db> --archive-dir <archive-directory> --archive-id <archive-id>
npm run storage -- verify-archive-set --events-db <existing-events.db> --archive-dir <archive-directory> --output <new-archive-set-manifest.json>
npm run storage -- decode-archive --archive-file <archive.ndjson.zst> --output <new-output.ndjson>
npm run storage -- restore --manifest <backup-directory/manifest.json> --state-db <new-state.db> --events-db <new-events.db>
```

`initialize-events` creates and migrates only an absent target. It refuses an
existing database or SQLite sidecar and atomically publishes the verified new
file without starting the controller or MQTT.

Backup uses SQLite's online backup API, copies events before state, and records
SHA-256, byte counts, integrity results, and both copied revision boundaries in
a schema-v2 manifest. Each database is checkpointed into one standalone file,
without an untracked WAL sidecar dependency. Verification proves that state
committed during the copy gap has contiguous outbox coverage. Retained outbox
rows absent from the copied events database are reset to replay immediately
after restore; this bounded, recovery-first behavior can temporarily reintroduce
recently age-pruned events. Legacy schema-v1 manifests are rejected because they
cannot prove cross-database coherence. Restore first performs the same full
verification and atomically publishes with no replacement if a destination
appears during the operation. Perform a restore during a controlled outage,
restore to new paths, validate them, and only then change the operator-managed
configuration or roll back to the prior paths. Each backup attempt also appends
one metadata-only `maintenance.backup` audit interaction to
the source events database. It records only success/failure and severity—never
paths, secrets, raw errors, or database payloads—so a later successful backup
recovers the built-in latest-backup-failed alert. If both backup and diagnostic
persistence fail, the command surfaces both errors.

Concurrent archive creators use monotonic state transitions: a completed archive
never returns to pending or failed because another creator lost the race. The
winner is verified before source deletion, and a losing creator returns the
same completed artifact without deleting source rows prematurely.

Database backups do not duplicate long-term `.ndjson.zst` files. Back up the
archive directory separately together with the matching events database. Run
`verify-archive-set` before and after the copy and preserve/compare its
deterministic versioned manifest. Archive metadata uses portable filenames, so
restored archives resolve beneath the explicit replacement directory even when
legacy rows originally contained absolute paths. The controller does not delete
verified archives automatically because they may be the only remaining payload
copy; configure an offsite/archive lifecycle and monitor the projection/free-
space alerts before production.

## Safe legacy import

The importer has no implicit legacy or production path. Analysis is the default
and does not open a database; commit requires both explicit flags and stops if
the complete analysis is invalid.

```sh
npm exec -- tsx apps/controller/src/infrastructure/import/legacy-import-cli.ts --source <explicit-legacy-directory>
npm exec -- tsx apps/controller/src/infrastructure/import/legacy-import-cli.ts --source <explicit-legacy-directory> --commit --state-db <explicit-state.db>
```

Run and review the dry-run first, and never repair invalid production input
silently. `.old/data` is intentionally ignored operator-local production input:
it is not committed, copied into images, or used by CI. Automated migration
coverage creates deterministic synthetic JSON fixtures in temporary
directories. Those fixtures prove importer behavior but do not certify the
aquarium's data. For the first production migration, preserve the legacy
installation and an immutable copy of its JSON, then commit that exact stopped
snapshot only into a newly claimed state database. Back up an existing target
only for nonproduction importer work; subsequent SQLite upgrades use the
separate verified database/archive backup procedure.

## Remaining release actions

- Confirm the affected credential was independently revoked, ask GitHub Support
  to purge the directly addressable unreachable object/cached view, resolve the
  remaining secret-scanning alert as `revoked`, and keep secret scanning and
  push protection enabled.
- Flash firmware 6.0.1 to every deployed ESP32 and persist its device-specific
  network configuration in NVS. Every firmware version below 6.0.0 requires USB
  bootstrap and receives no command from the new controller. If a firmware-5
  device already persisted anonymous MQTT settings, the documented one-time USB
  network-reprovision switch replaces them without erasing its ID or schedule.
  Older firmware remains visible
  through passive discovery, is
  marked `firmware_unsupported`, and receives no schedule, output,
  configuration, or time-sync commands. Firmware 6.0.1 retains
  wear-limited persisted diagnostics, best-effort per-pin schedule activation,
  correlated outcomes, and
  rollover-safe override expiry. Routine controller and manual PWM writes use
  `overwrite=true`, so the ESP suppresses its local schedule while the Pi is
  refreshing it and resumes local scheduling after 120 seconds of Pi silence.
  Wire duty remains normalized 0-255; firmware scales it to the configured
  1-16-bit range and rescales scheduled/current-overwrite caches and physical
  output when resolution is reattached. NTP synchronization is asynchronous,
  so DNS/NTP failure does not delay MQTT or manual-control startup. If neither
  the Pi nor NTP is reachable after reboot, a valid persisted EEPROM timestamp
  intentionally authorizes the local schedule from that boundedly stale
  estimate. Firmware 6.0.1 additionally reports the board hardware profile,
  enforces the safe output-pin set, bounds SPIFFS repair attempts, preserves
  local scheduling when network configuration is unavailable, verifies MQTT
  subscription and OTA probation transitions, and removes remote fleet-wide
  EEPROM clearing. It publishes commands, responses, and announcements as
  strict versioned JSON on per-device topics.
- Configure the ESP32's ignored local firmware header with the Pi broker,
  `nemo` MQTT account, and intended NTP host. The shared broker still permits
  anonymous non-aquarium topics for the unrelated legacy ESP but denies
  anonymous access to `aquarium/v1/#`. Restrict that plaintext broker listener
  to the trusted aquarium LAN. The current ESP firmware does not
  support `mqtts://`; enabling
  TLS would require another firmware change and physical validation.
- Set `AQUARIUM_FIRMWARE_BASE_URL` to the controller's ESP-reachable local HTTP
  origin, such as `http://192.168.1.73:3001`. OTA has no separate password; the
  controller and ESP validate the bundled image by exact size and SHA-256, so
  the HTTP endpoint and MQTT broker must remain restricted to the trusted LAN.
- For subsequent releases, merge through protected CI and run
  `npm run production:deploy` from an up-to-date, clean local `master`. No Pi
  deploy workflow is enabled. The local command selects the exact successful
  GHCR publication, creates and copies a verified recovery set off-host, and
  performs a supervised verified update with automatic image rollback. Follow
  the
  [Raspberry Pi deployment and rollback runbook](docs/production-deployment.md),
  including its database-restore procedure for a migration-incompatible
  rollback.
- Use the concise
  [Pi production handoff checklist](docs/pi-production-handoff.md) to collect
  the remaining external inputs and choose the correct first-migration or
  subsequent-upgrade rollback branch. Ordinary repository work and GitHub CI do
  not contact the Pi.
- Configure and test a separate backup/offsite lifecycle for the archive
  directory using `verify-archive-set`; database backups alone do not contain
  archived event payloads.
- Select and configure a real `AQUARIUM_ALERT_WEBHOOK_URL` if notifications are
  wanted; there is deliberately no default destination. Production Compose
  passes through the URL, destination key, timeout, and paired authentication
  header variables without storing their values in the repository.
- Run the documented dry-run again on the final Pi-side source snapshot, review
  every warning, preserve the legacy installation and immutable JSON snapshot,
  commit into newly claimed storage during a controlled outage, then create the
  candidate schema-v2 backup and retain the legacy controller/data for rollback.
- Perform a supervised hardware soak/cutover. Local tests cannot prove wiring,
  power-loss behavior, Wi-Fi quality, or the Raspberry Pi's real disk/load.

The conservative current evidence is recorded in
[docs/readiness-report.md](docs/readiness-report.md).
