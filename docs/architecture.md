# Target architecture

Status: accepted foundation decision, 2026-07-10.

## Decision

Build a TypeScript modular monolith. One controller process will own HTTP, SSE, MQTT, scheduling, persistence, alerts, and hardware-facing adapters. The browser is a React single-page application. Mosquitto remains a separate broker process.

This is intentionally not a Next.js application and not a set of microservices. The dashboard is local-network software with no SEO or server-rendering requirement, while MQTT, timers, schedule evaluation, and alerting need one predictable long-lived owner. Vite and Fastify provide those two lifecycles directly with less operational surface on the Pi.

## Technology baseline

| Concern            | Choice                                         | Reason                                                                         |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Runtime            | Node.js 24 LTS                                 | Supported LTS line for both development and ARM64 deployment                   |
| Language           | TypeScript 5.9, strict mode                    | One type system across UI, controller, domain, and tests                       |
| UI                 | React 19, Vite 8, React Router, TanStack Query | Local SPA, fast builds, explicit routing and server-state ownership            |
| Controller/API     | Fastify 5 with Pino                            | Long-lived process, low overhead, structured logging, test injection           |
| Runtime validation | Zod 4                                          | Validate HTTP, SSE, MQTT, configuration, and persisted JSON at boundaries      |
| State database     | SQLite WAL via Kysely and better-sqlite3       | Transactional single-writer storage without another database service on the Pi |
| Event database     | A second SQLite database                       | High-volume retention cannot block or endanger control state                   |
| MQTT               | Mosquitto 2 and MQTT.js 5 using MQTT 3.1.1     | Matches deployed ESP firmware and supports real-broker tests                   |
| Tests              | Vitest, Testcontainers, Playwright, fast-check | Pure logic, real MQTT behavior, browser behavior, and protocol invariants      |
| Deployment         | Docker Compose and an immutable ARM64 image    | Repeatable Pi deployment and rollback without editing the Pi application tree  |

SQLite is not exposed over the network. External tools query authenticated read/export API endpoints. This avoids opening a database port and keeps schema changes behind a stable contract. State and event databases will be backed up independently.

## Repository boundaries

```text
apps/
  controller/      Fastify composition root; later MQTT, DB, clock and notifier adapters
  web/             React application
packages/
  contracts/       Shared Zod HTTP and SSE contracts
  esp-protocol/    Legacy MQTT wire compatibility; no domain policy
  domain/          Pure schedules, pumps, DSL and alarms (next milestone)
```

Infrastructure stays in the controller application until a boundary has more than one real implementation. Domain code receives explicit ports such as `Clock`, `DeviceTransport`, repositories, and `Notifier`; it never imports Fastify, MQTT.js, SQLite, or Raspberry Pi APIs.

## Legacy ESP compatibility boundary

The following are wire contracts, not patterns to spread through the new code:

- MQTT 3.1.1, QoS 0, non-retained messages.
- `aquarium/command`, `aquarium/announce`, and `aquarium/response`; test traffic uses `test/aquarium/...`.
- Semicolon-separated commands with response indexes scoped to the published batch.
- At most three commands per target device in a batch.
- Payloads over 256 UTF-8 bytes use `chunk:index:total:isLast:data` frames with at most 200 data bytes and 50 chunks.
- The active firmware schedule JSON limit is 4096 bytes even though chunk storage is larger.
- Compact schedule serialization and its unsigned 32-bit DJB2 hash must be deterministic.

The deployed ESP firmware is a compatibility target. Routine controller work must not require reflashing every ESP. Firmware changes are considered only when they provide a clear safety or reliability win that justifies the operational cost, and the server adapter continues to support the deployed protocol during any rollout.

There is no request ID in responses and no message ID in chunk frames. ESPs have one global chunk reassembly buffer. The adapter must therefore hold one global wire mutex and allow only one legacy batch in flight. The controller must not be horizontally scaled. A timeout means the actuator outcome is unknown; it is not permission to blindly retry a command.

