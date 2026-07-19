# Development prerequisites

Updated: 2026-07-15

This inventory records the toolchain used to verify the rewrite. Local
application and test network traffic is restricted to localhost, test-created
Docker networks, and `test/aquarium/*`.

## Verified on the current development machine

| Prerequisite               | Current evidence                                                                             | Remaining action                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js / npm              | Node 24.13.0 and npm 11.13; `.nvmrc` and the container pin Node 24.13.0                      | Keep CI and container runtime aligned to the exact Node patch release                                       |
| TypeScript toolchain       | Installed and locked by `package-lock.json`                                                  | None for foundation                                                                                         |
| Mosquitto                  | Native Mosquitto 2.0.22 is installed at `C:\Program Files\mosquitto\mosquitto.exe`           | Use only as a diagnostic fallback; required integration tests still use a pinned Testcontainers image       |
| Zstandard                  | Node 24 native Zstandard archive round-trip, checksum, corruption, and truncation tests pass | None locally                                                                                                |
| Playwright browser payload | `@playwright/test` 1.61.1 and Chromium 1228 run the retry-free production-topology suite     | CI installs the repository-pinned Chromium revision                                                         |
| SQLite                     | WAL/STRICT migrations, online backup/restore, integrity, and native amd64/ARM64 loading pass | Production paths and backup schedule remain operator configuration                                          |
| Native build fallback      | CMake exists; MSVC `cl` is not on PATH                                                       | Prefer supported `better-sqlite3` prebuilds; Docker image builds native Linux dependency in its build stage |
| WSL                        | Hypervisor is present and Docker Desktop's Linux engine runs under WSL2                      | The user's Ubuntu distribution may remain separate from Docker Desktop                                      |
| Docker/Testcontainers      | Docker Desktop 4.81 / engine 29.6.1 and pinned-Mosquitto Testcontainers suites pass          | Keep the Linux engine running for integration, browser, container, and firmware lanes                       |
| Disk                       | Runtime checks cover all configured state/events/archive/backup filesystems                  | Set production thresholds and monitor the resulting alerts                                                  |

## Locked npm dependencies

- Persistence: `kysely`, `better-sqlite3`, `@types/better-sqlite3`.
- MQTT/controller: `mqtt`.
- Integration: `testcontainers`, property-test support with `fast-check`.
- Web tests: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`, `msw` if HTTP interception remains useful.
- Browser tests: `@playwright/test`.
- Production static serving and security headers: `@fastify/static` and
  `@fastify/helmet`.

Node's built-in Zstandard API is preferred over another native compression dependency.

## Container downloads and pins

The repository records immutable image digests for:

- Mosquitto 2.0.22 used by Testcontainers and Compose.
- Node 24 Linux image used for build/runtime stages.
- GitHub Actions pins immutable action commit SHAs and keeps the reviewed release
  versions in comments; the Buildx/QEMU helpers are provisioned by those pinned
  action implementations.

Pulling these images requires network approval. Tests bind random host ports or Docker-network-only ports and must never point at a legacy address.

## Commands that may require network or elevation

- `npm install ...` for locked application/test packages.
- `npx playwright install chromium` if the cached browser revision does not match.
- Docker Desktop installation/startup and its one-time WSL initialization.
- `docker pull` / Testcontainers image resolution.
- Buildx/QEMU/binfmt initialization for `linux/arm64` smoke testing.

No command in this plan authorizes contacting the Pi, scanning the LAN, using production credentials, changing GitHub settings or deploying.

## Completed local probes

1. `docker version` returns both client and server.
2. A disposable container runs successfully.
3. A Testcontainers test starts the pinned Mosquitto image and connects on a random localhost port.
4. `better-sqlite3` opens a temporary database, enables WAL, runs a transaction, backup and integrity check.
5. Playwright starts the pinned Chromium revision and loads the production-built local app.
6. Native Node Zstandard compress/decompress produces a byte-identical round trip and detects truncated/corrupt archives.
7. An ARM64 image loads native SQLite and passes health under native ARM or QEMU.

All seven probes above passed on 2026-07-15. The native Mosquitto executable is
only a diagnostic fallback; it does not replace the pinned Testcontainers or
ARM64 evidence.
