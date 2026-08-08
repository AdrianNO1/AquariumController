import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseBackupResult,
  parsePiCredentials,
  parsePublishedImageReference,
  selectPublisherJob,
  selectSuccessfulMasterRun,
} from "./production-deploy.mjs";

const commit = "1".repeat(40);
const digest = "a".repeat(64);

test("selects only a successful completed CI run for the exact commit", () => {
  const selected = selectSuccessfulMasterRun(
    [
      { databaseId: 1, headSha: commit, status: "completed", conclusion: "failure" },
      { databaseId: 2, headSha: "a".repeat(40), status: "completed", conclusion: "success" },
      { databaseId: 3, headSha: commit, status: "completed", conclusion: "success" },
    ],
    commit,
  );
  assert.equal(selected.databaseId, 3);
});

test("requires the successful image publisher job", () => {
  const selected = selectPublisherJob({
    jobs: [
      {
        databaseId: 42,
        name: "Publish and verify multi-architecture image",
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  assert.equal(selected.databaseId, 42);
  assert.throws(
    () =>
      selectPublisherJob({
        jobs: [
          {
            databaseId: 42,
            name: "Publish and verify multi-architecture image",
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    /did not complete successfully/,
  );
});

test("extracts only the expected immutable GHCR image", () => {
  assert.deepEqual(
    parsePublishedImageReference(
      `Published immutable image: ghcr.io/adrianno1/aquarium-controller@sha256:${digest}`,
    ),
    {
      reference: `ghcr.io/adrianno1/aquarium-controller@sha256:${digest}`,
      digest,
    },
  );
  assert.throws(
    () =>
      parsePublishedImageReference(`Published immutable image: ghcr.io/example/wrong@sha256:${digest}`),
    /unexpected image repository/,
  );
});

test("validates Pi credentials without requiring a stored password", () => {
  assert.deepEqual(parsePiCredentials('{"host":"192.168.1.73","username":"adrian"}'), {
    host: "192.168.1.73",
    username: "adrian",
    password: undefined,
  });
  assert.throws(
    () => parsePiCredentials('{"host":"192.168.1.73; shutdown","username":"adrian"}'),
    /unsupported characters/,
  );
});

test("accepts only a completed backup with a safe path and digest", () => {
  assert.deepEqual(
    parseBackupResult(
      `LIVE_BACKUP_COMPLETE\nBUNDLE=/home/adrian/aquarium-production-backup-2026-08-06T01-02-03.000Z.tar.gz\nBUNDLE_SHA256=${digest}\n`,
      "adrian",
    ),
    {
      bundle: "/home/adrian/aquarium-production-backup-2026-08-06T01-02-03.000Z.tar.gz",
      sha256: digest,
    },
  );
  assert.throws(
    () => parseBackupResult(`LIVE_BACKUP_COMPLETE\nBUNDLE=/etc/passwd\nBUNDLE_SHA256=${digest}`, "adrian"),
    /unsafe bundle path/,
  );
});

test("backs up the verified currently running release before an upgrade", () => {
  const script = readFileSync(
    new URL("../deployment/pi-backup-production.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /current_commit=.*git -C .* rev-parse HEAD/);
  assert.match(
    script,
    /current_digest=.*AQUARIUM_CONTROLLER_IMAGE_SHA256/,
  );
  assert.match(
    script,
    /pi-verify-production\.sh.*\\\n\s+"\$\{current_commit\}" "\$\{current_digest\}"/,
  );
  assert.doesNotMatch(script, /release_commit|image_digest/);
});

test("deployment scripts read the root-owned production configuration through sudo", () => {
  for (const fileName of [
    "pi-backup-production.sh",
    "pi-deploy-production.sh",
    "pi-verify-production.sh",
  ]) {
    const script = readFileSync(
      new URL(`../deployment/${fileName}`, import.meta.url),
      "utf8",
    );
    assert.match(script, /sudo -n test -r "\$\{configuration_file\}"/);
    assert.match(
      script,
      /source <\(sudo -n cat -- "\$\{configuration_file\}"\)/,
    );
    assert.doesNotMatch(script, /source "\$\{configuration_file\}"/);
  }
});

test("the digest update handles shell-export formats without direct protected reads", () => {
  const script = readFileSync(
    new URL("../deployment/pi-deploy-production.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /sudo -n grep -Ec \\\n\s+'\^\(declare -x \|export \)\?AQUARIUM_CONTROLLER_IMAGE_SHA256='/,
  );
  assert.match(
    script,
    /sudo -n sed -i -E \\\n\s+"s\/\^\(declare -x \|export \)\?AQUARIUM_CONTROLLER_IMAGE_SHA256=/,
  );
  assert.match(
    script,
    /test "\$\{AQUARIUM_CONTROLLER_IMAGE_SHA256\}" = "\$\{image_digest\}"/,
  );
  assert.doesNotMatch(script, /^grep .*"\$\{configuration_file\}"/m);
});
