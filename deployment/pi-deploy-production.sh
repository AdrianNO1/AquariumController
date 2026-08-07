#!/usr/bin/env bash

set -Eeuo pipefail

readonly release_commit="${1:?Pass the exact merged release commit}"
readonly image_digest="${2:?Pass the exact published image digest without sha256:}"
readonly checkout=/home/adrian/AquariumController-v2
readonly configuration_file=/etc/aquarium-controller/production.conf
readonly configuration_backup=/etc/aquarium-controller/production.conf.pre-update
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ "${release_commit}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'Release commit must be a full lowercase SHA-1.\n' >&2
  exit 1
}
[[ "${image_digest}" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Image digest must be 64 lowercase hexadecimal characters.\n' >&2
  exit 1
}

sudo -n test -r "${configuration_file}"
test ! -e "${configuration_backup}"

set -a
# shellcheck disable=SC1090
source <(sudo -n cat -- "${configuration_file}")
set +a
export COMPOSE_DISABLE_ENV_FILE=1
unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE

readonly previous_commit="$(git -C "${checkout}" rev-parse HEAD)"
readonly previous_digest="${AQUARIUM_CONTROLLER_IMAGE_SHA256}"
bash "${script_directory}/pi-verify-production.sh" "${previous_commit}" "${previous_digest}" >/dev/null

if [[ "${release_commit}" == "${previous_commit}" && "${image_digest}" == "${previous_digest}" ]]; then
  printf 'CONTROLLER_ALREADY_CURRENT\n'
  printf 'RELEASE_COMMIT=%s\n' "${release_commit}"
  printf 'IMAGE_REFERENCE=%s@sha256:%s\n' "${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}" "${image_digest}"
  exit 0
fi

git -C "${checkout}" fetch --no-tags origin "${release_commit}"
git -C "${checkout}" cat-file -e "${release_commit}^{commit}"

sudo -n install --owner=root --group=root --mode=0600 \
  "${configuration_file}" "${configuration_backup}"
rollback_needed=true
rollback() {
  local original_status=$?
  local rollback_status=0
  trap - ERR HUP INT TERM
  set +e
  if [[ "${rollback_needed}" == true ]]; then
    printf 'Deployment failed; restoring the prior checkout, configuration, and image.\n' >&2
    sudo -n install --owner=root --group=root --mode=0600 \
      "${configuration_backup}" "${configuration_file}" || rollback_status=1
    git -C "${checkout}" checkout --detach "${previous_commit}" || rollback_status=1

    set -a
    # shellcheck disable=SC1090
    source <(sudo -n cat -- "${configuration_file}") || rollback_status=1
    set +a
    export COMPOSE_DISABLE_ENV_FILE=1
    unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
    unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
    unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
    unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE

    docker compose --file "${checkout}/compose.production.yaml" up \
      --detach --wait --wait-timeout 180 --no-build --no-deps controller || rollback_status=1
    bash "${script_directory}/pi-verify-production.sh" \
      "${previous_commit}" "${previous_digest}" || rollback_status=1
    if [[ "${rollback_status}" -eq 0 ]]; then
      sudo -n rm -f "${configuration_backup}"
      printf 'ROLLBACK_COMPLETE\n' >&2
    else
      printf 'AUTOMATIC_ROLLBACK_FAILED; manual recovery is required.\n' >&2
    fi
  fi
  if [[ "${original_status}" -eq 0 ]]; then
    original_status=1
  fi
  exit "${original_status}"
}
trap rollback ERR HUP INT TERM

git -C "${checkout}" checkout --detach "${release_commit}"
test "$(git -C "${checkout}" rev-parse HEAD)" = "${release_commit}"
test -z "$(git -C "${checkout}" status --porcelain)"

sudo -n sed -i \
  "s/^AQUARIUM_CONTROLLER_IMAGE_SHA256=.*/AQUARIUM_CONTROLLER_IMAGE_SHA256=${image_digest}/" \
  "${configuration_file}"
grep -Fx "AQUARIUM_CONTROLLER_IMAGE_SHA256=${image_digest}" "${configuration_file}" >/dev/null

set -a
# shellcheck disable=SC1090
source <(sudo -n cat -- "${configuration_file}")
set +a
export COMPOSE_DISABLE_ENV_FILE=1
unset AQUARIUM_ALERT_WEBHOOK_URL AQUARIUM_ALERT_WEBHOOK_KEY
unset AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
unset AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE

cd "${checkout}"
bash deployment/pi-preflight.sh compose.production.yaml
readonly image_reference="${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${image_digest}"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_reference}")" = "${release_commit}"

docker compose --file compose.production.yaml up \
  --detach --wait --wait-timeout 180 --no-build --no-deps controller
bash "${script_directory}/pi-verify-production.sh" "${release_commit}" "${image_digest}"

rollback_needed=false
trap - ERR HUP INT TERM
sudo -n rm -f "${configuration_backup}"
printf 'CONTROLLER_UPDATE_COMPLETE\n'
printf 'RELEASE_COMMIT=%s\n' "${release_commit}"
printf 'IMAGE_REFERENCE=%s\n' "${image_reference}"
