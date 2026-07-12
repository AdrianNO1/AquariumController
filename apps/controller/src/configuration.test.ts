import { describe, expect, it } from "vitest";

import { parseControllerConfiguration } from "./configuration.js";

describe("controller configuration safety", () => {
  it("keeps MQTT disabled by default", () => {
    expect(parseControllerConfiguration({})).toMatchObject({
      runtimeMode: "development",
      server: { host: "127.0.0.1", port: 3001 },
      mqtt: { enabled: false },
      storage: {
        stateDatabaseFile: expect.stringMatching(/[\\/]\.data[\\/]state\.db$/),
        eventsDatabaseFile: expect.stringMatching(
          /[\\/]\.data[\\/]events\.db$/,
        ),
        archiveDirectory: expect.stringMatching(/[\\/]\.data[\\/]archives$/),
        backupDirectory: expect.stringMatching(/[\\/]\.data[\\/]backups$/),
      },
    });
  });

  it("allows explicit test topics against loopback", () => {
    expect(
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://127.0.0.1:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        NODE_ENV: "test",
      }).mqtt,
    ).toEqual({
      enabled: true,
      brokerUrl: "mqtt://127.0.0.1:1883",
      topicNamespace: "test",
      protocolVersion: 4,
      qos: 0,
      retain: false,
    });
  });

  it("rejects non-MQTT URL schemes", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "http://127.0.0.1:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        NODE_ENV: "test",
      }),
    ).toThrow(/mqtt:\/\/ or mqtts:\/\//i);
  });

  it("allows only an explicitly named test Docker broker off loopback", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://mosquitto:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        NODE_ENV: "test",
      }),
    ).toThrow(/loopback|Docker host/);

    expect(
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://mosquitto:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        AQUARIUM_TEST_DOCKER_BROKER_HOST: "mosquitto",
        NODE_ENV: "test",
      }).mqtt.enabled,
    ).toBe(true);
  });

  it("rejects production topics outside explicit production mode", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://127.0.0.1:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "production",
      }),
    ).toThrow(/production runtime mode/i);
  });

  it("rejects production MQTT without the exact safety confirmation", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "production",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://broker:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "production",
      }),
    ).toThrow(/safety confirmation/i);
  });

  it("prohibits production MQTT in a test process even with confirmation", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "production",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://broker:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "production",
        AQUARIUM_PRODUCTION_MQTT_CONFIRMATION:
          "ENABLE_PRODUCTION_AQUARIUM_MQTT",
        NODE_ENV: "test",
      }),
    ).toThrow(/prohibited while running tests/i);
  });

  it("accepts production MQTT only when every production interlock is explicit", () => {
    const configuration = parseControllerConfiguration({
      AQUARIUM_RUNTIME_MODE: "production",
      AQUARIUM_MQTT_ENABLED: "true",
      AQUARIUM_MQTT_BROKER_URL: "mqtt://broker:1883",
      AQUARIUM_MQTT_TOPIC_NAMESPACE: "production",
      AQUARIUM_PRODUCTION_MQTT_CONFIRMATION: "ENABLE_PRODUCTION_AQUARIUM_MQTT",
      NODE_ENV: "production",
      AQUARIUM_STATE_DB_PATH: "runtime/state.db",
      AQUARIUM_EVENTS_DB_PATH: "runtime/events.db",
      AQUARIUM_ARCHIVE_DIRECTORY: "runtime/archives",
      AQUARIUM_BACKUP_DIRECTORY: "runtime/backups",
    });

    expect(configuration.mqtt).toMatchObject({
      enabled: true,
      topicNamespace: "production",
      protocolVersion: 4,
      qos: 0,
      retain: false,
    });
  });

  it("requires explicit database and storage paths in production", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "production",
      }),
    ).toThrow(/AQUARIUM_STATE_DB_PATH/);
  });
});
