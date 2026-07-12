import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { buildApp } from "./app.js";
import { parseControllerConfiguration } from "./configuration.js";
import {
  closeControllerDatabases,
  mirrorPendingStateEvents,
  openControllerDatabases,
} from "./infrastructure/database/index.js";
import { StateEventStreamHub } from "./realtime/state-event-stream.js";

const configuration = parseControllerConfiguration(process.env);
if (configuration.mqtt.enabled) {
  throw new Error(
    "MQTT was enabled but runtime device composition is not active in this milestone",
  );
}

await Promise.all([
  mkdir(dirname(configuration.storage.stateDatabaseFile), { recursive: true }),
  mkdir(dirname(configuration.storage.eventsDatabaseFile), { recursive: true }),
  mkdir(configuration.storage.archiveDirectory, { recursive: true }),
  mkdir(configuration.storage.backupDirectory, { recursive: true }),
]);
const databases = await openControllerDatabases({
  state: { filename: configuration.storage.stateDatabaseFile },
  events: { filename: configuration.storage.eventsDatabaseFile },
});
const eventStreamHub = new StateEventStreamHub(databases.state);
const app = buildApp({ logger: true, eventStreamHub });

let mirrorRunning = false;
const mirrorOutbox = async (): Promise<void> => {
  if (mirrorRunning) {
    return;
  }
  mirrorRunning = true;
  try {
    const result = await mirrorPendingStateEvents(
      databases.state,
      databases.events,
      { nowMs: Date.now() },
    );
    if (result.mirroredRevisions.length > 0) {
      const committedEvents = await databases.state
        .selectFrom("state_outbox")
        .selectAll()
        .where("revision", "in", result.mirroredRevisions)
        .orderBy("revision", "asc")
        .execute();
      for (const event of committedEvents) {
        eventStreamHub.publishCommitted(event);
      }
      app.log.debug(
        { revisions: result.mirroredRevisions },
        "Mirrored state events into events database",
      );
    }
  } catch (error) {
    app.log.error(error, "Unable to mirror the state event outbox");
  } finally {
    mirrorRunning = false;
  }
};
await mirrorOutbox();
const mirrorInterval = setInterval(() => void mirrorOutbox(), 1_000);
mirrorInterval.unref();

let shutdownPromise: Promise<void> | undefined;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    app.log.info({ signal }, "Stopping aquarium controller");
    clearInterval(mirrorInterval);
    await app.close();
    await closeControllerDatabases(databases);
  })();
  await shutdownPromise;
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({
    host: configuration.server.host,
    port: configuration.server.port,
  });
} catch (error) {
  app.log.error(error, "Unable to start aquarium controller");
  clearInterval(mirrorInterval);
  await app.close();
  await closeControllerDatabases(databases);
  process.exitCode = 1;
}
