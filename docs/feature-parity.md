# Feature parity matrix

Updated: 2026-07-25

This is the final repository-level migration ledger for retained behavior.
Active legacy code is the source of truth when it disagrees with legacy tests.
For ESP-observable behavior, the original
`.old/slaveCode/ESP32Code/ESP32Code.ino` behavior and the replacement 4.0.0
firmware are compared explicitly.

Status means:

- **Not started**: no working replacement exists.
- **Partial**: meaningful implementation/evidence exists, but the retained
  workflow has not passed all required repository evidence.
- **Implemented**: the replacement and its applicable unit/component,
  pinned-real-broker, production-built-browser, persistence, fault, and restart
  evidence exist and pass.
- **Blocked**: an explicit safety decision or prerequisite prevents the
  repository parity claim.

All 17 retained rows are **Implemented** at repository level. The cross-layer
results below include settled-tree local evidence. They do not claim hosted CI,
Pi deployment, or physical-device acceptance. The decisive evidence is:

- five Testcontainers tests against digest-pinned Mosquitto 2.0.22, covering
  the enumerated wire, fault, boundary, persistence, restart, and namespace
  cases;
- three consecutive 18/18 retry-free Chromium runs against production-built
  assets, fresh SQLite databases, real Mosquitto, and independent MQTT fake ESP
  actors, covering routes, reload, responsive and axe checks, configuration
  CRUD, devices, overrides, logs, alerts, faults, and restarts;
- passing 95-file/618-test unit and 81-file/557-test critical selections in a
  clean Linux build, plus healthy read-only/non-root amd64 and emulated ARM64
  container evidence;
- ESP firmware 4.0.0, independent compatibility/failover tests, exact-version
  gating with a visible frontend error, and a warning-free compile using the
  pinned Arduino toolchain. The focused 2026-07-19 compile used 1,036,431 bytes
  of flash and 63,180 bytes of global RAM, leaving 264,500 bytes for local
  variables; and
- deterministic synthetic legacy-import coverage plus SQLite integrity, backup,
  verification, and restore evidence. The ignored operator-local production
  snapshot remains an external deployment input.

This is not a claim that the physical ESP32 fleet has been flashed or that the
production Raspberry Pi has been deployed. Those are external acceptance
actions listed after the matrix, not missing repository implementation.

## Retained features

