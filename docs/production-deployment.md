# Raspberry Pi production deployment

Updated: 2026-07-19

This is a supervised deployment and rollback runbook. No repository workflow
contacts the Pi or deploys the controller. Commands in this document must be
run by an operator on the intended Pi from a reviewed checkout.

## 0. Clear the public-repository credential gate

The hosted repository is currently public. Do not treat its checkout, CI output,
or image as a trusted release source until this gate is closed. The 2026-07-19
hosted audit found two exposed credential paths
without reading or reproducing their values:

- GitHub secret scanning has an open Dropbox-token alert at historical
  `test2.py`, commit `49167c6313df5b46e17858b56528fc360bc29d71`.
- The aquarium Wi-Fi credential is present in the history of
  `slaveCode/ESP32Code/ESP32Code.ino`; the rewrite's sanitized working path is
  `.old/slaveCode/ESP32Code/ESP32Code.ino`.

Secret scanning and push protection are enabled. They can prevent or report
future exposure but do not revoke credentials already in history. Revoke the
Dropbox token and rotate the aquarium Wi-Fi password first. Rotation
is mandatory even if history is later rewritten: public clones and caches
cannot be recalled. Keep the repository private while remediation is in
progress when practical; changing visibility after exposure reduces new casual
access but does not make either credential safe again. Never copy ignored local
files such as `.env` files or private keys into a cleanup repository.

The Free-plan tradeoff that prompted public visibility is real but separate from
security remediation. GitHub does not charge standard hosted Actions minutes for
public repositories; private repositories use the account's included Actions
quota. Protected branches are available on GitHub Free for public repositories,
while private-repository branch protection requires an eligible paid plan. See
GitHub's official [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [protected-branch](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
documentation. Making this repository private now would reduce new exposure but
would not revoke either credential, erase clones, or sanitize history.

The lowest-risk publication path is a new repository with one clean root commit
containing only individually reviewed, sanitized project files and no inherited
`.git` directory. Run a full-history-capable secret scanner on that commit before
making it public, enable secret scanning and push protection, run CI once, then
protect its default branch. Preserve the old repository privately as evidence
only after both credentials are invalid.

