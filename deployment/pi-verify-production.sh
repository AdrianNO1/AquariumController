#!/usr/bin/env bash

set -Eeuo pipefail

readonly release_commit="${1:?Pass the exact deployed commit}"
readonly image_digest="${2:?Pass the exact deployed image digest without sha256:}"
readonly checkout=/home/adrian/AquariumController-v2
readonly configuration_file=/etc/aquarium-controller/production.conf

[[ "${release_commit}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Release commit must be a full lowercase SHA-1.\n' >&2
  exit 1
}
[[ "${image_digest}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Image digest must be 64 lowercase hexadecimal characters.\n' >&2
  exit 1
}

sudo -n test -r "${configuration_file}"
systemctl is-active --quiet docker.service
systemctl is-enabled --quiet docker.service
systemctl is-active --quiet mosquitto.service
systemctl is-enabled --quiet mosquitto.service
if systemctl is-active --quiet aqcontroller.service; then
  printf 'The legacy aqcontroller.service is active.\n' >&2
  exit 1
fi
if systemctl is-enabled --quiet aqcontroller.service; then
  printf 'The legacy aqcontroller.service is still enabled.\n' >&2
  exit 1
fi
if pgrep -f 'python(3)?[[:space:]]+([^[:space:]]+[[:space:]]+)*([^[:space:]]*/)?app\.py([[:space:]]|$)' >/dev/null; then
  printf 'A legacy app.py process is running.\n' >&2
  exit 1
fi

test "$(git -C "${checkout}" rev-parse HEAD)" = "${release_commit}"
test -z "$(git -C "${checkout}" status --porcelain)"

set -a
# shellcheck disable=SC1090
source <(sudo -n cat -- "${configuration_file}")
set +a
export COMPOSE_DISABLE_ENV_FILE=1
unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE

test "${AQUARIUM_CONTROLLER_IMAGE_SHA256}" = "${image_digest}"
readonly image_reference="${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${image_digest}"

cd "${checkout}"
mapfile -t controller_ids < <(
  docker compose --file compose.production.yaml ps --status running --quiet controller
)
test "${#controller_ids[@]}" -eq 1
readonly controller_id="${controller_ids[0]}"
test "$(docker inspect --format '{{.State.Health.Status}}' "${controller_id}")" = healthy
test "$(docker inspect --format '{{.Config.Image}}' "${controller_id}")" = "${image_reference}"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_reference}")" = "${release_commit}"

docker inspect "${controller_id}" | jq --exit-status '
  .[0].Config.User == "1000:1000" and
  .[0].HostConfig.ReadonlyRootfs == true and
  .[0].HostConfig.Memory == 805306368 and
  .[0].HostConfig.NanoCpus == 1500000000 and
  .[0].HostConfig.PidsLimit == 256 and
  .[0].HostConfig.CapDrop == ["ALL"] and
  .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
  (.[0].HostConfig.SecurityOpt | index("no-new-privileges:true") != null) and
  (.[0].NetworkSettings.Networks["aquarium-controller-host"] != null)
' >/dev/null

health_host="${AQUARIUM_HTTP_BIND_ADDRESS}"
if [[ "${health_host}" == "0.0.0.0" ]]; then
  health_host=127.0.0.1
fi
curl --fail --show-error --silent \
  "http://${health_host}:${AQUARIUM_HTTP_PORT}/api/health/ready" |
  jq --exit-status '.status == "ok"' >/dev/null

docker compose --file compose.production.yaml exec -T controller \
  node apps/controller/dist/storage-cli.js integrity \
  --state-db /var/lib/aquarium/state/state.db \
  --events-db /var/lib/aquarium/events/events.db >/dev/null

printf 'PRODUCTION_VERIFICATION_COMPLETE\n'
printf 'RELEASE_COMMIT=%s\n' "${release_commit}"
printf 'IMAGE_REFERENCE=%s\n' "${image_reference}"