|   # | Retained feature                                      | Legacy source / new owner                                                                      | Implemented behavior and passing repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Repository status / external boundary                                                                                                                            |
| --: | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Home and navigation                                   | `.old/app.py:index`, `.old/templates/index.html`; React `App`                                  | All 11 retained area links, Overview/Alerts/Logs navigation, useful 404 recovery, removal of unsafe admin/OS controls, same-origin production static serving, cache/CSP behavior, and SPA fallback have component/container evidence. Production-built Playwright covers every direct route, reload, invalid-route keyboard recovery, phone/tablet/desktop layout, axe, local assets, and console/network auditing.                                                                                                                                        | **Implemented.** Pi deployment remains external.                                                                                                                 |
|   2 | Control pages for every device type                   | `.old/app.py:control`, `lightpumps.html`; `ControlAreaPage`                                    | `lights`, `pumps`, `testlights`, `bad`, `loft`, `biljard`, `frag`, and `qt1`-`qt4` project typed snapshot state through one reusable page. Component tests render every slug and exercise the workflows; production-built browser tests cover all direct routes/reloads and representative responsive, accessibility, online, stale, offline, fault, and recovery states against the real test stack.                                                                                                                                                      | **Implemented.**                                                                                                                                                 |
|   3 | UTC schedule graph and interpolation                  | Legacy JS/Python and firmware evaluator; `packages/domain`, independent fake, `ScheduleEditor` | Canonical and firmware-compatibility evaluators cover rising/flat/falling segments, every UTC minute, wrap, malformed graphs, zero-duration semantics, firmware float behavior, half-even host rounding, throttle/gain, and editor reducer validation. The UI supplies an SVG view plus equivalent UTC forms. Production-built keyboard CRUD, persistence/reload, responsive, and axe coverage exercises the editor without relying on pointer-only interaction.                                                                                           | **Implemented.**                                                                                                                                                 |
|   4 | Channel and schedule-point editing                    | Legacy graph/upload handlers; configuration repository/routes and React editor                 | Revision-checked atomic create/rename/delete and schedule replacement exist. Channel creation provisions a valid owned UTC schedule; deletion is transactional and checks mappings/override history. Reducer/component coverage includes point add/edit/remove/discard, validation, dirty state, and conflicts. Playwright proves channel/point creation, schedule save, rename, conflict rejection, deletion, settled revisions, and database-backed persistence across reload.                                                                           | **Implemented.**                                                                                                                                                 |
|   5 | Per-type throttles                                    | Legacy upload/compiler; normalized throttle, compiler, reconciliation, UI                      | Typed mutation API/UI, 0-100 constraints, half-even evaluation, affected-device projection, and schedule-trigger routing exist. Legacy 100% fallback is import provenance, never silent repair. Browser evidence saves and reloads a throttle through the production database; reconciliation unit tests plus the composed real-broker/runtime test prove the resulting artifact and output delivery path.                                                                                                                                                 | **Implemented.**                                                                                                                                                 |
|   6 | Temporary/manual overrides                            | Legacy slider/manager and firmware `s`; override service/repository/routes/runtime/UI          | Server-authoritative start, extend, cancel, expire, restart initialization, reconcile, durable operations/targets, scheduler overlay, unscheduled outputs, exact 119999/120000-ms behavior, rollover safety, and outcome-unknown/no-retry behavior are covered. The browser gets the active state from a real fake-ESP response; broker/runtime tests cover refresh, controller stop, firmware failover, and controller/database restart recovery.                                                                                                         | **Implemented.** Firmware 4.0.0 must still be flashed onto physical ESP32s.                                                                                      |
|   7 | Device/channel/pin mappings                           | Legacy channel configuration/compiler; mapping profile API/UI                                  | Normalized profiles/mappings, exact revision writes, case-sensitive prefix overlap checks, duplicate pin/target validation, capacity validation, and UI conflict handling exist. Browser evidence edits gain/mapping state and proves reload persistence; unit projection and the composed pinned-broker runtime prove the mapped schedule reaches the intended device/pin.                                                                                                                                                                                | **Implemented.**                                                                                                                                                 |
|   8 | ESP discovery and registry                            | Legacy `ESP32Manager`; device registry/runtime plus fake fleet                                 | Persistent announcements, desired/reported separation, online/stale/offline transitions, subscribe-before-discover, duplicate/malformed handling, restartable fake persistence, and device-health alert evaluation exist. Pinned-Mosquitto tests cover multiple actors, duplicate/delayed/malformed announcements, actor reconnect/restart, controller restart, broker restart, rediscovery, and namespace capture. Exact firmware gating preserves an outdated device visibly with `firmware_outdated`.                                                   | **Implemented.** Physical-device discovery is an external post-flash/deployment check.                                                                           |
|   9 | ESP name/frequency/resolution editing                 | Legacy `editesp`, firmware `e`; operation service/API/UI                                       | Strict command builders, desired-state mutation, durable operation status, exact response matching, bounds, and pending/failure/unknown UI exist. Frequency/resolution pairs enforce `frequencyHz * 2^resolutionBits <= 80,000,000`. Resolution reattachment rescales scheduled/current-overwrite caches and physical output. Historical real-broker/browser evidence covers authoritative configuration and fake persistence.                                                                                                                             | **Implemented.** Physical EEPROM/LED validation remains external.                                                                                                |
|  10 | Schedule compilation, serialization, `syncTime`, DJB2 | Legacy compiler/manager and firmware schedule handler; domain/protocol/artifact repository     | Deterministic compact payload/hash, 4095/4096 boundary, persisted desired artifact, reported-hash no-op, exact-current-firmware gate, mismatch/unknown outcomes, coalescing, restart, and independent fake SPIFFS/hash/evaluation tests exist. Real-broker tests carry compiled schedules through UTF-8 chunking, verify `schedule_ok`, hash announcement, evaluation, persistence/restart, and the separate `sync` command.                                                                                                                               | **Implemented.**                                                                                                                                                 |
|  11 | Schedule update triggers                              | Legacy upload/channel/device callbacks; state invalidations and reconciliation service         | Committed channel, schedule, throttle, profile, mapping, and device changes project deterministic affected-device reconciliation. Tests cover every trigger, hash no-op, coalescing, mismatch, unknown latch, serialization, and supersession. Production-browser mutations exercise the composed invalidation path, while pinned-broker capture verifies canonical serialized wire work and mapped artifact delivery without concurrent overlap.                                                                                                          | **Implemented.**                                                                                                                                                 |
|  12 | Five-second host refresh                              | Legacy manager loop and firmware `s`; output scheduler                                         | Injected monotonic/UTC clock, anchored five-second cadence, no overlap/catch-up burst, every-output evaluation, normalized 0-255 wire duty, throttle/gain, manual overlay, stop drain, diagnostics, and the shared outcome-unknown latch are unit-tested. Firmware scales normalized duty across configured 1-16-bit output. Historical pinned-broker evidence covers scheduled/overridden refresh and restart boundaries.                                                                                                                                 | **Implemented.** Pi timing/load observation remains an external deployment check.                                                                                |
|  13 | 120-second override/failover                          | Firmware 4.0.0, fake ESP, and override runtime                                                 | Firmware 4.0.0 uses rollover-safe elapsed-time subtraction and invalidates schedule-output caches after override expiry, PWM reattachment, and schedule replacement, including a zero target. Resolution reattachment rescales scheduled/current-overwrite caches and the physical duty. Independent fake tests pin the boundary, rollover, replacement, and sudden-controller-death cases. Exact-version gating blocks other firmware. The focused sketch compile is recorded above.                                                                      | **Implemented in the repository.** Flashing and observing every deployed ESP32 remains external.                                                                 |
|  14 | Time synchronization                                  | Legacy daily 05:00 loop and firmware `sync`; time-sync coordinator                             | Announcement-triggered and persisted once-per-day 05:00 UTC flows, DST independence, restart guard, exact distinct `sync` command, stop drain, and shared outcome-unknown handling are unit-tested. Pinned-broker tests verify exact sync response and persisted fake time; the composed runtime verifies announcement sync and retained time across actor/controller/database restart.                                                                                                                                                                    | **Implemented.** Physical clock observation remains external.                                                                                                    |
|  15 | MQTT serialization and response correlation           | Legacy manager and firmware callback/reassembly; protocol/transport/fake                       | MQTT 3.1.1 options, test-topic guards, one global queue, batch-local indexes, max-three-per-target batching, 256/257-byte and chunk limits, correlation, malformed/ignored response handling, timeout/unknown latch, no retry, and independent fake faults exist. Digest-pinned Mosquitto evidence covers multiple actors, canonical ID/name mapping, wire non-overlap, local indexes, chunk boundaries/faults, response faults, reconnects, and namespace capture. Firmware 4.0.0 takes an optional username/password pair from its ignored local header. | **Implemented.** ESP MQTT is plaintext; production needs an authenticated listener restricted to the trusted LAN, or a future physically validated TLS firmware. |
|  16 | Logs UI, filtering, pagination, export                | Legacy log helpers/pages; `events.db`, log service/routes, `LogsPage`                          | Stable `(occurred_at_ms,id)` cursor queries, typed filters, payload validation/hash/redaction, bounded GET-only NDJSON/CSV export, CSV formula policy, URL-backed UI filters, pagination/detail/export, and empty/error tests exist. Implicit HEAD is disabled. Archive creation is monotonic under concurrent creators. Backup freshness verifies the exact canonical artifact instead of trusting an audit row; focused 2026-07-19 evidence passed 21/21 tests across four files.                                                                        | **Implemented.** The separate archive-directory offsite lifecycle remains an external deployment action.                                                         |
|  17 | Failure, timeout, stale and pending UI states         | Legacy control/log pages; snapshot/SSE coordinator and status components                       | Snapshot-before-stream, replay coalescing, duplicate/gap/resync handling, heartbeat staleness, revision conflict, operation states, offline/stale text, log errors, alert delivery failures, acknowledgement conflict, and every override terminal state have unit/component coverage. Retry-free Playwright exercises controller restart/replay, browser network loss/reconnect, fake persistence, broker restart, dropped responses/outcome unknown, offline alert acknowledgement/recovery, axe, and console auditing.                                  | **Implemented.**                                                                                                                                                 |

