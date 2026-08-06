# Target architecture

Status: implemented architecture, updated 2026-08-02. The protected evidence
for source `886ed05be89a1abed8e076d91ce2802f5d5668dd` and its published digest is a
historical pre-4.1 baseline recorded in the
[readiness report](readiness-report.md). The current firmware 6.0.0 and
structured-protocol branch requires its own protected CI run, merge, and immutable
image selection. Physical ESP flashing, Raspberry Pi deployment,
production-data migration, and production configuration remain operator-run
release steps.

## Decision

AquariumController is a TypeScript modular monolith. One long-lived controller
process owns HTTP, server-sent events, MQTT, scheduling, persistence, alerts,
and hardware-facing adapters. The browser is a React single-page application.
Mosquitto remains a separate broker process.

This is intentionally neither a Next.js application nor a set of microservices.
The dashboard is local-network software with no SEO or server-rendering need,
while the MQTT queue, five-second refresh, daily jobs, state revision, and
shutdown sequence need one predictable owner. The controller must not be
horizontally scaled: per-device command queues, schedules, and state revisions
need one predictable owner. Firmware 6.0.0 request identifiers allow bounded
concurrency inside that owner without making multiple controller processes
safe.

## Technology baseline

| Concern             | Choice                                                        | Current status                                                             |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Runtime             | Node.js 24 LTS, npm 11                                        | Locked in the workspace and CI                                             |
| Language            | TypeScript 5.9, strict mode                                   | Shared by application, UI, contracts, and tests                            |
| UI                  | React 19, Vite 8, React Router 8, TanStack Query 5            | Control, logs, alerts, snapshot, and SSE component code exists             |
| Controller/API      | Fastify 5 with Pino                                           | Composed as the server process                                             |
| Boundary validation | Zod 4                                                         | Used for HTTP, SSE, MQTT-adjacent state, and persisted document boundaries |
| State persistence   | SQLite WAL through Kysely and `better-sqlite3`                | Normalized `STRICT` schema and additive migrations exist                   |
| Event persistence   | Separate SQLite WAL database                                  | Structured logs, replay, retention, aggregate, and archive metadata exist  |
| MQTT                | MQTT.js 5 using MQTT 3.1.1 against Mosquitto 2                | Unit plus pinned-Mosquitto restart/fault/namespace evidence passes         |
| Tests               | Vitest, Testing Library, fake ESP, Testcontainers, Playwright | Unit, integration, and retry-free production-browser lanes pass            |
| Deployment          | Docker Compose and multi-architecture image                   | Local amd64 Compose and emulated ARM64 startup validated                   |

SQLite is never exposed over the network. The HTTP API supplies typed read,
mutation, log-query, and export boundaries instead.

## Repository boundaries

```text
apps/
  controller/
    src/application/       alerts, configuration, registry, operations,
                           overrides, reconciliation, scheduling, snapshot
    src/infrastructure/    SQLite, import, MQTT, notifications, storage
    src/*.ts               Fastify routes, composition, server and storage CLI
  web/                     React SPA, typed API clients and state coordinator
packages/
  contracts/               shared strict Zod HTTP/SSE/log/override contracts
  domain/                  pure schedule evaluation, compilation and rounding
  esp-protocol/            deployed MQTT grammar, limits, serialization/hash
  fake-esp/                independent firmware-semantic test actors
```

Pure domain code receives explicit ports and does not import Fastify, MQTT.js,
SQLite, or Raspberry Pi APIs. Infrastructure remains in the controller app
until a boundary needs another real implementation.

## Controller runtime

The server currently composes both SQLite databases, state-outbox mirroring,
snapshot/configuration/log/alert repositories, daily retention, and—when
explicitly enabled—the MQTT runtime. The MQTT runtime owns:

- the persistent device registry, online/stale/offline transitions, and built-in
  not-online alert evaluation for enabled devices;
- bounded, priority-aware per-device command lanes and durable operation states;
- deterministic schedule artifact compilation and hash-based reconciliation;
- five-second output refresh with per-device latest-only coalescing and no
  catch-up burst;
- manual-override overlays and device-local unknown-outcome handling;
- announcement and persisted daily 05:00 UTC time synchronization; and
- metadata-only MQTT/scheduler interaction logging.

The implemented HTTP surface includes health, distinct liveness/readiness,
snapshot, SSE, configuration mutations, operation details, alert-rule
mutation/history/acknowledgement, manual-override commands, and bounded logs
query/export. When `AQUARIUM_WEB_ROOT` is set, the controller serves the
production-built SPA and its same-origin `/api` routes with a restrictive CSP,
immutable hashed assets, no-cache HTML, and a non-API SPA fallback. Local source
development can still use Vite. The React manual-override surface uses the typed
start/extend/cancel/reconcile API,
server-derived countdowns and explicit pending/active/unknown/failed/expired/
cancelled states without optimistic actuator success or retry.

All route identifiers are limited to 128 characters, matching Fastify's maximum
route-parameter length. `/api/events` and `/api/logs/export` accept GET only;
implicit Fastify HEAD routes are disabled for both streaming/export surfaces.
Firmware synchronization accepts signed 32-bit Unix epoch seconds from 1 through
2,147,483,647. Device configuration validates frequency and resolution both
individually and jointly: resolution is 1-16 bits and
`frequencyHz * 2^resolutionBits` may not exceed 80,000,000.

