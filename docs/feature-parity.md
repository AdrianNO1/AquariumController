# Feature parity matrix

Updated: 2026-08-02

This is the final repository-level migration ledger for retained behavior.
Active legacy code is the source of truth when it disagrees with legacy tests.
For ESP-observable behavior, the original firmware behavior and the current
replacement firmware 5.0.6 are compared explicitly.

Status means:

- **Not started**: no working replacement exists.
- **Partial**: meaningful implementation/evidence exists, but the retained
  workflow has not passed all required repository evidence.
- **Implemented**: the replacement and its applicable unit/component,
  pinned-real-broker, production-built-browser, persistence, fault, and restart
  evidence exist and pass.
- **Blocked**: an explicit safety decision or prerequisite prevents the
  repository parity claim.

All 17 retained rows are **Implemented** at repository level. The current 5.0.6
branch still requires its own protected CI run, merge, image publication, and
immutable digest selection before Pi handoff. It does not claim Pi deployment
or physical-device acceptance.

The following release evidence belongs to the historical pre-4.1 baseline,
source `886ed05be89a1abed8e076d91ce2802f5d5668dd`, and must not be used as the
current deployment identity:

- five Testcontainers tests against digest-pinned Mosquitto 2.0.22, covering
  the enumerated wire, fault, boundary, persistence, restart, and namespace
  cases;
- local, protected PR, and protected `master` 18/18 retry-free Chromium runs
  against production-built assets, fresh SQLite databases, real Mosquitto, and
  independent MQTT fake ESP actors, covering routes, reload, responsive and axe
  checks, configuration CRUD, devices, explicit outcome reconciliation, logs,
  alerts, faults, and restarts;
- passing 97-file/638-test unit and 82-file/571-test critical selections, plus
  healthy read-only/non-root amd64 and emulated ARM64 container evidence in both
  protected hosted runs;
- the historical multi-platform image
  `ghcr.io/adrianno1/aquarium-controller@sha256:0629bacbd1744eafd2c98b7c96890e6bf1a5d891dc44e77bd77702da1fb2becc`,
  published and passed exact-digest health and SQLite integrity smoke on both
  platforms;
- historical ESP firmware 4.0.0, independent compatibility/failover tests,
  exact-version gating with a visible frontend error, and a warning-free compile
  using the pinned Arduino toolchain. The focused 2026-07-19 4.0 compile used
  1,036,431 bytes of flash and 63,180 bytes of global RAM, leaving 264,500 bytes
  for local variables; and
- deterministic synthetic legacy-import coverage plus SQLite integrity, backup,
  verification, and restore evidence. The ignored operator-local production
  snapshot remains an external deployment input.

This is not a claim that the physical ESP32 fleet has been flashed or that the
production Raspberry Pi has been deployed. Those are external acceptance
actions listed after the matrix, not missing repository implementation.

## Retained features

