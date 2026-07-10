# Aquarium Controller

This repository is the TypeScript rewrite of the Raspberry Pi aquarium controller. The previous Python, Flask, and firmware implementation remains under `.old/` as migration reference; it is not the target architecture.

## Foundation stack

- Node.js 24 LTS and strict TypeScript
- React with Vite for the LAN dashboard
- Fastify for HTTP, native server-sent events, and the long-lived controller process
- Zod schemas shared across process and browser boundaries
- A dedicated ESP protocol package for legacy MQTT framing and validation
- SQLite with Kysely for state, configuration, and structured event storage (next milestone)
- MQTT.js with Mosquitto for device communication (next milestone)
- Vitest now; real-broker Testcontainers and Playwright as integration slices land

The architecture and migration sequence are documented in [docs/architecture.md](docs/architecture.md).

## Local development

Requirements: Node.js 24 and npm 11.

```sh
npm install
npm run dev
```

The Vite UI runs at `http://127.0.0.1:5173` and proxies `/api` to the controller at `http://127.0.0.1:3001`.

Useful commands:

```sh
npm run check
npm test
npm run build
```

The current slice deliberately contains no database migration and does not connect to the production MQTT broker. It establishes the typed boundaries, preserves and tests the legacy ESP framing rules, and proves HTTP-to-SSE-to-React connectivity before actuator control is introduced.
