import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import mqtt from "mqtt";

const [configPath, namespace, artifactPath, artifactVersion, artifactUrl] =
  process.argv.slice(2);
if (
  configPath === undefined ||
  namespace === undefined ||
  artifactPath === undefined ||
  artifactVersion === undefined ||
  artifactUrl === undefined
) {
  throw new Error(
    "Usage: node tools/ota-test-firmware.mjs <firmware-config.h> <namespace> <artifact> <version> <url>",
  );
}

const configText = await readFile(configPath, "utf8");
const artifact = await readFile(artifactPath);
const artifactSha256 = createHash("sha256").update(artifact).digest("hex");

function readStringConstant(name) {
  const match = new RegExp(
    `const\\s+char\\*\\s+(?:const\\s+)?${name}\\s*=\\s*"([^"]*)"\\s*;`,
    "u",
  ).exec(configText);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${name} in ${configPath}`);
  }
  return match[1];
}

function readIntegerConstant(name) {
  const match = new RegExp(
    `const\\s+int\\s+${name}\\s*=\\s*(\\d+)\\s*;`,
    "u",
  ).exec(configText);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${name} in ${configPath}`);
  }
  return Number.parseInt(match[1], 10);
}

const host = readStringConstant("mqtt_server");
const port = readIntegerConstant("mqtt_port");
const username = readStringConstant("mqtt_username");
const password = readStringConstant("mqtt_password");
const topic = (suffix) => `${namespace}/${suffix}`;
const client = mqtt.connect(`mqtt://${host}:${port}`, {
  username,
  password,
  reconnectPeriod: 1_000,
  connectTimeout: 5_000,
  protocolVersion: 4,
});

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function publish(payload) {
  return new Promise((resolve, reject) => {
    client.publish(topic("command"), payload, { qos: 0 }, (error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

await new Promise((resolve, reject) => {
  client.once("connect", resolve);
  client.once("error", reject);
});
await client.subscribeAsync([topic("announce"), topic("response")], { qos: 0 });

const announcements = [];
const responses = [];
client.on("message", (receivedTopic, payload) => {
  try {
    const value = JSON.parse(payload.toString("utf8"));
    if (receivedTopic === topic("announce")) {
      announcements.push(value);
    } else if (receivedTopic === topic("response")) {
      responses.push(value);
    }
  } catch {
    // Ignore unrelated legacy traffic while observing this one update.
  }
});

await publish("discover");
await wait(2_000);
const devices = new Map(
  announcements
    .filter(
      (announcement) =>
        typeof announcement.id === "string" &&
        typeof announcement.version === "string",
    )
    .map((announcement) => [announcement.id, announcement]),
);
if (devices.size !== 1) {
  throw new Error(
    `Expected exactly one physical test ESP on ${namespace}; discovered ${devices.size}`,
  );
}
const device = [...devices.values()][0];
if (device.version === artifactVersion) {
  throw new Error(`${device.name} already runs firmware ${artifactVersion}`);
}

const requestId = `ota-test-${Date.now()}`;
const command = [
  `${device.id} ota`,
  artifactVersion,
  artifact.length,
  artifactSha256,
  artifactUrl,
].join(" ");
console.log(
  `Updating ${device.name} (${device.id}) from ${device.version} to ${artifactVersion}`,
);
announcements.length = 0;
responses.length = 0;
await publish(`request:${requestId}|${command}`);

const deadline = Date.now() + 120_000;
let accepted = false;
let lastProgress = "";
let announcementCursor = 0;
let observedCurrentAttempt = false;
while (Date.now() < deadline) {
  const response = responses.find((value) => value.requestId === requestId);
  const responseValue = response?.responses?.[0]?.response;
  if (responseValue?.startsWith("E:")) {
    throw new Error(`ESP rejected OTA request: ${responseValue}`);
  }
  if (responseValue === "ota_accepted") {
    accepted = true;
  }

  const newAnnouncements = announcements.slice(announcementCursor);
  announcementCursor = announcements.length;
  for (const latest of newAnnouncements) {
    if (latest.id !== device.id || latest.ota === undefined) {
      continue;
    }
    const progress = `${latest.version} ${latest.ota.status} ${latest.ota.progress}%`;
    if (progress !== lastProgress) {
      console.log(progress);
      lastProgress = progress;
    }
    if (
      latest.ota.targetVersion === artifactVersion &&
      [
        "accepted",
        "downloading",
        "verifying",
        "rebooting",
        "probation",
      ].includes(latest.ota.status)
    ) {
      observedCurrentAttempt = true;
    }
    if (
      latest.version === artifactVersion &&
      latest.ota.status === "succeeded"
    ) {
      console.log("OTA update and probation succeeded");
      await client.endAsync();
      process.exit(0);
    }
    if (latest.ota.status === "failed" && observedCurrentAttempt) {
      throw new Error(`ESP reported OTA failure: ${latest.ota.error}`);
    }
  }
  await wait(250);
}

throw new Error(
  accepted
    ? "ESP accepted OTA but did not complete probation within 120 seconds"
    : "ESP did not acknowledge the OTA request",
);
