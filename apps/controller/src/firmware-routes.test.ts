import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("firmware routes", () => {
  it("serves one immutable manifest and exact binary bytes without caching", async () => {
    const data = Buffer.from([0xe9, 0x04, 0x02, 0x20]);
    const app = buildApp({
      firmwareArtifact: {
        version: "5.0.0",
        sha256:
          "0f1a222342ad95e955daff0052cf19260f7487102357e1f5f499add211896059",
        data,
      },
    });
    apps.push(app);

    const manifest = await app.inject({
      method: "GET",
      url: "/api/firmware/esp32/manifest",
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toEqual({
      version: "5.0.0",
      sha256:
        "0f1a222342ad95e955daff0052cf19260f7487102357e1f5f499add211896059",
      sizeBytes: data.byteLength,
      downloadPath: "/api/firmware/esp32/current.bin",
    });

    const binary = await app.inject({
      method: "GET",
      url: "/api/firmware/esp32/current.bin",
    });
    expect(binary.statusCode).toBe(200);
    expect(binary.headers["content-type"]).toBe("application/octet-stream");
    expect(binary.headers["cache-control"]).toBe("no-store");
    expect(binary.headers["content-length"]).toBe(String(data.byteLength));
    expect(binary.rawPayload).toEqual(data);
  });

  it("fails explicitly when the controller has no firmware artifact", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/firmware/esp32/current.bin",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "service_unavailable",
      service: "firmware artifact",
    });
  });
});
