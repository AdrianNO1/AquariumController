Goal

Complete the AquariumController rewrite so it is ready to replace the current
aquarium controller after the remaining external deployment tasks are performed.

When this goal is complete, the only remaining work should be:

1. Run the already-implemented migration/import tooling against the real
   production data from the Pi.
2. Configure GitHub repository settings, secrets, environments, and runners.
3. Configure the Raspberry Pi and production MQTT/database settings.
4. Deploy the already-built and locally verified production artifacts.
5. Configure the selected real alert destination.

Do not access or affect the current aquarium while pursuing this goal.

Source of truth and parity rules

Before implementing further features, create and maintain a feature-parity
matrix that maps:

- Each retained legacy feature.
- Its legacy source file/function/route.
- Its new implementation.
- Its unit, integration, and browser tests.
- Any intentional behavioral deviation and its rationale.

For ESP-observable behavior, `.old/slaveCode/ESP32Code/ESP32Code.ino` is the
primary source of truth.

For host/controller behavior, use the currently executed behavior in:

- `.old/app.py`
- `.old/manager.py`
- `.old/ESP32Manager.py`
- `.old/schedulemaker.py`
- `.old/custom_syntax.py`
- `.old/templates/`
- `.old/static/`

Legacy tests are evidence but not authoritative when they disagree with the
actual running code.

Preserve externally observable behavior required by deployed firmware. Do not
preserve unsafe implementation techniques, concurrency bugs, silent failures,
raw JSON persistence, unsafe eval, or unauthenticated operating-system control
routes.

Required retained features

Implement full working parity for these features:

1. The current home/navigation experience.
2. The schedule/control pages for all currently supported device types.
3. The 24-hour UTC schedule graph and piecewise-linear interpolation.
4. Channel creation/editing and schedule point manipulation.
5. Per-type throttles.
6. Temporary/manual channel overrides.
7. Device-to-channel/pin mappings and validation.
8. ESP discovery, device registry, status, last-seen time, and errors.
9. ESP name, PWM frequency, and resolution editing.
10. Schedule compilation, compact serialization, syncTime behavior, and exact
    unsigned 32-bit DJB2 schedule hashing.
11. Schedule update when schedule, throttle, mapping, or device configuration
    changes.
12. Five-second host output refresh.
13. The 120-second firmware override/failover contract.
14. Time synchronization on announce and daily synchronization.
15. MQTT command serialization and response correlation.
16. Logs UI with filtering, pagination, and export.
17. All currently meaningful failure, timeout, stale, and pending UI states.

Preserve these legacy MQTT details exactly:

- MQTT 3.1.1 behavior.
- QoS 0 and non-retained command behavior.
- Test topics:
  - `test/aquarium/command`
  - `test/aquarium/announce`
  - `test/aquarium/response`
- Discovery payload `discover`.
- Commands `s`, `p`, `e`, `sc`, `sync`, `clear`, and any other command currently
  observable from the firmware.
- Semicolon-delimited command batches.
- Maximum three commands per target device in one batch.
- Response indexes scoped to the published batch.
- Chunking triggered above 256 UTF-8 bytes.
- 200-byte chunk data limit.
- `chunk:index:total:isLast:data` framing.
- Maximum 50 chunks.
- Ten-second chunk inactivity timeout.
- 4096-byte active schedule JSON limit.
- One global legacy wire operation in flight at a time.
- Timeout means outcome unknown and must not cause blind actuator retries.

New required features

Implement these improvements from the accepted architecture:

1. Strict TypeScript throughout.
2. Zod validation at every untrusted boundary:
   HTTP, SSE, MQTT, configuration, imports, and persisted JSON.
3. SQLite/Kysely persistence with migrations:
   - `state.db` for authoritative relational state.
   - `events.db` for structured interactions and logs.
4. A transactional state revision and outbox in `state.db`.
5. Snapshot plus SSE synchronization with:
   - Monotonic state revisions.
   - Replay after a revision.
   - Last-Event-ID handling.
   - Heartbeats and stale detection.
   - Gap detection.
   - resync-required behavior.
   - Bounded slow-client handling.
6. Structured logging of MQTT, controller, frontend mutations, scheduler,
   device, alert, and error interactions.
7. Retention classes, byte budgets, disk alerts, aggregation, and tested
   Zstandard archive generation.
8. An alert system with a notifier interface and at least one
   production-capable adapter. Test it only against a local fake endpoint.
9. Safe database backup, integrity-check, restore, and retention tooling.
10. A production Dockerfile/Compose configuration and health checks that are
    fully tested locally, even though the Pi itself is not configured.
11. All web assets bundled locally; the application must function without WAN
    access or CDN dependencies.