## Unknown-outcome reconciliation parity

- An ambiguous publication is persisted as `outcome_unknown` and is never
  retried. Reconciliation preserves that status and adds a durable timestamp; it
  does not claim that the command succeeded or failed.
- Startup recovery restores the global safety latch from unresolved persisted
  operations. A live unknown also makes the MQTT runtime unready and blocks the
  transport/scheduler lane. Readiness returns only after all unknowns are
  reconciled and startup schedule reconciliation succeeds again.
- Generic device reconciliation is revision checked and commits a
  critical-retention `operation.outcome-reconciled` revision/outbox event. An
  unknown PWM overwrite cannot be reconciled before the complete 120-second
  firmware overwrite window ends.
- Manual-override aggregates own their uncertain child operations. Generic
  device reconciliation rejects an owned child; the override-specific workflow
  safely reconciles the child and aggregate through its own durable event after
  the stored safety deadline, without resending the command.
- The operation-details UI binds reconciliation to the inspected operation ID,
  requires an explicit physical/device-state checkbox, sends one non-retrying
  mutation, reports conflicts without clearing the action, and keeps displaying
  the original unknown status. Success shows the authoritative revision, while
  later details show the persisted reconciliation time. Unknown
  manual-override aggregates remain on their owner-specific card and route.
- A separate oldest-first unresolved window and global `/operations` page keep
  blockers available after recent-history truncation or mapping changes. The
  bounded page reports when more rows remain and reveals them as earlier
  outcomes are reconciled.