|   # | Retained feature                                         | Legacy source / new owner                                                                      | Implemented behavior and passing repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Repository status / external boundary                                                                                                                            |
| --: | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Home and navigation                                      | `.old/app.py:index`, `.old/templates/index.html`; React `App`                                  | The 11 migrated areas are seeded as persistent records, and the compact overview can create, rename, and safely delete empty areas. Routes and type keys remain stable across renames; populated deletion is rejected. Area mutations retain reconstructable before/after audit data. Overview/maintenance navigation, useful 404 recovery, same-origin static serving, cache/CSP behavior, SPA fallback, component coverage, and production-built route/responsive/accessibility tests remain in place.                                                                                                                                                                                                                                        | **Implemented.** Pi deployment remains external.                                                                                                                 |
|   2 | Control pages for every device type                      | `.old/app.py:control`, `lightpumps.html`; `ControlAreaPage`                                    | `lights`, `pumps`, `testlights`, `bad`, `loft`, `biljard`, `frag`, and `qt1`-`qt4` project typed snapshot state through one reusable page. Component tests render every slug and exercise the workflows; production-built browser tests cover all direct routes/reloads and representative responsive, accessibility, online, stale, offline, fault, and recovery states against the real test stack.                                                                                                                                                                                                                                                                                                                                           | **Implemented.**                                                                                                                                                 |
|   3 | UTC schedule storage, local-time graph and interpolation | Legacy JS/Python and firmware evaluator; `packages/domain`, independent fake, `ScheduleEditor` | Canonical and firmware-compatibility evaluators cover rising/flat/falling segments, every UTC minute, wrap, malformed graphs, zero-duration semantics, firmware float behavior, half-even host rounding, throttle/gain, and editor reducer validation. Schedules remain canonical UTC in storage and on the wire; the SVG graph and exact-time forms project them through the browser's current local offset, so the visible graph shifts across DST without rewriting saved points. Production-built keyboard CRUD, persistence/reload, responsive, and axe coverage exercises the editor without relying on pointer-only interaction.                                                                                                         | **Implemented.**                                                                                                                                                 |
|   4 | Channel and schedule-point editing                       | Legacy graph/upload handlers; configuration repository/routes and React editor                 | Revision-checked atomic create/rename/delete and schedule replacement exist. Channel creation provisions a valid owned UTC schedule; deletion is transactional and checks mappings/override history. Reducer/component coverage includes point add/edit/remove/discard, validation, dirty state, and conflicts. Playwright proves channel/point creation, schedule save, rename, conflict rejection, deletion, settled revisions, and database-backed persistence across reload.                                                                                                                                                                                                                                                                | **Implemented.**                                                                                                                                                 |
|   5 | Per-type throttles                                       | Legacy upload/compiler; normalized throttle, compiler, reconciliation, UI                      | Typed mutation API/UI, 0-100 constraints, half-even evaluation, affected-device projection, and schedule-trigger routing exist. Legacy 100% fallback is import provenance, never silent repair. Browser evidence saves and reloads a throttle through the production database; reconciliation unit tests plus the composed real-broker/runtime test prove the resulting artifact and output delivery path.                                                                                                                                                                                                                                                                                                                                      | **Implemented.**                                                                                                                                                 |
|   6 | Temporary/manual overrides                               | Legacy slider/manager and firmware `s`; override service/repository/routes/runtime/UI          | Server-authoritative start, extend, cancel, expire, restart initialization, reconcile, durable operations/targets, scheduler overlay, unscheduled outputs, exact 119999/120000-ms behavior, rollover safety, and outcome-unknown/no-retry behavior are covered. Controller writes renew a 120-second firmware overwrite lease, so local schedules resume only after Pi silence. The browser gets active state from a real fake-ESP response; broker/runtime tests cover refresh, controller stop, firmware failover, and controller/database restart recovery.                                                                                                                                                                                  | **Implemented.** Firmware 5.0.6 must still be flashed onto the production ESP32s.                                                                                |
|   7 | Device/channel/pin mappings                              | Legacy channel configuration/compiler; mapping profile API/UI                                  | Normalized profiles/mappings, explicit per-device profile selection, reported hardware profiles, duplicate pin/target validation, hardware-specific PWM allowlists, capacity validation, and UI conflict handling exist. Device names no longer select profiles. GPIO12 remains available for proven production wiring but shows its flash-voltage strapping warning whenever an assigned profile uses it. Browser evidence edits gain/mapping state and proves reload persistence; unit projection and the composed pinned-broker runtime prove the mapped schedule reaches the intended device/pin.                                                                                                                                           | **Implemented.**                                                                                                                                                 |
|   8 | ESP discovery and registry                               | Legacy `ESP32Manager`; device registry/runtime plus fake fleet                                 | Persistent announcements, desired/reported separation, online/stale/offline transitions, subscribe-before-discover, duplicate/malformed handling, restartable fake persistence, and device-health alert evaluation exist. Pinned-Mosquitto tests cover multiple actors, duplicate/delayed/malformed announcements, actor reconnect/restart, controller restart, broker restart, rediscovery, and namespace capture. Firmware 5.0.0+ remains compatible while older firmware is visible as `firmware_unsupported`.                                                                                                                                                                                                                               | **Implemented.** Physical-device discovery is an external post-flash/deployment check.                                                                           |
|   9 | ESP name/frequency/resolution editing                    | Legacy `editesp`, firmware `e`; operation service/API/UI                                       | Strict command builders, desired-state mutation, durable operation status, exact response matching, bounds, and pending/failure/unknown UI exist. Frequency/resolution pairs enforce `frequencyHz * 2^resolutionBits <= 80,000,000`. Resolution reattachment rescales scheduled/current-overwrite caches and physical output. Historical real-broker/browser evidence covers authoritative configuration and fake persistence.                                                                                                                                                                                                                                                                                                                  | **Implemented.** Physical EEPROM/LED validation remains external.                                                                                                |
|  10 | Schedule compilation, serialization, `syncTime`, DJB2    | Legacy compiler/manager and firmware schedule handler; domain/protocol/artifact repository     | Deterministic compact payload/hash, 4095/4096 boundary, persisted desired artifact, reported-hash no-op, 5.0.0+ compatibility gate, mismatch/unknown outcomes, coalescing, restart, and independent fake SPIFFS/hash/evaluation tests exist. Compiled fallback schedules apply both the area multiplier and mapping-profile output multiplier, matching Pi-driven output after failover. Real-broker tests carry schedules in one MQTT publication, verify `schedule_ok`, hash announcement, evaluation, persistence/restart, and the separate `sync` command.                                                                                                                                                                                  | **Implemented.**                                                                                                                                                 |
|  11 | Schedule update triggers                                 | Legacy upload/channel/device callbacks; state invalidations and reconciliation service         | Committed channel, schedule, throttle, profile, mapping, and device changes project deterministic affected-device reconciliation. Tests cover every trigger, hash no-op, per-device coalescing, mismatch, device-local failure, and supersession. Production-browser mutations exercise the composed invalidation path, while broker capture verifies canonical serialized work, per-device ordering, and healthy-device progress while another device is delayed.                                                                                                                                                                                                                                                                              | **Implemented.**                                                                                                                                                 |
|  12 | Five-second host refresh                                 | Legacy manager loop and firmware `s`; output scheduler                                         | Injected monotonic/UTC clock, anchored five-second cadence, no catch-up burst, every-output evaluation, normalized 0-255 wire duty, throttle/gain, manual overlay, stop drain, diagnostics, and device-local uncertainty are unit-tested. Each ESP has at most one running refresh and one latest-only pending routine batch; a newer tick replaces only pending work. Firmware scales normalized duty across configured 1-16-bit output.                                                                                                                                                                                                                                                                                                       | **Implemented.** Pi timing/load observation remains an external deployment check.                                                                                |
|  13 | 120-second override/failover                             | Firmware 5.0.6, fake ESP, and override runtime                                                 | Firmware 5.0.6 retains rollover-safe overwrite expiry and cache invalidation after expiry, PWM reattachment, and schedule replacement, including a zero target. Controller-owned writes renew the lease; local schedules resume after Pi silence. Resolution reattachment rescales scheduled/current-overwrite caches and physical duty. If Pi and NTP are unavailable after reboot, valid persisted time intentionally permits local scheduling. Minimum-version gating blocks pre-5.0 firmware.                                                                                                                                                                                                                                               | **Implemented in the repository.** Flashing and observing every deployed ESP32 remains external.                                                                 |
|  14 | Time synchronization                                     | Legacy daily 05:00 loop and firmware `sync`; time-sync coordinator                             | Announcement-triggered and persisted once-per-day 05:00 UTC flows, DST independence, restart guard, exact distinct `sync` command, best-effort per-device dispatch, and stop drain are unit-tested. One device's timeout does not block healthy lanes. Firmware checkpoints the first fresh time immediately, coalesces later EEPROM writes, and trusts a valid persisted estimate when both Pi and NTP are unavailable after reboot.                                                                                                                                                                                                                                                                                                           | **Implemented.** Physical clock observation remains external.                                                                                                    |
|  15 | MQTT serialization and response correlation              | Legacy manager and firmware callback; protocol/transport/fake                                  | MQTT 3.1.1 options, test-topic guards, globally unique request IDs, batch-local indexes, max-three-per-target batching, an explicit 5,120-byte command ceiling, bounded priority-aware per-device lanes, and no blind retry exist. One operation may await a response per ESP and up to sixteen device lanes run by default. Each command batch is one publication; the short publication mutex is released before response waiting. Interactive work precedes queued background work. Timeouts affect only one device; attributable malformed responses quarantine that device, while valid `E:` replies remain device-reported failures. Firmware 5.0.6 echoes request IDs and reads optional MQTT credentials from its ignored local header. | **Implemented.** ESP MQTT is plaintext; production needs an authenticated listener restricted to the trusted LAN, or a future physically validated TLS firmware. |
|  16 | Logs UI, filtering, pagination, export                   | Legacy log helpers/pages; `events.db`, log service/routes, `LogsPage`                          | Stable `(occurred_at_ms,id)` cursor queries, typed filters, payload validation/hash/redaction, bounded GET-only NDJSON/CSV export, CSV formula policy, URL-backed UI filters, pagination/detail/export, and empty/error tests exist. Implicit HEAD is disabled. Archive creation is monotonic under concurrent creators. Backup freshness verifies the exact canonical artifact instead of trusting an audit row; focused 2026-07-19 evidence passed 21/21 tests across four files.                                                                                                                                                                                                                                                             | **Implemented.** The separate archive-directory offsite lifecycle remains an external deployment action.                                                         |
|  17 | Failure, timeout, stale and pending UI states            | Legacy control/log pages; snapshot/SSE coordinator and status components                       | Snapshot-before-stream, replay coalescing, duplicate/gap/resync handling, heartbeat staleness, revision conflict, operation states, offline/stale text, log errors, alert delivery failures, acknowledgement conflict, and every override terminal state have unit/component coverage. Retry-free Playwright exercises controller restart/replay, browser network loss/reconnect, fake persistence, broker restart, dropped responses/outcome unknown, offline alert acknowledgement/recovery, axe, and console auditing.                                                                                                                                                                                                                       | **Implemented.**                                                                                                                                                 |