Alert notification delivery is optional and has no default destination.
`AQUARIUM_ALERT_WEBHOOK_URL` enables a durable one-attempt webhook dispatcher;
`AQUARIUM_ALERT_WEBHOOK_KEY` defaults to `primary`, and
`AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS` defaults to 10,000 ms and accepts 1-60,000
ms. Optional
`AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME` and
`AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE` must be supplied together. Any
supplementary setting without a URL fails configuration. Development/test URLs
must use loopback HTTP; production requires HTTPS. The runtime recovers an
interrupted attempt as `outcome_unknown`, never retries a terminal delivery,
starts before alert-producing runtimes, and drains after those producers stop
but before the databases close. With no URL, no destination, delivery intent,
dispatcher, or polling runtime is created.

Built-in alert rules are seeded automatically. Seeding and notification delivery
transitions to `attempting`, `delivered`, `failed`, or `outcome_unknown` commit a
global state revision/outbox event with precise invalidations for the owning
alert/rule state. These background commits do not advance the operator
concurrency floor. Recovery from an interrupted webhook attempt remains
`outcome_unknown`; the dispatcher never guesses that delivery failed safely
enough to retry.

## Configuration reference

Configuration is read from the process environment and validated before any
database or network runtime starts. Values shown as paths are resolved to
absolute paths. Production mode deliberately requires each persistent path
individually; setting only the shared data directory is not a production
substitute.

| Variable                                           | Default / requirement         | Validation and effect                                                                                                                                  |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AQUARIUM_RUNTIME_MODE`                            | `development`                 | `development`, `test`, or `production`. Production activates the explicit-path and network interlocks below.                                           |
| `AQUARIUM_HOST`                                    | `127.0.0.1`                   | Non-empty HTTP bind host.                                                                                                                              |
| `AQUARIUM_PORT`                                    | `3001`                        | Integer 1-65,535.                                                                                                                                      |
| `AQUARIUM_SSE_REPLAY_LIMIT`                        | `1000`                        | Integer 1-10,000; replay reads fetch at most this limit plus one row and require a fresh snapshot when the bounded window is exceeded.                 |
| `AQUARIUM_WEB_ROOT`                                | unset                         | Optional SPA build root, resolved to an absolute path. The production image sets `/app/apps/web/dist`; a missing configured root fails startup.        |
| `AQUARIUM_DATA_DIRECTORY`                          | `.data`                       | Base for non-production path defaults.                                                                                                                 |
| `AQUARIUM_STATE_DB_PATH`                           | `<data>/state.db`             | Must be set explicitly in production.                                                                                                                  |
| `AQUARIUM_EVENTS_DB_PATH`                          | `<data>/events.db`            | Must be set explicitly in production.                                                                                                                  |
| `AQUARIUM_ARCHIVE_DIRECTORY`                       | `<data>/archives`             | Must be set explicitly in production.                                                                                                                  |
| `AQUARIUM_BACKUP_DIRECTORY`                        | `<data>/backups`              | Must be set explicitly in production.                                                                                                                  |
| `AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS`           | `129600000` (36 hours)        | Integer 60,000-2,592,000,000 (30 days); a missing or older successful backup opens the critical backup-freshness alert.                                |
| `AQUARIUM_RETENTION_STALE_RUN_AFTER_MS`            | `21600000` (6 hours)          | Integer 60,000-604,800,000; running retention rows older than this are recovered as failed.                                                            |
| `AQUARIUM_STORAGE_HEALTH_INTERVAL_MS`              | `300000` (5 minutes)          | Integer 10,000-86,400,000.                                                                                                                             |
| `AQUARIUM_STORAGE_MINIMUM_FREE_BYTES`              | `1073741824` (1 GiB)          | Positive safe integer; opens the low-free-space rule below this value.                                                                                 |
| `AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES`    | `10737418240` (10 GiB)        | Positive safe integer; opens the projection rule above this value.                                                                                     |
| `AQUARIUM_ALERT_WEBHOOK_URL`                       | unset                         | Enables webhook intent and delivery. Development/test require loopback HTTP; production requires HTTPS; credentials, query, and fragment are rejected. |
| `AQUARIUM_ALERT_WEBHOOK_KEY`                       | `primary` when a URL is set   | Typed destination identifier; setting it without a URL is invalid.                                                                                     |
| `AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS`                | `10000` when a URL is set     | Integer 1-60,000; setting it without a URL is invalid.                                                                                                 |
| `AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME`          | unset                         | Optional non-reserved HTTP header name; must be paired with the value and a URL.                                                                       |
| `AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE`         | unset                         | Secret value; must be non-empty, single-line, paired with the name, and supplied only through operator-managed configuration.                          |
| `AQUARIUM_MQTT_ENABLED`                            | `false`                       | Exact string `true` or `false`. No broker client exists while false.                                                                                   |
| `AQUARIUM_MQTT_BROKER_URL`                         | required when MQTT is enabled | Absolute `mqtt://` or `mqtts://` URL. Development/test require a loopback host.                                                                        |
| `AQUARIUM_MQTT_USERNAME`                           | unset                         | Must be paired with `AQUARIUM_MQTT_PASSWORD`; both are required for production MQTT. Broker URL userinfo is rejected.                                  |
| `AQUARIUM_MQTT_PASSWORD`                           | unset                         | Must be paired with `AQUARIUM_MQTT_USERNAME`; supply it through operator-managed configuration, never Git.                                             |
| `AQUARIUM_MQTT_TOPIC_NAMESPACE`                    | required when MQTT is enabled | `test` or `production`. Development/test require `test`; production requires `production`.                                                             |
| `AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS`                | `5000`                        | Integer 100-60,000. Timeout produces an explicit unknown outcome, never a blind retry.                                                                 |
| `AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS`              | `60000`                       | Integer 1,000-3,600,000 and, when MQTT is enabled, shorter than the stale threshold.                                                                   |
| `AQUARIUM_PRODUCTION_MQTT_CONFIRMATION`            | unset                         | Production MQTT requires exact value `ENABLE_PRODUCTION_AQUARIUM_MQTT`; this is an operator interlock, not a secret.                                   |
| `NODE_ENV`                                         | unset                         | Production MQTT is prohibited when this is `test`, even if every other production interlock is supplied.                                               |
| `AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS` | `30000`                       | Integer 1,000-3,600,000 and shorter than the stale threshold.                                                                                          |
| `AQUARIUM_DEVICE_STALE_AFTER_MS`                   | `90000`                       | Integer 2,000-86,400,000; must be shorter than offline.                                                                                                |
| `AQUARIUM_DEVICE_OFFLINE_AFTER_MS`                 | `300000`                      | Integer 3,000-604,800,000.                                                                                                                             |
| `AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS`         | `5000`                        | Integer 500-60,000 and shorter than the stale threshold.                                                                                               |

