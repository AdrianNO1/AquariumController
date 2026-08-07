# AquariumController agent instructions

## Required reading

Read `README.md` completely before changing this repository. It is the required
project overview and source for the technology stack, architecture, data and
logging model, local workflows, CI lanes, firmware behavior, and current
production boundary. Do not rely on an older chat summary instead.

Read the relevant detailed guide before task-specific work:

- `docs/architecture.md` for boundaries, invariants, and configuration;
- `firmware/esp32/README.md` for firmware, USB bootstrap, OTA, and releases;
- `docs/production-deployment.md` before any Pi or production work;
- `docs/pi-production-handoff.md` for cutover and recovery;
- `docs/readiness-report.md` for what has and has not been proven; and
- `docs/legacy-fixture-audit.md` before legacy-data work.

If documentation and current code disagree, investigate rather than guessing
and update stale documentation with the code change.

## Non-negotiable safety

This controls a real aquarium. Treat the Pi, production MQTT broker, databases,
OTA endpoints, and physical ESP32s as production systems.

- Do not SSH to, restart, reboot, deploy to, publish MQTT to, or send OTA to
  production or a real ESP unless the user explicitly authorizes that action in
  the current request. Read-only production inspection must also be in scope.
- Stop on a serious blocker, ambiguous output effect, failed safety check, or
  unexplained actuator state. Never power through it.
- Never point local development or fake ESPs at the production broker or
  `production` namespace. The Compose test stack uses `test/aquarium/*` and its
  own broker.
- Firmware below 6.0.0 must remain visible but `firmware_unsupported` and must
  receive no schedules, overrides, configuration writes, or OTA commands.
- Preserve the documented ESP failover and device-local command behavior. One
  failed ESP must not block healthy devices, and Pi loss must still allow the
  ESP's local schedule to resume.
- Never expose ignored operator data or secrets. Do not read or modify `.env`.
  Do not print `.data/pi-login.json`, `firmware-config.h`, production
  configuration, or `.old/data`; keep them untracked.
- Treat `.old/` as migration evidence, not the current implementation. Modify
  it only when specifically requested.
- Validate multi-entity user changes completely and commit them atomically; do
  not reintroduce sequential partial saves. Backup verification must not mutate
  backups, and restore must use new paths without deleting forensic evidence.
- Device names do not select mapping profiles. Preserve explicit selection,
  hardware-profile pin validation, and the GPIO12 warning.
- The frontend is a compact aquarium-maintainer tool, not a public product or
  landing page. Preserve direct graph editing, compact controls, mobile use,
  local-time display, useful device IDs, and quiet transient feedback. Avoid
  raw database IDs, decorative copy, excessive boxes, and layout shifts.

## Making changes

1. Inspect `git status` first and preserve unrelated user changes.
2. Use a focused `codex/<topic>` branch unless the user explicitly chooses a
   different workflow. Normal changes reach protected `master` through a PR.
3. Make the smallest coherent change across contracts, migrations, runtime,
   UI, tests, and documentation as applicable.
4. Run checks proportional to risk, using the commands in `README.md`.
5. Review the final diff for secrets, generated files, stale fixed-version
   assertions, accidental `.old/` edits, and weakened production gates.

For MQTT/device work run the real-Mosquitto integration lane; for user flows run
targeted frontend tests and Playwright; for firmware run its tests and pinned
Docker compile; for deployment changes run deployment unit tests, Bash syntax,
and Compose/preflight validation. Use `npm run verify` plus applicable
integration/E2E lanes for broad or release-critical changes.

Do not stage, commit, push, open a PR, or enable auto-merge unless the user asks.
`git push` is permitted in this repository when publication is explicitly
requested. Never squash existing history merely to remove a secret; a history
rewrite must be narrowly authorized and preserve unrelated commits.

## CI, firmware, and releases

GitHub CI runs six validation jobs: static/unit/build, critical, real
Mosquitto, Playwright/Chromium, firmware compile, and amd64/ARM64 container
validation. Pull requests must pass protected checks. A successful default-
branch push additionally publishes and smoke-tests an immutable image in GHCR
at `ghcr.io/adrianno1/aquarium-controller`. CI never contacts or deploys to the
Pi.

The supported firmware source is
`firmware/esp32/ESP32Code/ESP32Code.ino`. Use
`npm run firmware:release -- <version>` rather than copying Arduino output.
Keep `firmware-config.h` ignored, and keep `TEST=false` in committed/release
firmware; CI enforces it. Real-device flashing or OTA requires explicit scope.

## Production deployment

Read `docs/production-deployment.md` first. After merge and a successful exact
`master` publication, the supervised workstation workflow is:

```sh
npm run production:deploy -- --dry-run
npm run production:deploy
```

The command requires clean synchronized `master`, selects the exact successful
GHCR digest, requires commit-specific confirmation, copies a verified database/
archive recovery bundle to ignored `.data/pi-backups`, and verifies or rolls
back the Pi update. It never uses a mutable tag or local image. Do not run the
real command without explicit current authorization.

Automatic image rollback does not rewrite a migrated database. If the previous
image cannot read the new schema, stop and use the documented verified SQLite
recovery procedure rather than improvising.