## Unknown-outcome reconciliation parity

- An ambiguous publication is persisted as `outcome_unknown` and is never
  retried. Reconciliation preserves that status and adds a durable timestamp; it
  does not claim that the command succeeded or failed.
- Startup recovery converts an interrupted in-flight operation to
  `outcome_unknown` for its device. It does not install a global safety latch.
  A timed-out device is marked offline and enters a bounded cooldown while
  healthy device lanes continue.
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
  outcomes available after recent-history truncation or mapping changes. The
  bounded page reports when more rows remain and reveals them as earlier
  outcomes are reconciled.

## ESP/MQTT observable contract

Cross-cutting API contracts cap identifiers and Fastify route parameters at 128
characters. `/api/events` and `/api/logs/export` are GET-only. Automatic alert-
rule seeding and delivery transitions (`attempting`, `delivered`, `failed`, and
`outcome_unknown`) use global revision/outbox events with precise invalidations,
but do not advance the operator concurrency floor.

The independent fake does not import controller parsing, framing, hashing,
compilation, expected-response, or wire-parsing behavior. The integration suites
exercise the controller and independent actors through digest-pinned
`eclipse-mosquitto:2.0.22-openssl`; the harness captures both
`test/aquarium/#` and `aquarium/#` and rejects any publication outside the test
namespace.