No checked-in environment file is required or read by the application. Secret
values and real production destinations belong in an operator-managed
deployment environment, never a checked-in file.

## Legacy ESP compatibility boundary

These constraints are compatibility contracts, not patterns to spread through
the application:

- MQTT 3.1.1, QoS 0, non-retained messages.
- The ESP32 uses plaintext MQTT and supports either an explicit username/
  password pair or an intentionally anonymous listener. It does not support
  `mqtts://`. Production must therefore use an authenticated plaintext listener
  restricted to the trusted aquarium LAN unless a future TLS firmware is
  implemented and physically validated.
- Production protocol-v1 topics are
  `aquarium/v1/discovery/request` and
  `aquarium/v1/devices/<device-id>/{command,announce,response}`. Development
  and test clients use only the equivalent `test/aquarium/*` hierarchy.
- Strict JSON requests carry a protocol version, target device ID, request ID,
  and at most three typed commands. Responses echo those identities and the
  accepted values for each indexed result.
- Each command request is one MQTT publication of at most 5,120 UTF-8 bytes. The
  firmware's 6,144-byte PubSubClient buffer leaves room for MQTT framing and
  topic overhead without an application-level chunk protocol. The production
  broker and controller reject inbound packets/payloads above 8,192 bytes.
- The active firmware's 4096-byte C-string schedule buffer makes 4095 UTF-8
  bytes the conservative serialized-document limit.
- Compact serialization and the unsigned 32-bit DJB2 hash are deterministic;
  the hash excludes the changing `syncTime` field.
- Firmware `6.0.0` is the current release and the controller accepts only the
  6.x protocol family. Newer unknown major versions are observed but not
  commanded until compatibility is reviewed. Compatible legacy announcements
  remain visible but all older firmware is marked `firmware_unsupported` and
  excluded from actuator, configuration, schedule, and time-sync work.
  Firmware 5.x alone may receive one explicitly requested OTA command through
  its correlated legacy wire format; update-all never uses that bridge. No
  operational compatibility is promised for firmware below 6.

The transport maintains one FIFO lane per ESP, permits one response-waiting
operation per ESP, and runs at most sixteen device lanes concurrently by
default. Interactive configuration and override work is selected before queued
background schedule, refresh, and time-sync work. Responses are routed by
per-device topic and request ID, then checked against the expected device,
command kind, local command index, and echoed accepted values. Delayed,
misrouted, or out-of-order responses therefore cannot settle a newer operation.

Firmware updates use the same discovery registry and correlated MQTT command
lane. The controller sends an approved local HTTP URL, exact byte count, and
SHA-256; the ESP streams the image into its inactive OTA partition and reports
output/OTA state in announcements. `when_off` requests wait for every reported
pin to reach 0%. Update-all persists its mode so an outdated ESP announcing
later is enrolled. A new image is confirmed only after MQTT presence succeeds;
five minutes without confirmation or three probation boots select the previous
partition. ESP-reported OTA failures remain terminal until an operator retries.

The transport uses a short publication mutex only around each complete MQTT
publication; it is released before waiting for the ESP response. Response
waits for other devices can therefore overlap safely. The five-second output
scheduler also keeps at most
one pending refresh batch per device: a newer tick replaces queued routine PWM
work that has not started, while commands already attempted are never silently
rewritten.

