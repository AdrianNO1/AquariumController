#!/usr/bin/env bash

set -Eeuo pipefail

# Ignore any implicit repository .env file. Deployment inputs must come from
# the explicitly prepared operator shell.
export COMPOSE_DISABLE_ENV_FILE=1

readonly compose_file="${1:-compose.production.yaml}"
readonly minimum_free_bytes="${AQUARIUM_PREFLIGHT_MIN_FREE_BYTES:-10737418240}"

required_commands=(docker stat df awk curl jq rsync cmp readlink)
for command_name in "${required_commands[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "${command_name}" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required.\n' >&2
  exit 1
fi

docker_server_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
if [[ "${docker_server_platform}" != "linux/arm64" ]]; then
  printf 'The production Pi requires a 64-bit Linux/ARM64 Docker engine; found %s.\n' "${docker_server_platform}" >&2
  exit 1
fi

if [[ ! -f "${compose_file}" ]]; then
  printf 'Compose file does not exist: %s\n' "${compose_file}" >&2
  exit 1
fi

required_variables=(
  AQUARIUM_CONTROLLER_IMAGE_REPOSITORY
  AQUARIUM_CONTROLLER_IMAGE_SHA256
  AQUARIUM_HTTP_BIND_ADDRESS
  AQUARIUM_HTTP_PORT
  AQUARIUM_MQTT_BROKER_URL
  AQUARIUM_PRODUCTION_MQTT_CONFIRMATION
  AQUARIUM_STATE_HOST_DIRECTORY
  AQUARIUM_EVENTS_HOST_DIRECTORY
  AQUARIUM_ARCHIVE_HOST_DIRECTORY
  AQUARIUM_BACKUP_HOST_DIRECTORY
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name-}" ]]; then
    printf 'Required environment variable is unset or empty: %s\n' "${variable_name}" >&2
    exit 1
  fi
done

if [[ ! "${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}" =~ ^ghcr\.io/[a-z0-9]+([._-][a-z0-9]+)*/[a-z0-9]+([._/-][a-z0-9]+)*$ ]]; then
  printf 'AQUARIUM_CONTROLLER_IMAGE_REPOSITORY must be a lowercase GHCR repository without a tag or digest.\n' >&2
  exit 1
fi