12. Plain HTTP for the trusted LAN. Do not recreate application-managed
    certificates.

Database requirements

Core state must be normalized and constrained, not stored as one large JSON
document.

Use relational tables for devices, outputs, pin mappings, channels, schedules,
schedule points, throttles, overrides, timers, sensor/switch configuration,
pump calibration, DSL program revisions, alert rules, active alerts, schema
migrations, and state revisions.

JSON columns are allowed only for genuinely variable documents such as raw MQTT
payloads, typed event details, versioned rule-specific configuration, DSL
diagnostics, firmware-specific metadata, and import reports.

Every persisted JSON document must contain or be associated with a schema
version and must be Zod-validated when written and read. Frequently queried
fields must be real indexed columns.

Migration readiness

Do not migrate or request production data during this goal.

Implement and test the complete migration tool so the remaining production
migration is only an operational execution step. It must provide:

- Dry-run mode.
- Validation report.
- Atomic import.
- Idempotence or explicit duplicate protection.
- Backup/rollback instructions.
- Case-sensitive name handling.
- Reporting for empty keys, duplicate mappings, overlapping prefixes,
  malformed schedules, gaps, and collisions.
- No silent repair or data loss.
- Tests using `.old/data` only as non-production fixtures.

Fake ESP requirements

Build independent fake ESP32 actors that mimic the MQTT-observable behavior of
`.old/slaveCode/ESP32Code/ESP32Code.ino`.

They do not need physical pins, Wi-Fi, NTP hardware, EEPROM, or SPIFFS, but must
emulate their observable effects:

- Logical pin/PWM state.
- Configurable analog input values if needed.
- Announcement and discovery.
- Device name/frequency/resolution changes.
- Logical EEPROM/SPIFFS persistence across fake-device restarts.
- Schedule persistence, evaluation, and hashing.
- Time synchronization.
- Temporary override expiration.
- Chunk reassembly and timeout.
- Response indexes and payload formatting.
- Reconnects, delays, dropped responses, malformed responses, and duplicates.
- Multiple simultaneous fake devices.

The fake ESP implementation must not import the controller’s MQTT command
parser, chunk reassembler, schedule compiler, hash implementation, or expected
response implementation. Otherwise both sides could share the same defect and
the integration tests would be meaningless.

Neutral schemas may be shared, but protocol behavior must be implemented
independently and cross-checked using golden fixtures derived from the firmware.

Safety constraints

These constraints are absolute:

1. Do not connect to the Raspberry Pi.
2. Do not SSH, ping, browse, scan, or otherwise contact LAN devices.
3. Do not connect to any IP address or hostname copied from legacy files.
4. Do not connect to the hardcoded legacy broker at `192.168.1.73`.
5. Network connections used by the running application/tests must be limited to:
   - `localhost` / `127.0.0.1`
   - Test-created Docker networks
   - Necessary package/documentation downloads
6. During this goal, no running process may publish or subscribe to
   `aquarium/*`.
7. Production topic strings may exist in source code and pure unit tests, but
   may not be used by a network client.
8. All MQTT integration and E2E tests must use only `test/aquarium/*` on a local
   test broker.
9. Add runtime safety guards that make accidental non-test MQTT use fail loudly
   during development and tests.
10. Production MQTT must require explicit production mode, an explicit broker
    address, and explicit configuration. It must never be the default.
11. Do not read, copy, download, infer, or modify production data or credentials.
12. Treat `.old/data` only as imperfect development fixtures.
13. Treat `.old/**` as read-only.
14. Do not modify the ESP firmware without separate explicit approval from the
    user.
15. Do not flash any device.
16. Do not expose or recreate legacy kill, shutdown, reboot, git-pull, or
    self-update HTTP endpoints.
17. Do not push Git commits or create pull requests.
18. Do not alter GitHub settings, secrets, environments, or runners.
19. Do not deploy to or configure the Pi.
20. Do not weaken these protections to make a test pass.

Testing requirements

Unit tests may use injected clocks, repositories, and transport fakes.

MQTT integration tests must use a real, pinned Mosquitto broker and independent
MQTT.js fake ESP processes/clients. Mocking `publish`, mocking the broker, or
asserting only that a mocked function was called does not count as integration
testing.

End-to-end tests must exercise the production-built React/Fastify application,
real SQLite databases, real Mosquitto, and fake ESP actors.

Tests must cover at minimum:

- Every retained feature in the parity matrix.
- MQTT discovery and multiple devices.
- Every command and response type.
- Boundary sizes 256/257 bytes and 200-byte chunks.
- Maximum chunk count and schedule size.
- Partial, malformed, duplicated, delayed, and out-of-order data.
- Reconnects and broker restarts.
- Global wire serialization.
- Batch index correlation.
- Timeout and outcome-unknown behavior without blind retry.
- Schedule hash and deterministic serialization.
- UTC interpolation boundaries and wraparound.
- Five-second refresh and 120-second failover using fake time.
- Persistence and recovery after controller/database/device restart.
- Empty database migration and upgrade from the previous schema.
- Legacy fixture import and validation failures.
- Snapshot-to-SSE race, replay, duplicate events, gaps, reconnect, stale
  watchdog, and forced resync.
- Logging, redaction, retention, archive compression, restoration, and byte
  quotas.
- Alert creation, deduplication, recovery, and local notifier delivery.
- Browser pending/success/failure/timeout/unknown states.
- Deep links, invalid routes, responsive layout, keyboard use, and accessibility.
- No browser console errors, unhandled rejections, or external CDN requests.

Do not use skipped tests, `.only`, commented-out assertions, catch-all success,
or snapshots without meaningful assertions. Do not delete or weaken a valid test
merely to get a green result.

Critical integration suites must pass repeatedly without flaky retries.

Explicitly excluded/deferred

Unless the user separately expands the goal, do not implement:

- The WIP sketch5 dashboard as a replacement UI.
- DSL dosing and pump calibration workflows described only in old_todo.txt.
- New status/contact switches from sketch5.
- Feed/flow-kill/physical-button countdown workflows from sketch5.
- Direct Raspberry Pi sensor inputs.
- Dormant USB Arduino support.
- Remote access, Tailscale, or public HTTPS.
- Actual production-data migration.
- Pi or GitHub configuration.

Architecture must leave clear extension points for future DSL, dosing, pumps,
switches, sensors, and physical-button support. Do not port unsafe Python eval.

Frontend expectations

The frontend needs functional and interaction parity, not pixel-perfect parity.

Preserve the recognizable page structure, routes, schedule editor, controller
cards, mappings, logs, and operational workflow. A restrained visual refresh,
responsive improvements, and accessibility improvements are welcome.

No in-scope route may remain a placeholder. Pending, error, stale, offline, and
outcome-unknown states must be visible and must not rely on color alone.

Autonomous work and commits

Work autonomously and make reasonable implementation decisions consistent with
this goal and `docs/architecture.md`. Record significant decisions in the
architecture documentation.

Ask the user only when new authority is required, a safety boundary would need
to change, or two choices would materially change the production behavior.

Make Git commits after coherent milestones only when all relevant checks pass.
Use clear commit messages. Do not commit secrets, generated databases, runtime
logs, coverage output, or unrelated user changes. Never push.

Definition of done

Do not mark this goal complete until all of the following are true:

1. The parity matrix contains no unimplemented retained feature.
2. No in-scope UI route is a placeholder.
3. No in-scope TODO is deferred without being listed in Explicitly
   excluded/deferred.
4. A clean checkout can run `npm ci` and one documented full verification
   command successfully.
5. Formatting, linting, strict type-checking, unit tests, integration tests,
   browser tests, and production builds all pass.
6. The critical integration suite passes three consecutive times without
   retries.
7. One documented command starts the complete local stack:
   React frontend, controller, SQLite databases, Mosquitto, and multiple fake
   ESP32s.
8. The local stack uses only test MQTT topics.
9. State survives restart and the UI resynchronizes without manual reload.
10. Logs, retention, compression, backups, restoration, alerts, and storage
    limits are demonstrated locally.
11. Production Docker/Compose artifacts are built and locally smoke-tested for
    ARM64 compatibility.
12. The migration command is complete and tested, although it has not touched
    production data.
13. Operational documentation explains configuration, start/stop, backup,
    restore, migration, diagnostics, failure modes, and future Pi deployment.
14. A final readiness report lists:
    - Retained features and their tests.
    - Intentional deviations from legacy behavior.
    - Exact commands executed.
    - Test/build results.
    - Local service URLs.
    - Local fake devices.
    - Database locations.
    - Remaining external deployment steps.
15. The complete local test stack is left running and healthy at completion,
    unless the user asks otherwise.



The user’s usage limit may be exhausted during this goal. This will not directly stop you from working further, but it will prevent automated approval of elevated commands. 

At the beginning of the goal:
1. Inventory all likely dependencies, downloads, operating-system prerequisites,
   and commands requiring elevated/network approval.
2. Front-load and batch necessary approval requests before beginning long
   implementation work.
3. Request narrowly scoped reusable approvals where appropriate.
4. Install or verify major prerequisites early, including the real Mosquitto
   broker, native SQLite dependencies, Playwright browser binaries, compression
   tooling, and any required build tooling.