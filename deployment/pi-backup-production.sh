#!/usr/bin/env bash

set -Eeuo pipefail

readonly checkout=/home/adrian/AquariumController-v2
readonly configuration_file=/etc/aquarium-controller/production.conf
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

sudo -n test -r "${configuration_file}"
set -a
# shellcheck disable=SC1090
source <(sudo -n cat -- "${configuration_file}")
set +a
export COMPOSE_DISABLE_ENV_FILE=1
unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE

readonly current_commit="$(git -C "${checkout}" rev-parse HEAD)"
readonly current_digest="${AQUARIUM_CONTROLLER_IMAGE_SHA256:?}"
[[ "${current_commit}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Current checkout commit must be a full lowercase SHA-1.\n' >&2
  exit 1
}
[[ "${current_digest}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Current image digest must be 64 lowercase hexadecimal characters.\n' >&2
  exit 1
}

bash "${script_directory}/pi-verify-production.sh" \
  "${current_commit}" "${current_digest}" >/dev/null

cd "${checkout}"
backup_result="$(docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js backup \
  --state-db /var/lib/aquarium/state/state.db \
  --events-db /var/lib/aquarium/events/events.db \
  --destination /var/lib/aquarium/backups)"
jq --exit-status '.details.manifest.schemaVersion == 2' <<<"${backup_result}" >/dev/null
backup_manifest="$(jq -er '.details.manifestFile' <<<"${backup_result}")"
backup_directory="$(dirname -- "${backup_manifest}")"
backup_name="$(basename -- "${backup_directory}")"
backup_host_directory="${AQUARIUM_BACKUP_HOST_DIRECTORY}/${backup_name}"

docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js verify-backup \
  --manifest "${backup_manifest}" >/dev/null

events_hash_before="$(sha256sum "${backup_host_directory}/events.db" | awk '{print $1}')"
docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js verify-archive-set \
  --events-db "${backup_directory}/events.db" \
  --archive-dir /var/lib/aquarium/archives \
  --output "${backup_directory}/archive-set-live.json" >/dev/null
events_hash_after="$(sha256sum "${backup_host_directory}/events.db" | awk '{print $1}')"
test "${events_hash_after}" = "${events_hash_before}"
test ! -e "${backup_host_directory}/events.db-wal"
test ! -e "${backup_host_directory}/events.db-shm"
test ! -e "${backup_host_directory}/events.db-journal"

docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js verify-backup \
  --manifest "${backup_manifest}" >/dev/null
docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js integrity \
  --state-db /var/lib/aquarium/state/state.db \
  --events-db /var/lib/aquarium/events/events.db >/dev/null

bundle="/home/$(id -un)/aquarium-production-${backup_name}.tar.gz"
test ! -e "${bundle}"
tar --create --gzip --file "${bundle}" \
  --directory /srv/aquarium "backups/${backup_name}" archives
chmod 0600 "${bundle}"

printf 'LIVE_BACKUP_COMPLETE\n'
printf 'BACKUP_NAME=%s\n' "${backup_name}"
printf 'BACKUP_HOST_DIRECTORY=%s\n' "${backup_host_directory}"
printf 'BUNDLE=%s\n' "${bundle}"
printf 'BUNDLE_SHA256='
sha256sum "${bundle}" | awk '{print $1}'