A timeout still means that device's actuator outcome is unknown; request
correlation is not proof that an unacknowledged command did or did not run. The
controller never blindly retries that operation. It marks only the affected
enabled device offline, applies the device retry cooldown, and continues work
for other ESPs. Online, stale, and offline enabled devices remain bounded retry
candidates; `enabled=0` is the explicit operator exclusion. A correlated
malformed, empty, or otherwise invalid response is attributable to that device
and quarantines it as a protocol fault.

The five-second host refresh and 120-second firmware overwrite are safety
behavior. Firmware 6.0.0 uses rollover-safe elapsed-time expiry and invalidates
its scheduled-output cache after override expiry, PWM reattachment, and
schedule replacement. The command wire continues to carry normalized 0-255 duty
values. Firmware scales each value into the configured 1-16-bit LEDC range, and
a resolution reattachment rescales the scheduled/current-overwrite caches and
physical output so an unchanged normalized request cannot change intensity.
Frequency/resolution pairs obey the same joint 80 MHz LEDC bound enforced by the
controller. Firmware also updates its physical-output bookkeeping on every
scheduled write. Startup NTP is asynchronous and configured through the ignored
firmware header, so unavailable DNS/NTP cannot delay MQTT or manual control.
If neither NTP nor the controller is reachable after reboot, a valid persisted
EEPROM timestamp intentionally authorizes the local schedule from that
boundedly stale estimate. The first fresh Pi/NTP time checkpoint is persisted
immediately; subsequent time corrections are coalesced to at most one EEPROM
commit per hour, and failed commits retry no more than hourly.

Routine host refresh and manual PWM writes set `overwrite=true`. Each successful
write renews a 120-second controller lease during which the ESP does not apply
its own schedule to that pin; after Pi silence, local scheduling resumes using
the ESP's current or persisted time estimate. The schedule artifact already
contains the area multiplier and the selected mapping profile's output
multiplier, so failover does not change intensity. Schedule activation is
best-effort per pin. Attach/write/detach failures leave the affected pin safe,
do not stop healthy pins, and queue a wear-limited diagnostic announcement.
Diagnostic transitions are persisted in SPIFFS immediately for the first
transition and then at most hourly, with failed MQTT announcements retried no
more than once per minute.

Firmware identifies the deployed hardware as `nodemcu-esp32s-v1.1` / Ai-Thinker
NodeMCU-32S V1.1. Mapping profiles declare a hardware profile and devices select
one explicitly; names have no mapping semantics. Both controller and firmware
allow PWM only on GPIO 4, 12-14, 16-19, 21-23, 25-27, 32, and 33. GPIO12 is
retained for the proven production wiring, with an operator warning because it
controls flash voltage while the ESP32 resets. Analog reads are limited to
ADC1 pins 32-36 and 39 so Wi-Fi does not contend with ADC2.

During upgrade, persisted mappings outside that PWM allowlist are preserved
but disabled before snapshots are exposed. They cannot reach schedule or
manual-output command generation, and the profile editor requires the operator
to remove or remap them before the profile can be saved again.

SPIFFS first mounts without formatting. A failed mount permits at most two
persisted repair attempts: firmware explicitly formats and remounts, reports
that the saved schedule was lost, and lets the controller restore it. If the
repair-attempt counter cannot be persisted, firmware refuses to format. The
legacy unauthenticated bare MQTT `clear` command no longer erases fleet EEPROM.

Independent fake tests pin these actuator semantics. Firmware 6.0.0 passes the
pinned Arduino CLI 1.5.0, ESP32 core 3.0.7, ArduinoJson 7.4.3, and PubSubClient
2.8 build at 1,167,865 bytes of flash and 53,112 bytes of global RAM. Its
single-message transport was physically verified at the 5,120-byte limit over
the configured Mosquitto broker. Flashing every deployed ESP remains an
external release action.

## Unknown actuator outcomes and reconciliation

Firmware 6.0.0 response IDs prevent stale-response misattribution, but a failure
after QoS 0 publication still cannot prove whether the addressed ESP applied
the command. The controller therefore never retries that ambiguous operation
as though it were safely unsent. It persists the operation as terminal
`outcome_unknown`; reconciliation later records `reconciledAtMs` while leaving
that status unchanged. Reconciliation acknowledges independently verified
physical/device state, not retroactive success or failure.

Unknown outcomes are device-local. Startup recovery converts each interrupted
in-flight operation to `outcome_unknown` without installing a global safety
latch. A timed-out ESP becomes offline and enters its bounded cooldown while
healthy device lanes continue. Routine PWM uncertainty is reconciled after the
complete 120-second overwrite lease before that device's later routine probe;
manual-override children remain owned by their aggregate, and schedule
uncertainty remains local to that device until authoritative announcement/hash
evidence or explicit reconciliation resolves it. Broker reconnection does not
rewrite an ambiguous outcome.

