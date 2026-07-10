# Development prerequisites

Updated: 2026-07-10

This inventory front-loads tooling and approval risk for the complete rewrite. It does not contain production addresses, credentials or data. Local application and test network traffic is restricted to localhost, test-created Docker networks and `test/aquarium/*`.

## Verified on the current development machine

| Prerequisite               | Current evidence                                                                                                            | Remaining action                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js / npm              | Node 24.13 and npm 11.13; repository pins Node 24                                                                           | Keep CI and container runtime aligned to Node 24                                                            |
| TypeScript toolchain       | Installed and locked by `package-lock.json`                                                                                 | None for foundation                                                                                         |
| Mosquitto                  | Native Mosquitto 2.0.22 is installed at `C:\Program Files\mosquitto\mosquitto.exe`                                          | Use only as a diagnostic fallback; required integration tests still use a pinned Testcontainers image       |
| Zstandard                  | Node 24 exposes native Zstandard; a 2,400-byte prerequisite probe compressed to 42 bytes and round-tripped byte-identically | Add repository archive round-trip, corruption and truncation tests                                          |
| Playwright browser payload | `@playwright/test` 1.61.1 and Chromium 1228 are installed; a headless semantic probe passed                                 | Add production-topology browser suites                                                                      |
| SQLite                     | `kysely`, `better-sqlite3` and typings are locked; a native WAL/STRICT transaction and `integrity_check` probe passed       | Implement migrations, repository tests, online backup and Linux ARM64 loading                               |
| Native build fallback      | CMake exists; MSVC `cl` is not on PATH                                                                                      | Prefer supported `better-sqlite3` prebuilds; Docker image builds native Linux dependency in its build stage |
| WSL                        | WSL2 platform is enabled; no user distro installed                                                                          | Docker Desktop may manage its own WSL distributions                                                         |
| Docker/Testcontainers      | Docker Desktop 4.81 and `testcontainers` are installed; processes and contexts exist, but daemon calls still time out       | Complete first-run/WSL initialization, then run a hello-world and Testcontainers probe; never mock broker   |
| Disk                       | Host disk query is sandbox-restricted                                                                                       | Local stack and deploy tooling must perform explicit free-space checks with actionable failures             |

## Planned npm dependencies

Install by coherent milestone and lock exact resolved versions:

- Persistence: `kysely`, `better-sqlite3`, `@types/better-sqlite3`.
- MQTT/controller: `mqtt`.
- Integration: `testcontainers`, property-test support with `fast-check`.
- Web tests: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`, `msw` if HTTP interception remains useful.
- Browser tests: `@playwright/test`.
- Production static serving and security headers: the appropriate Fastify plugins once the production composition root is implemented.

Node's built-in Zstandard API is preferred over another native compression dependency.

## Container downloads and pins

Before integration work, record immutable image digests for:

- Mosquitto 2.0.22 used by Testcontainers and Compose.
- Node 24 Linux image used for build/runtime stages.
- Any Buildx/QEMU/binfmt helper used for local ARM64 smoke tests.

Pulling these images requires network approval. Tests bind random host ports or Docker-network-only ports and must never point at a legacy address.

## Commands that may require network or elevation

- `npm install ...` for locked application/test packages.
- `npx playwright install chromium` if the cached browser revision does not match.
- Docker Desktop installation/startup and its one-time WSL initialization.
- `docker pull` / Testcontainers image resolution.
- Buildx/QEMU/binfmt initialization for `linux/arm64` smoke testing.

No command in this plan authorizes contacting the Pi, scanning the LAN, using production credentials, changing GitHub settings or deploying.

## Required local probes before dependent implementation is considered verified

1. `docker version` returns both client and server.
2. A disposable container runs successfully.
3. A Testcontainers test starts the pinned Mosquitto image and connects on a random localhost port.
4. `better-sqlite3` opens a temporary database, enables WAL, runs a transaction, backup and integrity check.
5. Playwright starts the pinned Chromium revision and loads the production-built local app.
6. Native Node Zstandard compress/decompress produces a byte-identical round trip and detects truncated/corrupt archives.
7. An ARM64 image loads native SQLite and passes health under native ARM or QEMU.

The native Mosquitto executable can unblock pure local protocol work if Docker first-run requires user interaction, but it does not replace the required Testcontainers suite or ARM64 container proof.
