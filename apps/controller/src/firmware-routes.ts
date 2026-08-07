import type { FastifyInstance } from "fastify";

export interface FirmwareArtifactSource {
  readonly version: string;
  readonly sha256: string;
  readonly data: Buffer;
}

export interface FirmwareRouteDependencies {
  readonly firmwareArtifact?: FirmwareArtifactSource;
}

export function registerFirmwareRoutes(
  app: FastifyInstance,
  dependencies: FirmwareRouteDependencies,
): void {
  app.get("/api/firmware/esp32/manifest", async (_request, reply) => {
    const artifact = dependencies.firmwareArtifact;
    if (artifact === undefined) {
      return reply.code(503).send({
        code: "service_unavailable",
        message: "ESP32 firmware artifact is not configured",
        service: "firmware artifact",
      });
    }
    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send({
        version: artifact.version,
        sha256: artifact.sha256,
        sizeBytes: artifact.data.byteLength,
        downloadPath: "/api/firmware/esp32/current.bin",
      });
  });

  app.get("/api/firmware/esp32/current.bin", async (_request, reply) => {
    const artifact = dependencies.firmwareArtifact;
    if (artifact === undefined) {
      return reply.code(503).send({
        code: "service_unavailable",
        message: "ESP32 firmware artifact is not configured",
        service: "firmware artifact",
      });
    }
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Length", String(artifact.data.byteLength))
      .header(
        "Content-Disposition",
        `attachment; filename="ESP32Code-${artifact.version}.bin"`,
      )
      .type("application/octet-stream")
      .send(artifact.data);
  });
}