`POST /api/operations/:operationId/reconcile` is revision checked. A successful
operator reconciliation updates the versioned result document and atomically
commits a critical-retention `operation.outcome-reconciled` state/outbox event.
For an unknown `set_pwm` with `overwrite: true`, the repository rejects
reconciliation until 120 seconds after operation completion because the
firmware may still be holding the overwrite. Non-overwrite operations have no
such delay.

Manual overrides keep aggregate ownership of their child operations. The
generic device-operation route rejects both a manual-override aggregate and an
unknown child owned by an unresolved aggregate. The override service must first
reconcile that child through its internal path, then finalize the aggregate
through its own critical `override.outcome-reconciled` event, no earlier than
the stored 120-second safety deadline. Its due timer also completes that safe
owner workflow after the deadline; neither path resends the uncertain command.

In the React operation details, an unreconciled device outcome shows the exact
request/result and requires the operator to check that physical and device state
were verified before the reconciliation button is enabled. The mutation has
retries disabled. Success displays the authoritative revision while continuing
to label the original outcome unknown; an already reconciled result shows its
durable timestamp and no action. A rejected safety-window attempt remains
available with the server conflict shown. Manual-override aggregates instead
use their owner-specific card and reconciliation route.

The snapshot exposes unresolved device outcomes in a separate bounded,
oldest-first window, independent of recent history and current pin mappings.
The global `/operations` page therefore keeps old or unmapped blockers
inspectable. If more than 100 exist, the UI reports truncation; reconciling the
displayed oldest entries reveals the next rows without making every snapshot
unbounded.

## Realtime and consistency model

Every authoritative state transaction increments the singleton revision and
inserts one versioned event into `state.db.state_outbox` atomically. A dispatcher
mirrors published rows idempotently into `events.db.state_events`. The two files
are deliberately not treated as a cross-database transaction: if the event
database is unavailable, authoritative state and its unpublished outbox row
remain committed and replayable.

That global revision is the contiguous snapshot/SSE/audit cursor; background
device, scheduler, alert, and maintenance changes advance it as well as user
changes. Optimistic concurrency for operator-owned mutations uses the separate
singleton `operator_concurrency.last_operator_revision` as a floor. A submitted
snapshot token is accepted when it is at least that floor and no greater than
the current global revision, so unrelated background activity does not reject a
valid draft while any intervening operator commit does.

The guard first write-locks the operator singleton inside the same SQLite
transaction that reads state and applies the mutation. A real change inserts
one global revision/outbox event and advances the floor to that new revision; a
verified no-op consumes neither. Migration seeds the floor from the existing
global high-water mark, and a committed legacy import advances it. Long-lived
browser forms pin their token at the first user interaction instead of replacing
it with a newer SSE cursor; a preserved conflicting draft requires an explicit
rebase after the authoritative snapshot refreshes. Immediate, draft-free actions
may use the current live token.

Automatic alert-rule seeding and delivery-state changes are visible global
state, so they use the same revision/outbox mechanism and precise alert/rule
invalidations. They intentionally do not update the operator floor: an automatic
delivery transition must update snapshots and SSE clients without falsely
conflicting with an unrelated human draft.

Browser synchronization is:

1. Read `/api/snapshot` and its monotonically increasing revision.
2. Open `/api/events?afterRevision=<revision>`; valid `Last-Event-ID` takes
   precedence on automatic reconnect.
3. Replay retained events through a high-water mark while buffering concurrent
   commits, then emit transient `system.stream-ready`.
4. Ignore duplicate revisions. A gap, explicit `system.resync-required`, or
   stale heartbeat closes the stream and forces a new snapshot.
5. Refetch the authoritative snapshot after contiguous invalidations rather
   than constructing control state optimistically in the browser.

The stream has bounded per-client queues. Overflow forces resynchronization and
cannot block controller work. Published outbox history keeps the newest 10,000
revisions and prunes at most 1,000 rows per pass; an unpublished revision is a
hard pruning watermark.

## Database representation

The storage model is relational first, not a JSON-document database.

`state.db` contains normalized tables for control areas, hardware-specific
mapping profiles, devices and their reported hardware identity, outputs,
throttles, channels, pin mappings, schedules, schedule points, control
operations, overrides, timers, sensors, switches, calibrations, alert rules and
lifecycle state, revisions/outbox, import audit, compiled device artifacts,
scheduler guards, alert delay state, and notification delivery intent.
Foreign keys, uniqueness, `CHECK` constraints, UTC-only schedules, and indexes
encode invariants that would be fragile inside one large document.

Control areas are ordered persistent records rather than a fixed frontend
list. Creating an area also provisions its 100% schedule multiplier. Renaming
changes only its display label, preserving the stable route slug and type key.
Deletion is rejected while channels or outputs still belong to the area. Every
create, rename, and delete commits an audit-retained state event containing the
before/after area record and multiplier state, making reconstruction from logs
or verified archives possible.

`events.db` contains mirrored committed events, structured interactions,
five-minute aggregates, archive metadata, retention policies, and retention
runs. Separating it keeps high-volume maintenance away from authoritative
control state. State uses `synchronous=FULL`; events uses `synchronous=NORMAL`;
both use WAL, foreign keys, a 5-second busy timeout, and a 64 MiB journal-size
limit.