if [[ ! "${AQUARIUM_CONTROLLER_IMAGE_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'AQUARIUM_CONTROLLER_IMAGE_SHA256 must contain exactly 64 lowercase hexadecimal characters.\n' >&2
  exit 1
fi

if [[ "${AQUARIUM_PRODUCTION_MQTT_CONFIRMATION}" != "ENABLE_PRODUCTION_AQUARIUM_MQTT" ]]; then
  printf 'AQUARIUM_PRODUCTION_MQTT_CONFIRMATION does not contain the required production interlock.\n' >&2
  exit 1
fi

webhook_url="${AQUARIUM_ALERT_WEBHOOK_URL-}"
webhook_key="${AQUARIUM_ALERT_WEBHOOK_KEY-}"
webhook_timeout="${AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS-}"
webhook_header_name="${AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME-}"
webhook_header_value="${AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE-}"

optional_webhook_variables=(
  AQUARIUM_ALERT_WEBHOOK_URL
  AQUARIUM_ALERT_WEBHOOK_KEY
  AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS
  AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME
  AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE
)
for variable_name in "${optional_webhook_variables[@]}"; do
  if [[ -v "${variable_name}" && -z "${!variable_name}" ]]; then
    printf '%s is exported as an empty string; unset it when the option is not configured.\n' "${variable_name}" >&2
    exit 1
  fi
done

if [[ -z "${webhook_url}" && ( -n "${webhook_key}" || -n "${webhook_timeout}" || -n "${webhook_header_name}" || -n "${webhook_header_value}" ) ]]; then
  printf 'Alert webhook options require AQUARIUM_ALERT_WEBHOOK_URL.\n' >&2
  exit 1
fi

if [[ ( -n "${webhook_header_name}" && -z "${webhook_header_value}" ) || ( -z "${webhook_header_name}" && -n "${webhook_header_value}" ) ]]; then
  printf 'Alert webhook authentication header name and value must be supplied together.\n' >&2
  exit 1
fi

if [[ ! "${minimum_free_bytes}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'AQUARIUM_PREFLIGHT_MIN_FREE_BYTES must be a positive integer.\n' >&2
  exit 1
fi

directory_variables=(
  AQUARIUM_STATE_HOST_DIRECTORY
  AQUARIUM_EVENTS_HOST_DIRECTORY
  AQUARIUM_ARCHIVE_HOST_DIRECTORY
  AQUARIUM_BACKUP_HOST_DIRECTORY
)
resolved_directories=()

for variable_name in "${directory_variables[@]}"; do
  directory="${!variable_name}"
  if [[ "${directory}" != /* ]]; then
    printf '%s must be an absolute path: %s\n' "${variable_name}" "${directory}" >&2
    exit 1
  fi
  if [[ ! -d "${directory}" ]]; then
    printf '%s is not an existing directory: %s\n' "${variable_name}" "${directory}" >&2
    exit 1
  fi

  owner_uid="$(stat --format '%u' -- "${directory}")"
  owner_gid="$(stat --format '%g' -- "${directory}")"
  mode="$(stat --format '%a' -- "${directory}")"
  if [[ "${owner_uid}:${owner_gid}" != "1000:1000" ]]; then
    printf '%s must be owned by UID/GID 1000:1000; found %s:%s for %s\n' "${variable_name}" "${owner_uid}" "${owner_gid}" "${directory}" >&2
    exit 1
  fi
  if [[ "${mode}" != "700" ]]; then
    printf '%s must have mode 0700; found %s for %s\n' "${variable_name}" "${mode}" "${directory}" >&2
    exit 1
  fi

  available_bytes="$(df --block-size=1 --output=avail -- "${directory}" | awk 'NR == 2 { print $1 }')"
  if [[ ! "${available_bytes}" =~ ^[0-9]+$ ]]; then
    printf 'Could not determine available bytes for %s.\n' "${directory}" >&2
    exit 1
  fi
  if (( available_bytes < minimum_free_bytes )); then
    printf '%s has %s available bytes; at least %s are required.\n' "${directory}" "${available_bytes}" "${minimum_free_bytes}" >&2
    exit 1
  fi

  resolved_directory="$(readlink --canonicalize -- "${directory}")"
  for other_directory in "${resolved_directories[@]}"; do
    if [[ "${resolved_directory}" == "${other_directory}" ]]; then
      printf 'Production storage bind directories must be distinct; %s resolves to %s more than once.\n' "${directory}" "${resolved_directory}" >&2
      exit 1
    fi
    if [[ "${resolved_directory}" == "${other_directory}/"* || "${other_directory}" == "${resolved_directory}/"* ]]; then
      printf 'Production storage bind directories must not be nested: %s and %s.\n' "${resolved_directory}" "${other_directory}" >&2
      exit 1
    fi
  done
  resolved_directories+=("${resolved_directory}")
done

docker compose --file "${compose_file}" config --quiet

readonly expected_image="${AQUARIUM_CONTROLLER_IMAGE_REPOSITORY}@sha256:${AQUARIUM_CONTROLLER_IMAGE_SHA256}"
rendered_images="$(docker compose --file "${compose_file}" config --images)"
if [[ "${rendered_images}" != "${expected_image}" ]]; then
  printf 'Rendered Compose image does not equal the expected immutable digest reference.\n' >&2
  exit 1
fi

printf 'Configuration, storage ownership/modes, and free-space checks passed.\n'
printf 'Pulling the exact rendered image digest for this host architecture...\n'
docker pull "${expected_image}"
docker image inspect "${expected_image}" >/dev/null
docker compose --file "${compose_file}" run --rm --no-deps --pull never -T controller \
  node --input-type=module --eval \
  "import { parseControllerConfiguration } from './apps/controller/dist/configuration.js'; parseControllerConfiguration(process.env);"
printf 'Preflight passed for %s. No service was started.\n' "${expected_image}"