If retaining this repository and its history is required, follow GitHub's
[sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
with a fresh mirror and `git-filter-repo --sensitive-data-removal`. Remove the
Dropbox-bearing file and replace the Wi-Fi credential in every branch and tag,
verify the rewritten object set before any force-push, and coordinate cleanup
of every other clone. Rewriting only `master`, deleting the current files, or
closing the alert is insufficient. GitHub may retain direct-SHA and cached views;
use the first-changed commits reported by `git-filter-repo` when contacting
GitHub Support for final cached-reference removal. At audit time there were no
forks, pull requests, or tags, but all three hosted branches (`master`, `test`,
and `codex/aquarium-rewrite`) contained the affected ancestry.

After sanitized history is hosted and CI has produced its real check names,
protect the actual default branch: require pull requests and all six validation
jobs, require the branch to be current before merge, block force-pushes and
deletion, and apply the rule to administrators. Keep immutable Action-SHA
enforcement, secret scanning, and push protection enabled. Only then configure
`AQUARIUM_GHCR_IMAGE` and allow the separately gated `publish-image` job on a
default-branch push to publish a release digest.

## 1. Record the release inputs

Use the exact multi-platform digest reported by the successful `publish-image`
job. The digest, not its temporary CI tag, is the deployment identity. Record
the prior image digest and prior storage paths in the change record before an
upgrade.

Load production values into the current shell from an operator-managed secret
store or a root-owned file outside the checkout. Do not commit credentials and
do not put them in the repository's default `.env` path. MQTT credentials can
be present in the broker URL, and the webhook authentication value is a secret.
Avoid `docker compose config` without `--quiet`, because a full rendering can
print environment values.

```sh
export AQUARIUM_CONTROLLER_IMAGE_REPOSITORY=ghcr.io/<owner>/<repository>
export AQUARIUM_CONTROLLER_IMAGE_SHA256=<64-hex-characters-after-sha256:>
export COMPOSE_DISABLE_ENV_FILE=1
export AQUARIUM_HTTP_BIND_ADDRESS=<explicit-Pi-LAN-address>
export AQUARIUM_HTTP_PORT=3001
export AQUARIUM_MQTT_BROKER_URL=mqtt://<production-broker-host>:1883
export AQUARIUM_PRODUCTION_MQTT_CONFIRMATION=ENABLE_PRODUCTION_AQUARIUM_MQTT
export AQUARIUM_STATE_HOST_DIRECTORY=/srv/aquarium/state
export AQUARIUM_EVENTS_HOST_DIRECTORY=/srv/aquarium/events
export AQUARIUM_ARCHIVE_HOST_DIRECTORY=/srv/aquarium/archives
export AQUARIUM_BACKUP_HOST_DIRECTORY=/srv/aquarium/backups
```

Decide the GHCR package visibility before the Pi preflight. A public container
package can be pulled anonymously. For a private package, authenticate the same
unprivileged Pi account that will run the Compose commands with a classic
personal access token scoped only to `read:packages` and an account that can
read the package. Read the token without echoing it and remove it from the shell
immediately after Docker receives it:

```sh
read -rsp 'GHCR read token: ' GHCR_READ_TOKEN
printf '\n'
printf '%s' "${GHCR_READ_TOKEN}" | \
  docker login ghcr.io --username <github-username> --password-stdin
unset GHCR_READ_TOKEN
```

Keep the resulting Docker client credential outside the checkout and protected
for that Pi account. The preflight deliberately fails when the exact digest
cannot be pulled; do not replace it with an unauthenticated mutable image tag.

Notifications are optional. If enabled, export the URL and any optional key or
timeout. The authentication header name and value must either both be supplied
or both be absent. Read the value without echoing it:

```sh
export AQUARIUM_ALERT_WEBHOOK_URL=https://<notification-destination>/aquarium
export AQUARIUM_ALERT_WEBHOOK_KEY=primary
export AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS=10000
export AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME=Authorization
read -rsp 'Webhook authorization value: ' AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE
printf '\n'
export AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE
```

When notifications are disabled, remove all five variables from the deployment
shell so an orphaned option cannot accidentally make startup fail:

```sh
unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE
```

## 2. Prepare and preflight storage

The image runs as UID/GID 1000. Create each bind directory explicitly, keep it
private, and do not rely on Docker to create a root-owned path:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 \
  "${AQUARIUM_STATE_HOST_DIRECTORY}" \
  "${AQUARIUM_EVENTS_HOST_DIRECTORY}" \
  "${AQUARIUM_ARCHIVE_HOST_DIRECTORY}" \
  "${AQUARIUM_BACKUP_HOST_DIRECTORY}"
```

Run preflight through Bash; the executable bit is not assumed. It validates all
required variables, a 64-bit Linux/ARM64 Docker engine, the immutable GHCR
reference, the MQTT interlock, webhook pairing, existing absolute bind paths,
UID/GID 1000, mode 0700, distinct non-nested storage paths, free space, and the
Compose rendering. Empty exported webhook options fail with instructions to
unset them, preventing an empty string from reaching runtime configuration. It
then pulls the exact digest for the Pi architecture and runs that image's full
configuration parser without starting the controller service.

```sh
bash deployment/pi-preflight.sh compose.production.yaml
```

The default minimum is 10 GiB available on every configured storage
filesystem. A reviewed deployment can raise or lower it explicitly with
`AQUARIUM_PREFLIGHT_MIN_FREE_BYTES`; the runtime's projection and free-space
alerts remain mandatory after startup.

## 3. Create the pre-start recovery set

Choose exactly one branch below. The first production migration starts from raw
legacy JSON and therefore has no SQLite database to back up. Later upgrades must
use the existing-database branch.

### 3A. First migration from legacy JSON

Run this branch only with four new, empty controller storage directories. Keep
the legacy installation intact. Stop its actual supervisor first and prove that
the old controller process can no longer publish MQTT commands. Replace the
example unit and paths below with the reviewed production paths:

```sh
export AQUARIUM_LEGACY_SERVICE=aquarium-legacy.service
export AQUARIUM_LEGACY_DATA_DIRECTORY=/srv/legacy-aquarium/data
export AQUARIUM_CUTOVER_EVIDENCE_ROOT=/mnt/aquarium-offsite/first-cutover-YYYYMMDDTHHMMSSZ

set -Eeuo pipefail
test "$(id -u):$(id -g)" = "1000:1000"
sudo systemctl stop "${AQUARIUM_LEGACY_SERVICE}"
if sudo systemctl is-active --quiet "${AQUARIUM_LEGACY_SERVICE}"; then
  printf 'Legacy controller is still active; cutover stopped.\n' >&2
  exit 1
fi

for directory in \
  "${AQUARIUM_LEGACY_DATA_DIRECTORY}" \
  "${AQUARIUM_STATE_HOST_DIRECTORY}" \
  "${AQUARIUM_EVENTS_HOST_DIRECTORY}" \
  "${AQUARIUM_ARCHIVE_HOST_DIRECTORY}" \
  "${AQUARIUM_BACKUP_HOST_DIRECTORY}"; do
  case "${directory}" in /*) ;; *) printf 'Path is not absolute: %s\n' "${directory}" >&2; exit 1 ;; esac
  test -d "${directory}"
done
for directory in \
  "${AQUARIUM_STATE_HOST_DIRECTORY}" \
  "${AQUARIUM_EVENTS_HOST_DIRECTORY}" \
  "${AQUARIUM_ARCHIVE_HOST_DIRECTORY}" \
  "${AQUARIUM_BACKUP_HOST_DIRECTORY}"; do
  first_entry="$(find "${directory}" -mindepth 1 -print -quit)"
  test -z "${first_entry}"
done
test -d "$(dirname "${AQUARIUM_CUTOVER_EVIDENCE_ROOT}")"
test ! -e "${AQUARIUM_CUTOVER_EVIDENCE_ROOT}"
test ! -L "${AQUARIUM_CUTOVER_EVIDENCE_ROOT}"
sudo mkdir --mode=0700 "${AQUARIUM_CUTOVER_EVIDENCE_ROOT}"
sudo chown 1000:1000 "${AQUARIUM_CUTOVER_EVIDENCE_ROOT}"
```

If the legacy process uses Docker, cron, or another supervisor, replace the
`systemctl` check with the equivalent stop-and-prove-inactive procedure and
record that evidence. Do not proceed merely because its HTTP page is down.

Copy the stopped raw source to the new evidence directory, reject symlinked
input, create a deterministic SHA-256 inventory, verify it, and then remove
write permission. This snapshot—not a fingerprint recorded for an older copy—is
the first-cutover rollback source:

```sh
legacy_snapshot="${AQUARIUM_CUTOVER_EVIDENCE_ROOT}/legacy-json"
legacy_manifest="${AQUARIUM_CUTOVER_EVIDENCE_ROOT}/legacy-json.sha256"
legacy_symlink="$(find "${AQUARIUM_LEGACY_DATA_DIRECTORY}" -type l -print -quit)"
if [ -n "${legacy_symlink}" ]; then
  printf 'Legacy source contains a symlink; cutover snapshot must be self-contained.\n' >&2
  exit 1
fi
mkdir --mode=0700 "${legacy_snapshot}"
rsync -a --no-owner --no-group -- \
  "${AQUARIUM_LEGACY_DATA_DIRECTORY}/" "${legacy_snapshot}/"
(
  cd "${legacy_snapshot}"
  find . -type f -print0 | LC_ALL=C sort --zero-terminated | \
    xargs --null --no-run-if-empty sha256sum
) >"${legacy_manifest}"
test -s "${legacy_manifest}"
(cd "${legacy_snapshot}" && sha256sum --check "${legacy_manifest}")
chmod -R a-w "${legacy_snapshot}"
chmod 0400 "${legacy_manifest}"
```

Analyze only that read-only snapshot with the exact release digest and no
network. Preserve the complete report, review every warning and normalized
count, and stop on any error. The historical fingerprint in repository
documentation describes only the snapshot analyzed there; it is not an expected
production constant.

```sh
image_reference="${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${AQUARIUM_CONTROLLER_IMAGE_SHA256}"
analysis_report="${AQUARIUM_CUTOVER_EVIDENCE_ROOT}/import-analysis.json"
test ! -e "${analysis_report}"
test ! -L "${analysis_report}"
(
  set -o noclobber
  docker run --rm --network none --read-only --user 1000:1000 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --mount "type=bind,src=${legacy_snapshot},dst=/legacy,readonly" \
    "${image_reference}" \
    node apps/controller/dist/infrastructure/import/legacy-import-cli.js \
    --source /legacy >"${analysis_report}"
)
jq --exit-status \
  '.valid == true and .canCommit == true and .errorCount == 0' \
  "${analysis_report}" >/dev/null
source_fingerprint="$(jq -er '.sourceFingerprint | select(test("^[0-9a-f]{64}$"))' "${analysis_report}")"
jq '{sourceFingerprint, normalizedCounts, warningCount, issues}' \
  "${analysis_report}"
chmod 0400 "${analysis_report}"
```

After the human review is recorded, verify the snapshot again. Atomically claim
the new state filename with Bash noclobber, then commit the same snapshot with
the exact image. The importer migrates `state.db` before its single import
transaction. A failed attempt is evidence: stop and choose new empty storage
paths instead of deleting or reusing it.

```sh
(cd "${legacy_snapshot}" && sha256sum --check "${legacy_manifest}")
state_database="${AQUARIUM_STATE_HOST_DIRECTORY}/state.db"
for suffix in '' -wal -shm -journal; do
  test ! -e "${state_database}${suffix}"
  test ! -L "${state_database}${suffix}"
done
(set -o noclobber; : >"${state_database}")
chmod 0600 "${state_database}"

commit_report="${AQUARIUM_CUTOVER_EVIDENCE_ROOT}/import-commit.json"
test ! -e "${commit_report}"
test ! -L "${commit_report}"
(
  set -o noclobber
  docker run --rm --network none --read-only --user 1000:1000 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --mount "type=bind,src=${legacy_snapshot},dst=/legacy,readonly" \
    --mount "type=bind,src=${AQUARIUM_STATE_HOST_DIRECTORY},dst=/target/state" \
    "${image_reference}" \
    node apps/controller/dist/infrastructure/import/legacy-import-cli.js \
    --source /legacy --commit --state-db /target/state/state.db \
    >"${commit_report}"
)
jq --exit-status --arg fingerprint "${source_fingerprint}" \
  '.committed == true and .report.sourceFingerprint == $fingerprint' \
  "${commit_report}" >/dev/null
chmod 0400 "${commit_report}"
```

Create and migrate `events.db` without starting the server or MQTT. The storage
command builds a temporary database, seeds retention policies, verifies it, and
publishes it with a non-replacing hard link; it refuses the target or any SQLite
sidecar if one already exists. Then check both databases with read-only mounts:

```sh
docker run --rm --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=${AQUARIUM_EVENTS_HOST_DIRECTORY},dst=/target/events" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js initialize-events \
  --events-db /target/events/events.db

docker run --rm --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=${AQUARIUM_STATE_HOST_DIRECTORY},dst=/target/state,readonly" \
  --mount "type=bind,src=${AQUARIUM_EVENTS_HOST_DIRECTORY},dst=/target/events,readonly" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js integrity \
  --state-db /target/state/state.db \
  --events-db /target/events/events.db
```

Finally, create and verify the schema-v2 database backup and the matching empty
or populated archive-set manifest before the controller has ever started. The
pending import outbox row is intentionally covered by the v2 coherence proof
and will be mirrored into `events.db` on first startup.

```sh
backup_result="$(docker run --rm --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=${AQUARIUM_STATE_HOST_DIRECTORY},dst=/target/state,readonly" \
  --mount "type=bind,src=${AQUARIUM_EVENTS_HOST_DIRECTORY},dst=/target/events" \
  --mount "type=bind,src=${AQUARIUM_BACKUP_HOST_DIRECTORY},dst=/target/backups" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js backup \
  --state-db /target/state/state.db \
  --events-db /target/events/events.db \
  --destination /target/backups)"
jq --exit-status '.details.manifest.schemaVersion == 2' \
  <<<"${backup_result}" >/dev/null
backup_manifest="$(printf '%s' "${backup_result}" | jq -er '.details.manifestFile')"
backup_directory="$(dirname "${backup_manifest}")"

verify_result="$(docker run --rm --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=${AQUARIUM_BACKUP_HOST_DIRECTORY},dst=/target/backups" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js verify-backup \
  --manifest "${backup_manifest}")"
jq --exit-status '.details.manifest.schemaVersion == 2' \
  <<<"${verify_result}" >/dev/null
docker run --rm --network none --read-only --user 1000:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=${AQUARIUM_BACKUP_HOST_DIRECTORY},dst=/target/backups" \
  --mount "type=bind,src=${AQUARIUM_ARCHIVE_HOST_DIRECTORY},dst=/target/archives,readonly" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js verify-archive-set \
  --events-db "${backup_directory}/events.db" \
  --archive-dir /target/archives \
  --output "${backup_directory}/archive-set-before-copy.json"
```

### 3B. Subsequent upgrade with existing SQLite data

Stop the controller so the events database and archive directory cannot change
during the copy. Create a verified online-format database backup with the exact
release image, then verify every complete archive against the backed-up events
database:

```sh
docker compose --file compose.production.yaml stop --timeout 60 controller

backup_result="$(docker compose --file compose.production.yaml run --rm --no-deps -T controller \
  node apps/controller/dist/storage-cli.js backup \
  --state-db /var/lib/aquarium/state/state.db \
  --events-db /var/lib/aquarium/events/events.db \
  --destination /var/lib/aquarium/backups)"
backup_manifest="$(printf '%s' "${backup_result}" | jq -er '.details.manifestFile')"
backup_directory="$(dirname "${backup_manifest}")"

docker compose --file compose.production.yaml run --rm --no-deps -T controller \
  node apps/controller/dist/storage-cli.js verify-backup \
  --manifest "${backup_manifest}"
docker compose --file compose.production.yaml run --rm --no-deps -T controller \
  node apps/controller/dist/storage-cli.js verify-archive-set \
  --events-db "${backup_directory}/events.db" \
  --archive-dir /var/lib/aquarium/archives \
  --output "${backup_directory}/archive-set-before-copy.json"
```

### 3C. Copy either recovery set off-host

Copy that whole backup directory and the archive directory to a new, empty
offsite or removable-media directory. Never merge it with a previous snapshot.
The example assumes the destination is already mounted and protected:

```sh
backup_name="$(basename "${backup_directory}")"
backup_host_directory="${AQUARIUM_BACKUP_HOST_DIRECTORY}/${backup_name}"
copy_root="/mnt/aquarium-offsite/${backup_name}"
test ! -e "${copy_root}"
test ! -L "${copy_root}"
sudo mkdir --mode=0700 "${copy_root}"
sudo chown 1000:1000 "${copy_root}"
install -d -m 0700 "${copy_root}/database-backup" "${copy_root}/archives"
rsync -a --numeric-ids "${backup_host_directory}/" "${copy_root}/database-backup/"
rsync -a --numeric-ids "${AQUARIUM_ARCHIVE_HOST_DIRECTORY}/" "${copy_root}/archives/"
```

Re-open the copied events database and re-read every copied archive with the
same exact image digest. The two deterministic manifests must be byte-identical:

```sh
image_reference="${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${AQUARIUM_CONTROLLER_IMAGE_SHA256}"
docker run --rm --user 1000:1000 \
  --mount "type=bind,src=${copy_root},dst=/copy" \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js verify-archive-set \
  --events-db /copy/database-backup/events.db \
  --archive-dir /copy/archives \
  --output /copy/archive-set-after-copy.json
cmp "${copy_root}/database-backup/archive-set-before-copy.json" \
  "${copy_root}/archive-set-after-copy.json"
```

Any backup, archive verification, transfer, or comparison failure stops the
deployment. Keep the matching database backup and archive snapshot together;
database backups do not contain `.ndjson.zst` archive payloads.

## 4. Start and verify the release

Start only the already rendered digest. Compose may check the registry again
because `pull_policy` is `always`, but it cannot select a mutable tag.

```sh
docker compose --file compose.production.yaml up \
  --detach --wait --wait-timeout 180 --no-build controller

probe_host="${AQUARIUM_HTTP_BIND_ADDRESS}"
if [ "${probe_host}" = "0.0.0.0" ]; then probe_host=127.0.0.1; fi
curl --fail --show-error --silent \
  "http://${probe_host}:${AQUARIUM_HTTP_PORT}/api/health/ready"

controller_id="$(docker compose --file compose.production.yaml ps --quiet controller)"
test "$(docker inspect --format '{{.Config.Image}}' "${controller_id}")" = \
  "${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${AQUARIUM_CONTROLLER_IMAGE_SHA256}"

docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js integrity \
  --state-db /var/lib/aquarium/state/state.db \
  --events-db /var/lib/aquarium/events/events.db
```

Confirm the snapshot and UI, the expected firmware version for every ESP32,
MQTT discovery, schedules, overrides, alert history, notification destination,
storage-health readings, and the latest verified backup. Treat readiness,
integrity, or an unexplained actuator state as a failed deployment.

## 5. Roll back without overwriting evidence

Stop the failed release. Do not start an older image against databases that a
newer release may have migrated. Create new empty rollback directories, restore
the verified pre-change database backup into them, copy the matching archive
snapshot into a new archive directory, and verify the restored archive set.

```sh
docker compose --file compose.production.yaml stop --timeout 60 controller
sudo install -d -o 1000 -g 1000 -m 0700 \
  /srv/aquarium/rollback-state \
  /srv/aquarium/rollback-events \
  /srv/aquarium/rollback-archives \
  /srv/aquarium/rollback-backups

docker run --rm --user 1000:1000 \
  --mount "type=bind,src=${copy_root}/database-backup,dst=/backup,readonly" \
  --mount type=bind,src=/srv/aquarium/rollback-state,dst=/restore/state \
  --mount type=bind,src=/srv/aquarium/rollback-events,dst=/restore/events \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js restore \
  --manifest /backup/manifest.json \
  --state-db /restore/state/state.db \
  --events-db /restore/events/events.db
rsync -a --numeric-ids "${copy_root}/archives/" /srv/aquarium/rollback-archives/

docker run --rm --user 1000:1000 \
  --mount type=bind,src=/srv/aquarium/rollback-events,dst=/events,readonly \
  --mount type=bind,src=/srv/aquarium/rollback-archives,dst=/archives,readonly \
  --mount type=bind,src=/srv/aquarium/rollback-backups,dst=/output \
  "${image_reference}" \
  node apps/controller/dist/storage-cli.js verify-archive-set \
  --events-db /events/events.db \
  --archive-dir /archives \
  --output /output/restored-archive-set.json
cmp "${copy_root}/database-backup/archive-set-before-copy.json" \
  /srv/aquarium/rollback-backups/restored-archive-set.json
```

Set the four `AQUARIUM_*_HOST_DIRECTORY` variables to these new rollback paths
and set `AQUARIUM_CONTROLLER_IMAGE_SHA256` to the recorded prior digest. Run the
preflight again, then repeat the start, readiness, exact-image, integrity, and
functional checks. Keep the failed release's directories unchanged until the
incident is understood; do not delete them as part of rollback.