JSON text is limited to data that is genuinely variable or wire-shaped:

- versioned operation requests/results and event envelopes;
- typed interaction payloads, alert details/observations, and notifications;
- optional device/sensor/switch metadata and timer/rule configuration;
- compiled firmware schedule documents; and
- import/DSL diagnostics and archive metadata.

Application-owned JSON is paired with a positive schema-version column and
SQLite `json_valid` constraints. Implemented readers parse it through strict
JSON/Zod boundaries, verify stored hashes where defined, and fail loudly on
corruption. Frequently filtered fields such as revision, status, timestamps,
device, outcome, severity, and retention class remain ordinary indexed columns.

## Logging, retention, and compression

There are two intentionally different log streams:

1. Fastify/Pino emits structured process and request logs to stdout. Current
   redaction covers authorization/cookie/set-cookie fields and common secret,
   password, and token keys. Both Compose definitions use Docker's `local` log
   driver, capped at five compressed 10 MiB files per service.
2. `events.db.interactions` stores queryable domain/runtime history with
   direction, kind, severity, topic, device/correlation/operation identifiers,
   outcome, duration, byte count, retention class, and an optional versioned
   payload. Persisted payload redaction happens before canonical serialization
   and SHA-256 calculation. Raw MQTT payloads and response bodies are not
   retained by the runtime logger. Backup attempts add a metadata-only
   `maintenance.backup` audit interaction containing success/failure and
   severity, with no paths, secrets, raw errors, or database payloads.

The controller boundary adds `http.response-outcome` rows for every
POST/PUT/PATCH/DELETE response and every status at or above 500, including reads.
They contain only the normalized method, Fastify route template (or null), and
status: 2xx/3xx is audit/info/succeeded, 4xx is audit/warning/failed, and 5xx is
critical/critical/failed. Non-mutation reads below 500 are omitted. Domain
mutation details remain authoritative in state events. Detached interaction
writes do not delay or change the HTTP response, report persistence failure to
Pino, and drain after the runtimes/coordinators stop but before `events.db`
closes.

Unexpected runtime callback failures add a critical
`controller.runtime-callback-error` row containing only a sanitized error class
and error name. Exception messages and stacks are never stored there.

Normal five-second ticks and their healthy background PWM wire traffic are
omitted entirely. A background PWM operation exists in `state.db` only while
pending or in flight so restart recovery remains safe; success removes that
transient row without advancing public state. Failure, timeout, cancellation,
or an unknown outcome promotes it to a durable operation and state event.
Repeated healthy announcements, discovery publications, command batches, and
matched responses are also omitted. Foreground operations keep one semantic
operation summary, while diagnostics, malformed or unexpected responses, and
outcome-unknown paths remain durable.

Alert transitions (open, acknowledge, reopen, recover) are never throttled.
Repeated matching observations for an unchanged still-true alert create at most
one additional state event per hour, bounding history volume without hiding a
transition.

Default live logical budgets and ages are:

| Class       | Retention age | Live byte budget | Before deletion                                      |
| ----------- | ------------: | ---------------: | ---------------------------------------------------- |
| raw         |        7 days |          512 MiB | Aggregate into five-minute summaries; no raw archive |
| operational |      180 days |            2 GiB | Verified archive                                     |
| aggregate   |       3 years |            1 GiB | Verified archive                                     |
| audit       |       3 years |            2 GiB | Verified archive                                     |
| critical    |      10 years |            1 GiB | Verified archive                                     |

Retention runs once per UTC day at or after 03:00 using a persisted guard,
recovers stale `running` records after the configured threshold, and records
success/failure in `retention_runs`. Candidates are selected by age or byte
budget across interactions, aggregates, and mirrored state events in a single
deterministic order. The job reads internal candidate batches capped at 10,000
and carries aggregation and byte-budget accounting across batches instead of
materializing a whole retention class. A class requiring archive is never
deleted unless each exact selection has been written and re-read as a complete,
verified archive. The same job deletes any retained successful `set_pwm`
operation rows older than seven days only when no override, artifact, or
scheduler guard references them; successful background refreshes are already
removed immediately. Terminal notification deliveries older than 180 days are
removed only when a newer terminal result exists for the same alert/destination;
pending and attempting rows plus the newest terminal result are retained. Terminal delivery
metadata is mirrored idempotently to `events.db` before that state history can
age out. Terminal state and a null audit checkpoint commit together; recorder
failure leaves the row eligible for bounded startup/dispatch backfill, and a
notification-specific unique operation ID makes a crash between event write and
checkpoint update safe to replay. Unaudited terminal rows cannot be pruned. The
job then drains orphan `state_revisions` after outbox pruning while retaining the
current revision and remaining notification references. All state-side
deletions use deterministic batches capped at 10,000 and write one durable
operational or critical maintenance diagnostic.

Archives are deterministic newline-terminated NDJSON compressed using Node's
native Zstandard implementation (`.ndjson.zst`). Verification checks compressed
size/SHA-256, uncompressed size/content SHA-256, schema, record count/type
counts, range, and retention class before deletion. New metadata stores a
portable filename rather than an absolute host path; legacy absolute rows are
rebased to an explicitly supplied archive directory. `verify-archive-set`
rechecks every complete archive and writes a deterministic versioned manifest
for a separate archive-directory backup/restore.