## ESP/MQTT observable contract

Cross-cutting API contracts cap identifiers and Fastify route parameters at 128
characters. `/api/events` and `/api/logs/export` are GET-only. Automatic alert-
rule seeding and delivery transitions (`attempting`, `delivered`, `failed`, and
`outcome_unknown`) use global revision/outbox events with precise invalidations,
but do not advance the operator concurrency floor.

The independent fake does not import controller parsing, framing, hashing,
compilation, expected-response, or reassembly behavior. Five integration tests
exercise the controller and independent actors through digest-pinned
`eclipse-mosquitto:2.0.22-openssl`; the harness captures both
`test/aquarium/#` and `aquarium/#` and rejects any publication outside the test
namespace.

| Input/constraint        | Firmware behavior retained or deliberately replaced                                                                                  | Passing independent/unit evidence                                                                     | Passing pinned-broker evidence                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT transport          | MQTT 3.1.1, QoS 0, non-retained                                                                                                      | Controller/fake options and lifecycle tests; configuration rejects unsafe development/test brokers    | Real connections, subscriptions, QoS 0/non-retained publications, reconnect lifecycle, and broker restart pass against the pinned image                        |
| Topics                  | Tests use `test/aquarium/{command,announce,response}`; production strings require every safety interlock                             | Exact topic builder and runtime guards                                                                | Capture subscribes to test and production namespaces on every test; teardown proves zero `aquarium/*` traffic                                                  |
| `discover`              | Bare payload; every ESP announces                                                                                                    | Subscribe-before-discover and announcement state-machine tests                                        | Multiple actors, duplicates, malformed/delayed announcements, reconnect, actor/controller restart, and broker restart all rediscover correctly                 |
| `s pin value overwrite` | Normalized 0-255 duty scaled to configured 1-16-bit output, exact response, refreshed overwrite, and rollover-safe 120-second expiry | Bounds, scaling, extension, scheduled/unscheduled pin, boundary, rollover, and cache tests            | Historical broker evidence covers refresh, dropped/delayed response, unknown latch, no retry, controller death, expiry, and restart recovery                   |
| `p`                     | Exact response `o`                                                                                                                   | Exact, other-target, and batch-index tests                                                            | Success, delayed, duplicate, malformed, timeout, interrupted broker, mismatch/correlation, and post-reconciliation pings pass                                  |
| `e name freq res`       | Persist actual values; require `frequencyHz * 2^resolutionBits <= 80,000,000`; reattach PWM and rescale caches/physical output       | Bounds, joint LEDC constraint, exact response, EEPROM restart, and reattachment scaling tests         | Historical broker evidence covers configuration response, reported announcement, fake persistence/restart, and browser-authoritative operation                 |
| `sc JSON`               | Validate/store, attach channels, invalidate cached outputs, and return `schedule_ok`                                                 | Golden payload/hash, capacity, restart, evaluation, and zero-target replacement tests                 | UTF-8 chunk transport, `schedule_ok`, hash announcement, independent evaluation, actor persistence, and 4095-byte success pass                                 |
| `sync epoch`            | Persist and echo Unix epoch seconds in the inclusive range 1-2,147,483,647                                                           | Exact lower/upper-bound validation, response, persisted fake clock, UTC-minute, and coordinator tests | Historical broker evidence covers exact response, announcement sync, persisted fake time, and controller/database/actor restart                                |
| `r pin`                 | Return `r pin value`; metadata request has a distinct error                                                                          | Analog/metadata golden fake tests                                                                     | Typed analog read is correlated through a multi-device, batch-local-index broker exchange                                                                      |
| bare `clear`            | Broadcast and return plaintext `EEPROM cleared`                                                                                      | Golden controller/fake fixture                                                                        | Both independent actors reply; their default identity is restored                                                                                              |
| targeted `clear`        | Rejected by deployed and replacement firmware                                                                                        | Negative golden fixture                                                                               | Targeted publication returns the expected invalid-command response                                                                                             |
| unknown/other target    | Targeted unknown returns error; other target emits no entry but advances the original index                                          | Invalid/no-response/original-index fake fixtures                                                      | Multi-actor batch capture and response frames prove original command indexes and controller correlation across actors                                          |
| batching                | Semicolon payload, max three per physical target, local response indexes                                                             | Pure controller correlation and independent multi-device tests                                        | Canonical ID/name commands, two actors, per-target flushing, and exact batch-local response frames pass                                                        |
| chunking                | Above 256 UTF-8 bytes, 200 data bytes, max 50 chunks, 10-second reset, one global buffer                                             | Protocol and fake boundary/partial/duplicate/out-of-order/reset tests                                 | 256/257 UTF-8 bytes, 200/57 data split, 50/51 chunks, partial/duplicate/out-of-order/reset, and 4095/4096 schedule limits pass over the broker                 |
| wire concurrency        | One global operation in flight                                                                                                       | Serialized transport and dispatcher tests                                                             | Concurrent callers capture one publication at a time; the second starts only after the first response and stale/duplicate responses are rejected               |
| timeout                 | Outcome unknown and no blind actuator retry                                                                                          | Transport/operation/override/scheduler latch tests                                                    | Dropped, delayed, duplicate, malformed, and broker-interrupted responses prove one actuator publication, unknown latch, explicit acknowledgement, and recovery |

