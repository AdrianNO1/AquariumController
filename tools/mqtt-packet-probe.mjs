import { readFile } from "node:fs/promises";

import mqtt from "mqtt";

const configPath = process.argv[2];
const namespace = process.argv[3] ?? "aquarium";
const requestedDeviceId = process.argv[4];

if (configPath === undefined) {
  throw new Error(
    "Usage: node tools/mqtt-packet-probe.mjs <firmware-config.h> [namespace] [device-id]",
  );
}

const configText = await readFile(configPath, "utf8");

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
  reconnectPeriod: 0,
  connectTimeout: 5_000,
  protocolVersion: 4,
});

const announcements = new Map();
const responseWaiters = new Map();

client.on("message", (receivedTopic, payload) => {
  if (receivedTopic === topic("announce")) {
    try {
      const announcement = JSON.parse(payload.toString("utf8"));
      if (typeof announcement.id === "string") {
        announcements.set(announcement.id, announcement);
      }
    } catch {
      // Ignore unrelated malformed traffic during this narrow diagnostic.
    }
    return;
  }
  if (receivedTopic !== topic("response")) {
    return;
  }
  try {
    const response = JSON.parse(payload.toString("utf8"));
    if (typeof response.requestId === "string") {
      responseWaiters.get(response.requestId)?.(response);
    }
  } catch {
    // Legacy uncorrelated traffic is not part of this probe.
  }
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

function awaitResponse(requestId, timeoutMilliseconds = 2_500) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      responseWaiters.delete(requestId);
      resolve(undefined);
    }, timeoutMilliseconds);
    responseWaiters.set(requestId, (response) => {
      clearTimeout(timeout);
      responseWaiters.delete(requestId);
      resolve(response);
    });
  });
}

await new Promise((resolve, reject) => {
  client.once("connect", resolve);
  client.once("error", reject);
});
await client.subscribeAsync([topic("announce"), topic("response")], { qos: 0 });
await publish("discover");
await wait(2_000);

const devices = [...announcements.values()];
const device = requestedDeviceId
  ? announcements.get(requestedDeviceId)
  : devices[0];
if (device === undefined) {
  throw new Error(
    requestedDeviceId
      ? `Device ${requestedDeviceId} did not announce on ${namespace}`
      : `No devices announced on ${namespace}`,
  );
}

console.log(
  `Probing ${device.name} (${device.id}), firmware ${device.version}, via ${namespace}/command`,
);

for (const size of [
  256, 512, 1_000, 1_500, 1_900, 2_000, 2_020, 2_048, 4_095, 5_120, 5_121,
]) {
  const requestId = `packet-probe-${size}`;
  const prefix = `request:${requestId}|${device.id} p`;
  if (prefix.length > size) {
    throw new Error(`Probe prefix exceeds requested payload size ${size}`);
  }
  const payload = prefix.padEnd(size, " ");
  const responsePromise = awaitResponse(requestId);
  await publish(payload);
  const response = await responsePromise;
  const accepted = response?.responses?.some(
    (item) => item?.index === 0 && item?.response === "o",
  );
  console.log(`${size} bytes: ${accepted ? "accepted" : "no response"}`);
}

await client.endAsync();