Archive creation is monotonic under concurrency. The first creator reserves a
pending row; only a failed row can be explicitly retried. A completed archive is
never moved back to pending or failed because another creator loses the race.
Before deletion, the winning artifact is re-read and verified. A losing creator
returns that same completed artifact, while failure cleanup can only change its
own still-pending reservation. This prevents source deletion before a verified
winner exists.

Storage projection measures logical bytes, SQLite allocation/reclaimable pages,
archive sizes/compression
ratio, failed/pending work, and a seven-day annualized ingest estimate. Turning
those measurements into alerts is composed through a separate non-overlapping
storage-health coordinator. It runs immediately at startup and then at
`AQUARIUM_STORAGE_HEALTH_INTERVAL_MS` (default 300,000; valid 10,000-86,400,000
ms) after the prior check settles, so delayed checks never create a catch-up
burst. It records six typed sensors/rules on a disabled virtual device:

- minimum available bytes across the state DB, events DB, archive, and backup
  filesystems;
- projected upper-bound tracked storage after one year;
- retention failures after the latest successful retention run;
- failed archives after the latest completed archive;
- whether the latest recorded backup outcome failed; and
- whether no successful backup exists or the latest success is older than
  `AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS`.

`AQUARIUM_STORAGE_MINIMUM_FREE_BYTES` defaults to 1,073,741,824 (1 GiB), and
`AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES` defaults to 10,737,418,240
(10 GiB). Exact observation timestamps drive normal alert open/recovery.
Startup measurement/storage/evaluation failure aborts startup; a later check
failure is logged and retried at the next interval. Each failure count returns
to zero after its next success. Retention uses completion time, archives use
creation time, and both use SQLite insertion order as the equal-timestamp
tie-break so same-millisecond batched outcomes recover correctly. Separate
backup rules distinguish a failed latest attempt from a missing/stale success;
a later verified backup recovers both observations.

## Backup and restore

The controller runs a non-overlapping verified database backup every day at
02:00 UTC. Freshness never trusts a successful interaction row by itself. The
latest successful row must contain its canonical `createdAt`, and only the exact
configured `backup-<createdAt>/manifest.json` artifact is considered—there is no
directory scan or fallback to an older row. The artifact receives full schema-v2
manifest, checksum, SQLite integrity/foreign-key, and replay-boundary
verification. Startup runs one promptly when that verified artifact is missing,
invalid, or older than the configured threshold. Storage health reads the same
verified timestamp, preventing a deleted or corrupt artifact from appearing
fresh. Retention keeps the newest canonically named, fully verified backup from
each UTC day for 14 days, then the newest verified backup from each UTC week for
183 days. Unknown, malformed, damaged, or symlinked entries are never deleted
automatically.

Verification is serialized and deduplicated. A cached valid or invalid result is
reused only while strong `lstat` identity is unchanged for the configured root,
backup directory, manifest, and both database files: device, inode, type, size,
nanosecond modification/change times, and root location must still match.
Identity is checked before and after full verification. Root/ancestor realpath
mismatch, candidate symlinks, replacement, deletion, or same-size modification
forces rejection or re-verification. Focused evidence on 2026-07-19 passed 21/21
tests across the four backup/coordinator/health files; final settled-tree
validation remains pending.

The storage CLI accepts only explicit paths. A backup atomically reserves its
timestamped directory, captures the state revision, then uses SQLite's online
backup API to copy events before state. Each copy is checkpointed into one
standalone database file with no WAL sidecar dependency. Its schema-v2 manifest
records the capture, copied-events, and copied-state revision boundaries
alongside size, SHA-256, and integrity status; verification also checks foreign
keys. Verification requires the actual database boundaries to match, events not
to lead state, and contiguous outbox coverage across the copy gap. Every
retained outbox row is reconciled against
the copied event: matching rows are byte-checked, while absent rows have their
publication/retry checkpoint reset for immediate idempotent replay after
restore. This recovery-first rule is bounded by outbox retention and may
temporarily resurrect recently age-pruned state events. Schema-v1 manifests are
rejected because they contain no coherence boundary. Both source paths must
already be regular files, preventing a missing events path from being created
as a logging side effect. After the attempt, the runtime/command records one
metadata-only audit outcome in the source events database. A backup error remains
visible if diagnostic persistence also fails; the command surfaces both in an
`AggregateError`.

Restore runs the full checksum, schema, boundary, coverage, and replay-checkpoint
verification first and atomically publishes adjacent temporary files with a
no-replace hard link to two new, nonexistent destinations. It never overwrites a
live path, including if a destination appears during restore. An operator must
perform final path switching during a controlled outage and keep the prior
verified databases available for rollback. Exact commands are in the README.