| Input/constraint        | Firmware behavior retained or deliberately replaced                                                                                  | Passing independent/unit evidence                                                                     | Passing pinned-broker evidence                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT transport          | MQTT 3.1.1, QoS 0, non-retained                                                                                                      | Controller/fake options and lifecycle tests; configuration rejects unsafe development/test brokers    | Real connections, subscriptions, QoS 0/non-retained publications, reconnect lifecycle, and broker restart pass against the pinned image         |
| Topics                  | Tests use `test/aquarium/{command,announce,response}`; production strings require every safety interlock                             | Exact topic builder and runtime guards                                                                | Capture subscribes to test and production namespaces on every test; teardown proves zero `aquarium/*` traffic                                   |
| `discover`              | Bare payload; every ESP announces                                                                                                    | Subscribe-before-discover and announcement state-machine tests                                        | Multiple actors, duplicates, malformed/delayed announcements, reconnect, actor/controller restart, and broker restart all rediscover correctly  |
| `s pin value overwrite` | Normalized 0-255 duty scaled to configured 1-16-bit output, exact response, refreshed overwrite, and rollover-safe 120-second expiry | Bounds, scaling, extension, scheduled/unscheduled pin, boundary, rollover, and cache tests            | Broker evidence covers refresh, device-local timeout, no retry, controller death, expiry, and restart recovery                                  |
| `p`                     | Exact response `o`                                                                                                                   | Exact, other-target, and batch-index tests                                                            | Success, delayed, duplicate, malformed, timeout, interrupted broker, mismatch/correlation, and post-reconciliation pings pass                   |
| `e name freq res`       | Persist actual values; require `frequencyHz * 2^resolutionBits <= 80,000,000`; reattach PWM and rescale caches/physical output       | Bounds, joint LEDC constraint, exact response, EEPROM restart, and reattachment scaling tests         | Historical broker evidence covers configuration response, reported announcement, fake persistence/restart, and browser-authoritative operation  |
| `sc JSON`               | Validate/store, attach channels, invalidate cached outputs, and return `schedule_ok`                                                 | Golden payload/hash, capacity, restart, evaluation, and zero-target replacement tests                 | Single-publication UTF-8 transport, `schedule_ok`, hash announcement, independent evaluation, actor persistence, and 4095-byte success pass     |
| `sync epoch`            | Persist and echo Unix epoch seconds in the inclusive range 1-2,147,483,647                                                           | Exact lower/upper-bound validation, response, persisted fake clock, UTC-minute, and coordinator tests | Historical broker evidence covers exact response, announcement sync, persisted fake time, and controller/database/actor restart                 |
| `r pin`                 | Return `r pin value`; metadata request has a distinct error                                                                          | Analog/metadata golden fake tests                                                                     | Typed analog read is correlated through a multi-device, batch-local-index broker exchange                                                       |
| bare `clear`            | Ignored; remote broadcast EEPROM erasure was removed as unsafe                                                                       | Independent fake and firmware-source safety tests                                                     | No actor replies or changes persisted identity                                                                                                  |
| targeted `clear`        | Rejected by deployed and replacement firmware                                                                                        | Negative golden fixture                                                                               | Targeted publication returns the expected invalid-command response                                                                              |
| unknown/other target    | Targeted unknown returns error; other target emits no entry but advances the original index                                          | Invalid/no-response/original-index fake fixtures                                                      | Multi-actor batch capture and response frames prove original command indexes and controller correlation across actors                           |
| batching                | Semicolon payload, max three per physical target, local response indexes                                                             | Pure controller correlation and independent multi-device tests                                        | Canonical ID/name commands, two actors, per-target flushing, and exact batch-local response frames pass                                         |
| message size            | One MQTT publication up to 5,120 UTF-8 command bytes; firmware packet buffer is 6,144 bytes                                          | Protocol 5,120/5,121 boundary tests and firmware compile                                              | Physical ESP accepts 5,120 bytes in one message and rejects 5,121; 4095/4096 schedule limits pass                                               |
| wire concurrency        | One FIFO lane and one response-waiting operation per ESP; sixteen device lanes by default                                            | Priority, per-device ordering, concurrency, request-correlation, and dispatcher tests                 | A healthy ESP completes while another is delayed; complete publications stay ordered and late/duplicate responses cannot settle a newer request |
| timeout                 | Device-local outcome unknown, offline/cooldown state, and no blind actuator retry                                                    | Transport/operation/override/scheduler device-local failure tests                                     | A dropped response affects only its ESP lane; healthy devices continue, while attributable invalid responses quarantine the responding device   |