## Known legacy discrepancies and migration hazards

1. The legacy interleaved-batching test expects three batches, while the running
   manager resets all per-device counts after a flush and produces two. Running
   code wins.
2. `clear` is a bare broadcast with plaintext replies. The manager's targeted
   expectation is incompatible with firmware.
3. A schedule's `syncTime` is stored but does not set the firmware clock; only
   the separate `sync` command does.
4. `currentSchedule` is a 4096-byte C buffer. Reserving the terminating NUL
   makes 4095 bytes the safe serialized maximum.
5. **Fixed in firmware 4.0.0:** host PWM values remain a normalized 0-255 on
   the wire and firmware scales them to the configured resolution. Resolution
   reattachment also rescales cached physical duty, including active overrides.
6. Ordered case-sensitive prefixes, an empty mapping key, case-distinct channel
   names, hidden `mainLys70` gain, and missing throttles are import findings,
   never silent repairs.
7. Legacy firmware versions `0`, `1`, and `2w` did not receive schedules. The
   replacement requires the exact current version, 4.0.0; every other reported
   version remains visible as `firmware_outdated` and is excluded from
   reconciliation and actuation.
8. **Fixed in firmware 4.0.0:** schedule-output caching previously left a stale
   physical output after override expiry, PWM reattachment, or a zero-target
   schedule replacement. The firmware now invalidates the affected cached
   channel values and synchronizes remembered output state, with independent
   regression tests for all three paths.
9. **Fixed in firmware 4.0.0:** the previous absolute 32-bit `millis()` expiry
   comparison could expire an override immediately near rollover. Expiry now
   uses unsigned elapsed-time subtraction, with rollover and exact-boundary
   regression tests.

## External acceptance boundary

Repository parity does not perform or claim these environment-specific actions:

- flash firmware 4.0.0 onto each physical ESP32, confirm each announcement is
  accepted as current, and observe PWM/failover behavior on the actual loads;
- select immutable production image/platform digests and deploy them to the
  Raspberry Pi with explicit broker, database, archive, backup, bind, and
  resource settings;
- run the production-shaped import against the operator-selected final source
  and destination paths, then perform integrity/application-open checks before
  cutover; and
- verify the production broker, storage filesystem, alert destination, backup
  destination, load, health, rollback, and power-loss procedures in that
  environment.

An older physical ESP remains visible in the frontend with a
`firmware_outdated` error, but the controller does not send it schedules or
actuator operations. That is a deliberate safety gate, not backward
compatibility.

## Explicit exclusions

These are not replacement-readiness requirements unless separately authorized:

- `.old/sketch5.html`, switches, sensors, countdowns, and simulated DSL flows;
- DSL dosing and pump calibration described only in old TODO material;
- direct Pi sensors and dormant USB Arduino support;
- legacy login, remote access, certificate management, and public exposure; and
- kill, shutdown, reboot, git-pull, and self-update routes.

The retained active UI is `/`, `/control/<device_type>`, `/logs`, and the new
safe `/alerts` surface. Unsafe Python `eval`, global response queues, raw JSON
writes, hard-coded infrastructure, and silent failures are legacy defects, not
features to preserve.