The five-second host refresh and 120-second firmware failover are safety behavior. During host control, commands refresh a temporary firmware override. If the controller disappears, the ESP resumes its stored schedule after that override expires. Migration tests must prove this behavior before the old controller is retired.

## Realtime model

HTTP mutations remain acknowledged POST/PUT operations. They expose pending, success, failed, timed-out, and outcome-unknown states explicitly.

One `/api/events` EventSource stream carries typed Zod envelopes. The persistent design is:

1. Fetch a snapshot with a monotonically increasing revision.
2. Open SSE from that revision.
3. Apply or invalidate TanStack Query data for each committed event.
4. Reconnect with `Last-Event-ID` and replay retained events.
5. Emit `resync-required` if the requested revision has aged out.

Heartbeat comments prevent idle intermediaries from closing the stream. The foundation slice currently emits only a connection event; replay begins when the event store lands.

## Persistence and logging

`state.db` will normalize devices, channel mappings, schedule graphs, throttles, timers, alarm configuration, and migration metadata. JSON text is reserved for genuinely document-shaped DSL/configuration payloads and is validated with Zod on every read and write.

`events.db` will store structured interactions with direction, kind, topic, device/correlation context, outcome, payload, and byte count. Pino service logs go to stdout and production uses a capped, compressed Docker log driver.

Ten gigabytes per year is about 27 MB per day. A five-second loop runs 17,280 times daily, so permanently storing verbose raw payloads can exceed the budget. Safety, alarm, configuration, command-outcome, and error events remain durable; high-volume raw traffic gets a measured retention window, aggregation, and optional daily compressed archives. Disk usage and retention failures are alert conditions.

## Test strategy

- Unit tests use pure functions, injected clocks, and an in-memory transport fake.
- MQTT integration tests start a pinned Mosquitto container and independent MQTT.js fake ESP actors. The broker itself is not mocked.
- Protocol fixtures cover discovery, announcements, batching, chunk boundaries, malformed messages, response correlation, timeout/unknown outcome, schedule size/hash, and namespace isolation.
- Playwright later drives the complete React/Fastify application against the real integration stack.
- Firmware compilation and wire fixtures enter CI before firmware behavior is changed.

## Deployment direction

CI first runs formatting, linting, type checking, unit/integration tests, and builds. It then produces an immutable ARM64 image for GHCR. A deploy-only runner on the Pi may run only protected main/environment jobs: pull by digest, back up SQLite, run additive migrations, update Compose, verify HTTP and MQTT health, and roll back to the prior digest on failure. Pull-request code never executes on the Pi.

The LAN deployment uses plain HTTP and removes application-managed certificates. Broker and controller ports remain limited to the trusted LAN/Compose network. Remote access, if ever required, belongs behind a deliberately configured Tailscale or reverse-proxy boundary.

## Migration sequence

1. Foundation (this slice): workspace, strict contracts, ESP framing tests, Fastify health/SSE, React shell, CI checks.
2. Persistence: Kysely migrations, state/event databases, atomic import and validation report for legacy JSON.
3. MQTT adapter: global wire mutex, discovery/registry, response correlation, fake ESP and real Mosquitto integration tests.
4. Scheduling: UTC interpolation, compact schedule compiler/hash, time sync, five-second refresh and 120-second failover tests.
5. Control UI: snapshot/SSE state, schedules, devices, pending acknowledgements, logs, alarms, timers, and later the DSL/dosing workflow.
6. Operations: alert adapter, retention budgets, backups, ARM64 image, staged Pi deployment and rollback.

## Primary references

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Vite releases](https://vite.dev/releases)
- [Fastify documentation](https://fastify.dev/docs/latest/Reference/)
- [Zod](https://zod.dev/)
- [Kysely](https://kysely.dev/docs/getting-started)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)
- [Server-sent events standard](https://html.spec.whatwg.org/multipage/server-sent-events.html)