## Known legacy discrepancies and migration hazards

1. The legacy interleaved-batching test expects three batches, while the running
   manager resets all per-device counts after a flush and produces two. Running
   code wins.
2. Legacy firmware accepted bare `clear` as an unauthenticated fleet-wide
   EEPROM erase. Firmware 5.0.6 deliberately removes that behavior; targeted
   `clear` remains an invalid command and bare `clear` is ignored.
3. A schedule's `syncTime` is stored but does not set the firmware clock; only
   the separate `sync` command does.
4. `currentSchedule` is a 4096-byte C buffer. Reserving the terminating NUL
   makes 4095 bytes the safe serialized maximum.
5. **Introduced in firmware 4.0.0 and retained in 4.1.0:** host PWM values
   remain a normalized 0-255 on the wire and firmware scales them to the
   configured resolution. Resolution reattachment also rescales cached physical
   duty, including active overrides.
6. Ordered case-sensitive source keys, an empty mapping key, case-distinct channel
   names, hidden `mainLys70` gain, and missing throttles are import findings,
   never silent repairs.
7. Legacy firmware versions `0`, `1`, and `2w` did not receive schedules. The
   replacement supports firmware 5.0.0 and newer; older reported versions remain
   visible as `firmware_unsupported` and are excluded from reconciliation and
   actuation.
8. **Introduced in firmware 4.0.0 and retained in 4.1.0:** schedule-output
   caching previously left a stale physical output after override expiry, PWM
   reattachment, or a zero-target schedule replacement. The firmware now
   invalidates the affected cached channel values and synchronizes remembered
   output state, with independent regression tests for all three paths.
9. **Introduced in firmware 4.0.0 and retained in 4.1.0:** the previous absolute
   32-bit `millis()` expiry comparison could expire an override immediately near
   rollover. Expiry now uses unsigned elapsed-time subtraction, with rollover
   and exact-boundary regression tests.
10. **Added in firmware 4.1.0:** request IDs allow correlated per-device
    response waits; valid EEPROM time is trusted when Pi and NTP are unavailable;
    controller writes own the overwrite lease; and wear-limited diagnostics
    retain the latest actuator/schedule failure for later MQTT reporting.

## External acceptance boundary

Repository parity does not perform or claim these environment-specific actions:

- flash firmware 5.0.6 onto each physical ESP32, confirm each announcement is
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

A physical ESP older than 5.0.0 remains visible in the frontend with a
`firmware_unsupported` error, but the controller does not send it schedules or
actuator operations. Supported older releases remain operational while showing
an available update.

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
