import { z } from "zod";

import { buildApp } from "./app.js";

const serverConfigurationSchema = z.object({
  AQUARIUM_HOST: z.string().min(1).default("127.0.0.1"),
  AQUARIUM_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});

const configuration = serverConfigurationSchema.parse(process.env);
const app = buildApp({ logger: true });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "Stopping aquarium controller");
  await app.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({
    host: configuration.AQUARIUM_HOST,
    port: configuration.AQUARIUM_PORT,
  });
} catch (error) {
  app.log.error(error, "Unable to start aquarium controller");
  process.exitCode = 1;
}