The two-database backup does not duplicate retained `.ndjson.zst` payloads.
Those files are the long-term log copy after live-row deletion and must be
backed up as their own archive-directory asset. Before and after that external
copy, run `verify-archive-set` with the matching `events.db`, archive directory,
and a new explicit manifest output, then compare/preserve the deterministic
manifest. Archives are not automatically deleted because they may be the only
remaining payload copy. Their bytes are included in storage projection and
free-space alerts, but backup-directory copies are not. Daily/weekly database
backup retention and an operator-selected archive offload/lifecycle remain
production requirements.

## Test and CI architecture

Executable CI separates failure domains into six validation jobs:

- `static-unit`: `npm ci`, format check, lint, typecheck, unit tests, and build;
- `critical`: the high-value contract/domain/protocol/fake/controller selection;
- `integration`: real digest-pinned Mosquitto/Testcontainers coverage and the
  production-namespace assertion;
- `browser`: pinned Chromium, production builds, Playwright/axe, and
  failure-only trace/screenshot/video artifacts;
- `firmware`: cached pinned Arduino/ESP32 toolchain compilation of firmware
  6.0.0;
- `container`: amd64 Compose health/restart/hardening plus an emulated ARM64
  HTTP/SQLite integrity smoke.

A separately gated `publish-image` job performs multi-architecture GHCR
publishing through a run-unique tag, gated to default-branch pushes and an
explicit `AQUARIUM_GHCR_IMAGE` repository variable. It fails closed unless
registry inspection proves the tag absent, records the returned manifest digest,
and starts amd64 and ARM64 smoke containers from that exact digest before the job
succeeds.

The container layer is independent evidence: the pinned Node 24/npm 11
multi-stage Dockerfile builds native `better-sqlite3` for amd64 and ARM64. The
local Compose profile runs the production-built SPA/controller, pinned
Mosquitto 2.0.22, and two persistent fake actors. The profile shares only the
broker network namespace, so the controller and actors retain their existing
literal-loopback broker guard; captured traffic remains under
`test/aquarium/*`.

Pull-request code never runs on a Pi. No deploy workflow exists. The hosted
repository is public, reachable branch history contains only redacted
sentinels, and `master` is protected by all six exact validation contexts.
GHCR publication is configured; the historical pre-4.1 image passed
exact-digest smoke on both platforms, while the current branch needs a new
publication and digest selection. One unreachable historical object remains directly
addressable and its secret-scanning alert remains open; independently confirm
revocation, request GitHub Support cleanup, and resolve the alert only as
`revoked`. Secret scanning and push protection remain enabled, but they do not
revoke exposed credentials. GitHub Free does not charge standard hosted Actions
minutes for public repositories; private repositories use an included quota.
Free-plan protected branches apply to public repositories, while
private-repository branch protection requires an eligible paid plan. See
GitHub's official
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation.

## Deployment direction

The eventual LAN deployment uses plain HTTP and explicit database, archive,
backup, broker, and topic configuration. Production MQTT requires production
runtime mode, the production namespace, an explicit broker URL, and the exact
confirmation interlock; tests are forbidden from selecting it. Remote access,
TLS termination, and authentication belong behind a deliberately configured
network boundary, not inside this application.

`compose.production.yaml` is deliberately a fail-closed template: it constructs
the image reference from separately required
`AQUARIUM_CONTROLLER_IMAGE_REPOSITORY` and
`AQUARIUM_CONTROLLER_IMAGE_SHA256` values. Compose inserts the literal
`@sha256:` separator, and the latter value must be the published 64-character
hex digest, so a mutable tag such as `latest` can never become the selected
artifact. Docker rejects an invalid digest before starting the service. The
template also requires an HTTP bind address/port, production
broker URL, exact MQTT confirmation, and four host storage directories. It does
not create an anonymous production broker or infer a database path. The image
runs as UID/GID 1000 with all capabilities dropped, `no-new-privileges`, a
read-only root filesystem, and explicit state/events/archive/backup mounts.
The optional webhook URL, destination key, timeout, authentication header name,
and secret header value use Compose environment pass-through: unset values stay
absent and operator-supplied values are never embedded in this file. The
deployment preflight renders with `config --quiet` so it does not print them.
Controller readiness probes both databases and, when enabled, the subscribed
MQTT transport; liveness reports only process/HTTP responsiveness.

The supervised Pi procedure is in `docs/production-deployment.md`. Its preflight
requires the four bind directories to be absolute, owned by UID/GID 1000, mode
0700, and above an explicit free-space floor; validates the exact digest
rendering; and pulls without starting a service. The runbook separately gates
startup on readiness and SQLite integrity, verifies archive copies using a
matching events-database backup and deterministic archive-set manifests, and
restores rollback databases and archives into new paths rather than overwriting
evidence.

The local stack command is `npm run stack:test:up`, with UI/API on
`http://127.0.0.1:3001` and Mosquitto on loopback port 18883. The Docker `local`
log driver caps each service at five compressed 10 MiB files. CPU, memory, PID,
restart, and graceful-stop policies are explicit and the controller is never
horizontally scaled. Settled-tree and hosted evidence includes a healthy amd64
stack, persistence across controller/fake recreation, non-root/read-only checks,
a bounded test-topic capture, and successful emulated ARM64 database migration,
HTTP startup, and integrity checks. Pi validation and production deployment
remain separate external gates.
