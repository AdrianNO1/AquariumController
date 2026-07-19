import { describe, expect, it } from "vitest";

import { parseControllerConfiguration } from "./configuration.js";

describe("controller configuration safety", () => {
  it("keeps MQTT disabled by default", () => {
    expect(parseControllerConfiguration({})).toMatchObject({
      runtimeMode: "development",
      server: { host: "127.0.0.1", port: 3001, webRoot: null },
      realtime: { maxReplayEvents: 1_000 },
      mqtt: { enabled: false },
      storage: {
        stateDatabaseFile: expect.stringMatching(/[\\/]\.data[\\/]state\.db$/),
        eventsDatabaseFile: expect.stringMatching(
          /[\\/]\.data[\\/]events\.db$/,
        ),
        archiveDirectory: expect.stringMatching(/[\\/]\.data[\\/]archives$/),
        backupDirectory: expect.stringMatching(/[\\/]\.data[\\/]backups$/),
        backupFreshnessThresholdMs: 129_600_000,
        retentionStaleRunAfterMs: 21_600_000,
        healthCheckIntervalMs: 300_000,
        minimumFilesystemFreeBytes: 1_073_741_824,
        maximumProjectedStorageBytesAfterOneYear: 10_737_418_240,
      },
      alerting: { webhook: null },
    });
  });

  it("resolves an explicit production web root", () => {
    expect(
      parseControllerConfiguration({ AQUARIUM_WEB_ROOT: "web/dist" }).server
        .webRoot,
    ).toMatch(/[\\/]web[\\/]dist$/);
  });

  it("configures and bounds the SSE replay limit", () => {
    expect(
      parseControllerConfiguration({
        AQUARIUM_SSE_REPLAY_LIMIT: "250",
      }).realtime,
    ).toEqual({ maxReplayEvents: 250 });
    expect(() =>
      parseControllerConfiguration({ AQUARIUM_SSE_REPLAY_LIMIT: "0" }),
    ).toThrow(/>=1/u);
    expect(() =>
      parseControllerConfiguration({ AQUARIUM_SSE_REPLAY_LIMIT: "10001" }),
    ).toThrow(/<=10000/u);
  });

  it("configures a loopback development webhook with deterministic defaults", () => {
    expect(
      parseControllerConfiguration({
        AQUARIUM_ALERT_WEBHOOK_URL: "http://127.0.0.1:4567/alerts",
      }).alerting.webhook,
    ).toEqual({
      url: "http://127.0.0.1:4567/alerts",
      destinationKey: "primary",
      timeoutMs: 10_000,
    });
  });

  it("configures an explicit webhook destination and paired authentication header", () => {
    expect(
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_ALERT_WEBHOOK_URL: "http://127.12.34.56:4567/alerts",
        AQUARIUM_ALERT_WEBHOOK_KEY: "operations.primary",
        AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS: "2500",
        AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME: "Authorization",
        AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE: "Bearer test-secret",
      }).alerting.webhook,
    ).toEqual({
      url: "http://127.12.34.56:4567/alerts",
      destinationKey: "operations.primary",
      timeoutMs: 2_500,
      authHeader: {
        name: "Authorization",
        value: "Bearer test-secret",
      },
    });
  });

  it("rejects incomplete or inert webhook settings", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_ALERT_WEBHOOK_KEY: "unused",
      }),
    ).toThrow(/require AQUARIUM_ALERT_WEBHOOK_URL/i);

    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_ALERT_WEBHOOK_URL: "http://127.0.0.1:4567/alerts",
        AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME: "Authorization",
      }),
    ).toThrow(/name and value must be configured together/i);
  });

  it("confines development and test webhooks to loopback HTTP", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_ALERT_WEBHOOK_URL: "https://127.0.0.1:4567/alerts",
      }),
    ).toThrow(/HTTP on a loopback host/i);

    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_ALERT_WEBHOOK_URL: "http://webhook.example/alerts",
      }),
    ).toThrow(/HTTP on a loopback host/i);
  });

  it("requires HTTPS for a production webhook", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "production",
        AQUARIUM_ALERT_WEBHOOK_URL: "http://webhook.example/alerts",
        AQUARIUM_STATE_DB_PATH: "runtime/state.db",
        AQUARIUM_EVENTS_DB_PATH: "runtime/events.db",
        AQUARIUM_ARCHIVE_DIRECTORY: "runtime/archives",
        AQUARIUM_BACKUP_DIRECTORY: "runtime/backups",
      }),
    ).toThrow(/must use HTTPS/i);

    expect(
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "production",
        AQUARIUM_ALERT_WEBHOOK_URL: "https://webhook.example/alerts",
        AQUARIUM_STATE_DB_PATH: "runtime/state.db",
        AQUARIUM_EVENTS_DB_PATH: "runtime/events.db",
        AQUARIUM_ARCHIVE_DIRECTORY: "runtime/archives",
        AQUARIUM_BACKUP_DIRECTORY: "runtime/backups",
      }).alerting.webhook,
    ).toMatchObject({
      url: "https://webhook.example/alerts",
      destinationKey: "primary",
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
      responseTimeoutMs: 5_000,
      discoveryIntervalMs: 60_000,
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

  it("rejects every off-loopback development and test broker", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://mosquitto:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        NODE_ENV: "test",
      }),
    ).toThrow(/loopback/);

    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://mosquitto:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        AQUARIUM_TEST_DOCKER_BROKER_HOST: "mosquitto",
        NODE_ENV: "test",
      }),
    ).toThrow(/loopback/);
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

  it("requires discovery, coalescing, and health cadence below stale/offline thresholds", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS: "90000",
      }),
    ).toThrow(/persistence interval.*stale/i);
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_DEVICE_STALE_AFTER_MS: "300000",
        AQUARIUM_DEVICE_OFFLINE_AFTER_MS: "300000",
      }),
    ).toThrow(/stale threshold.*offline/i);
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RUNTIME_MODE: "test",
        AQUARIUM_MQTT_ENABLED: "true",
        AQUARIUM_MQTT_BROKER_URL: "mqtt://127.0.0.1:1883",
        AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
        AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS: "90000",
        NODE_ENV: "test",
      }),
    ).toThrow(/discovery interval.*stale/i);
  });

  it("bounds the stale retention-run recovery age", () => {
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_RETENTION_STALE_RUN_AFTER_MS: "59999",
      }),
    ).toThrow(/>=60000/i);
  });

  it("configures and bounds storage-health monitoring", () => {
    expect(
      parseControllerConfiguration({
        AQUARIUM_STORAGE_HEALTH_INTERVAL_MS: "60000",
        AQUARIUM_STORAGE_MINIMUM_FREE_BYTES: "1048576",
        AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES: "2097152",
        AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS: "172800000",
      }).storage,
    ).toMatchObject({
      healthCheckIntervalMs: 60_000,
      minimumFilesystemFreeBytes: 1_048_576,
      maximumProjectedStorageBytesAfterOneYear: 2_097_152,
      backupFreshnessThresholdMs: 172_800_000,
    });
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_STORAGE_HEALTH_INTERVAL_MS: "9999",
      }),
    ).toThrow(/>=10000/u);
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_STORAGE_MINIMUM_FREE_BYTES: "0",
      }),
    ).toThrow(/>=1/u);
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES: "0",
      }),
    ).toThrow(/>=1/u);
    expect(() =>
      parseControllerConfiguration({
        AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS: "59999",
      }),
    ).toThrow(/>=60000/u);
  });
});
