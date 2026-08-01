import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  fakeEspConsoleCss,
  fakeEspConsoleHtml,
  fakeEspConsoleJavaScript,
} from "./control-console.js";
import type {
  FakeEspSimulatorSnapshot,
  RunningFakeEspLauncher,
} from "./launcher.js";

const MAXIMUM_REQUEST_BYTES = 16_384;
const EVENT_INTERVAL_MILLISECONDS = 250;

type JsonValue = boolean | number | string | null | JsonValue[] | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface FakeEspControlServerOptions {
  readonly host: string;
  readonly port: number;
  readonly launcher: RunningFakeEspLauncher;
}

export interface RunningFakeEspControlServer {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startFakeEspControlServer(
  options: FakeEspControlServerOptions,
): Promise<RunningFakeEspControlServer> {
  assertControlHost(options.host);
  assertPort(options.port);
  const eventResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handleRequest(
      options.launcher,
      request,
      response,
      eventResponses,
    ).catch((error: Error) => {
      if (!response.headersSent) {
        sendJson(response, errorStatus(error), { message: error.message });
      } else {
        response.destroy(error);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Fake ESP control server did not expose a TCP address");
  }
  const url = `http://${formatHost(options.host)}:${address.port}`;
  return {
    url,
    async stop(): Promise<void> {
      for (const response of eventResponses) {
        response.end();
      }
      eventResponses.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

async function handleRequest(
  launcher: RunningFakeEspLauncher,
  request: IncomingMessage,
  response: ServerResponse,
  eventResponses: Set<ServerResponse>,
): Promise<void> {
  applySecurityHeaders(response);
  const url = new URL(request.url ?? "/", "http://fake-esp.invalid");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    sendText(response, 200, "text/html; charset=utf-8", fakeEspConsoleHtml);
    return;
  }
  if (method === "GET" && url.pathname === "/console.css") {
    sendText(response, 200, "text/css; charset=utf-8", fakeEspConsoleCss);
    return;
  }
  if (method === "GET" && url.pathname === "/console.js") {
    sendText(
      response,
      200,
      "text/javascript; charset=utf-8",
      fakeEspConsoleJavaScript,
    );
    return;
  }
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && url.pathname === "/api/snapshot") {
    sendJson(response, 200, launcher.snapshot());
    return;
  }
  if (method === "GET" && url.pathname === "/api/events") {
    openEventStream(response, launcher, eventResponses);
    return;
  }

  const deviceRoute = matchDeviceRoute(url.pathname);
  if (method !== "POST" || deviceRoute === null) {
    sendJson(response, 404, { message: "Simulator route not found" });
    return;
  }
  assertSameOrigin(request);

  if (deviceRoute.action === "power") {
    const body = await readJsonObject(request);
    assertExactFields(body, ["powered"]);
    const powered = requiredBoolean(body, "powered");
    if (powered) {
      await launcher.powerOn(deviceRoute.key);
    } else {
      await launcher.powerOff(deviceRoute.key);
    }
  } else if (deviceRoute.action === "reboot") {
    await launcher.reboot(deviceRoute.key);
  } else if (deviceRoute.action === "network") {
    const body = await readJsonObject(request);
    assertExactFields(body, ["enabled"]);
    launcher.setNetworkEnabled(
      deviceRoute.key,
      requiredBoolean(body, "enabled"),
    );
  } else if (deviceRoute.action === "faults") {
    const body = await readJsonObject(request);
    assertExactFields(body, [
      "delayMilliseconds",
      "duplicateResponses",
      "drop",
      "malformed",
    ]);
    launcher.setResponseFaults(deviceRoute.key, {
      delayMilliseconds: requiredInteger(body, "delayMilliseconds", 0, 60_000),
      duplicateResponses: requiredInteger(body, "duplicateResponses", 0, 20),
      drop: requiredBoolean(body, "drop"),
      malformed: requiredBoolean(body, "malformed"),
    });
  } else if (deviceRoute.action === "pin-failure") {
    const body = await readJsonObject(request);
    assertExactFields(body, ["failing"]);
    launcher.setPinAttachmentFailure(
      deviceRoute.key,
      deviceRoute.pin,
      requiredBoolean(body, "failing"),
    );
  } else if (deviceRoute.action === "analog") {
    const body = await readJsonObject(request);
    assertExactFields(body, ["value"]);
    launcher.setAnalogValue(
      deviceRoute.key,
      deviceRoute.pin,
      requiredInteger(body, "value", 0, 4_095),
    );
  } else {
    throw new Error("Unsupported simulator device action");
  }
  sendJson(response, 200, launcher.snapshot());
}

type DeviceRoute =
  | {
      readonly key: string;
      readonly action: "power" | "reboot" | "network" | "faults";
    }
  | {
      readonly key: string;
      readonly action: "pin-failure" | "analog";
      readonly pin: number;
    };

function matchDeviceRoute(pathname: string): DeviceRoute | null {
  const simple = pathname.match(
    /^\/api\/devices\/([A-Za-z0-9_-]+)\/(power|reboot|network|faults)$/u,
  );
  if (simple !== null) {
    return {
      key: simple[1] as string,
      action: simple[2] as "power" | "reboot" | "network" | "faults",
    };
  }
  const pin = pathname.match(
    /^\/api\/devices\/([A-Za-z0-9_-]+)\/(pin-failures|analog)\/(\d{1,2})$/u,
  );
  if (pin === null) {
    return null;
  }
  const pinNumber = Number(pin[3]);
  if (!Number.isSafeInteger(pinNumber) || pinNumber < 0 || pinNumber > 63) {
    throw new RangeError("Fake ESP pin must be between 0 and 63");
  }
  return {
    key: pin[1] as string,
    action: pin[2] === "pin-failures" ? "pin-failure" : "analog",
    pin: pinNumber,
  };
}

function openEventStream(
  response: ServerResponse,
  launcher: RunningFakeEspLauncher,
  eventResponses: Set<ServerResponse>,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  eventResponses.add(response);
  const publish = (): void => {
    response.write(`data: ${JSON.stringify(launcher.snapshot())}\n\n`);
  };
  publish();
  const interval = setInterval(publish, EVENT_INTERVAL_MILLISECONDS);
  response.once("close", () => {
    clearInterval(interval);
    eventResponses.delete(response);
  });
}

async function readJsonObject(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAXIMUM_REQUEST_BYTES) {
      throw new RangeError("Simulator request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Simulator request body must be a JSON object");
  }
  return value;
}

function assertExactFields(
  body: JsonObject,
  expectedFields: readonly string[],
): void {
  const expected = new Set(expectedFields);
  const unexpected = Object.keys(body).find((field) => !expected.has(field));
  const missing = expectedFields.find((field) => !(field in body));
  if (unexpected !== undefined || missing !== undefined) {
    throw new TypeError("Simulator request body has invalid fields");
  }
}

function requiredBoolean(body: JsonObject, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw new TypeError(`Simulator ${field} must be boolean`);
  }
  return value;
}

function requiredInteger(
  body: JsonObject,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const value = body[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `Simulator ${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function assertSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (
    origin !== undefined &&
    (host === undefined || origin !== `http://${host}`)
  ) {
    throw new Error("Simulator mutation rejected for a different origin");
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonValue | FakeEspSimulatorSnapshot,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function errorStatus(error: Error): number {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error.message.startsWith("Unknown fake ESP")
  ) {
    return 400;
  }
  if (error.message.includes("different origin")) {
    return 403;
  }
  return 500;
}

function assertControlHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0") {
    throw new Error(
      "Fake ESP control server may bind only to loopback or all container interfaces",
    );
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Fake ESP control port must be between 0 and 65535");
  }
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
