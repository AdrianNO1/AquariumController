import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { AlertNotificationV1 } from "../../application/alerts/index.js";
import {
  WebhookAlertNotifier,
  WebhookDeliveryError,
  type WebhookRuntime,
} from "./webhook-alert-notifier.js";

const notification = {
  schemaVersion: 1,
  kind: "aquarium.alert",
  eventRevision: 42,
  occurredAt: "2026-07-13T10:20:30.000Z",
  transition: "opened",
  alert: {
    id: "alert-temperature-high",
    ruleId: "rule-temperature-high",
    deduplicationKey: "sensor:temperature-main",
    state: "open",
    openedAtMs: 1_784_543_230_000,
    lastObservedAtMs: 1_784_543_230_000,
    acknowledgedAtMs: null,
    recoveredAtMs: null,
  },
  rule: {
    id: "rule-temperature-high",
    name: "Main aquarium temperature",
    sourceType: "sensor",
    sourceId: "temperature-main",
    condition: "above",
    threshold: 28.5,
    delayMs: 30_000,
    severity: "critical",
  },
  observation: {
    sourceType: "sensor",
    sourceId: "temperature-main",
    value: 29.25,
  },
  note: null,
} satisfies AlertNotificationV1;

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const openServers: Server[] = [];

async function startLoopbackServer(
  listener: RequestListener,
): Promise<{ readonly server: Server; readonly origin: string }> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback test server did not expose a TCP address");
  }
  openServers.push(server);
  return {
    server,
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
}

async function captureDeliveryError(
  delivery: Promise<void>,
): Promise<WebhookDeliveryError> {
  return delivery.then(
    () => {
      throw new Error("Expected webhook delivery to fail");
    },
    (error: Error) => {
      if (!(error instanceof WebhookDeliveryError)) throw error;
      return error;
    },
  );
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe("WebhookAlertNotifier", () => {
  it("posts the exact JSON payload and protocol headers to loopback", async () => {
    let captured: CapturedRequest | undefined;
    const { origin } = await startLoopbackServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.once("end", () => {
        captured = {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        };
        response.writeHead(204).end();
      });
    });
    const notifier = new WebhookAlertNotifier({
      url: `${origin}/alerts`,
      runtime: "test",
    });

    await notifier.send(notification);

    expect(captured).toMatchObject({
      method: "POST",
      url: "/alerts",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-aquarium-event-revision": "42",
        "x-aquarium-payload-version": "1",
      },
      body: JSON.stringify(notification),
    });
    expect(captured?.headers.authorization).toBeUndefined();
    expect(Number(captured?.headers["content-length"])).toBe(
      Buffer.byteLength(JSON.stringify(notification)),
    );
  });

  it("sends an explicitly configured authentication header", async () => {
    let authorization: string | undefined;
    const { origin } = await startLoopbackServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(204).end();
    });
    const notifier = new WebhookAlertNotifier({
      url: `${origin}/alerts`,
      runtime: "test",
      authHeader: {
        name: "Authorization",
        value: "Bearer private-auth-value",
      },
    });

    await notifier.send(notification);

    expect(authorization).toBe("Bearer private-auth-value");
  });

  it("aborts a request at the configured timeout", async () => {
    const { origin } = await startLoopbackServer(() => undefined);
    const notifier = new WebhookAlertNotifier({
      url: `${origin}/timeout-private-path`,
      runtime: "test",
      timeoutMs: 50,
    });

    const error = await captureDeliveryError(notifier.send(notification));

    expect(error).toMatchObject({
      code: "timeout",
      statusCode: null,
      message: "Webhook delivery exceeded 50 milliseconds",
    });
    expect(error.message).not.toContain(origin);
    expect(error).not.toHaveProperty("cause");
  });

  it("reports non-success status without reading or exposing the response body", async () => {
    const responseSecret = "private-response-body";
    const authSecret = "Bearer private-auth-value";
    const { origin } = await startLoopbackServer((_request, response) => {
      response
        .writeHead(503, { "content-type": "text/plain" })
        .end(responseSecret);
    });
    const notifier = new WebhookAlertNotifier({
      url: `${origin}/private-url-path`,
      runtime: "test",
      authHeader: { name: "Authorization", value: authSecret },
    });

    const error = await captureDeliveryError(notifier.send(notification));

    expect(error).toMatchObject({
      code: "http-status",
      statusCode: 503,
      message: "Webhook responded with HTTP 503",
    });
    expect(error.message).not.toContain(origin);
    expect(error.message).not.toContain(responseSecret);
    expect(error.message).not.toContain(authSecret);
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(notifier)).toBe("{}");
  });

  it("rejects redirects without requesting their target", async () => {
    let targetRequests = 0;
    const { origin } = await startLoopbackServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/private-redirect-target" }).end();
        return;
      }
      targetRequests += 1;
      response.writeHead(204).end();
    });
    const notifier = new WebhookAlertNotifier({
      url: `${origin}/redirect`,
      runtime: "test",
    });

    const error = await captureDeliveryError(notifier.send(notification));

    expect(error).toMatchObject({
      code: "transport",
      statusCode: null,
      message: "Webhook transport failed",
    });
    expect(targetRequests).toBe(0);
    expect(error.message).not.toContain("private-redirect-target");
    expect(error).not.toHaveProperty("cause");
  });

  it("redacts transport details when loopback refuses the connection", async () => {
    const reserved = await startLoopbackServer((_request, response) => {
      response.writeHead(204).end();
    });
    const unavailableUrl = `${reserved.origin}/private-transport-path`;
    await closeServer(reserved.server);
    const notifier = new WebhookAlertNotifier({
      url: unavailableUrl,
      runtime: "test",
      timeoutMs: 1_000,
    });

    const error = await captureDeliveryError(notifier.send(notification));

    expect(error).toMatchObject({
      code: "transport",
      statusCode: null,
      message: "Webhook transport failed",
    });
    expect(error.message).not.toContain(unavailableUrl);
    expect(error.message).not.toContain("private-transport-path");
    expect(error).not.toHaveProperty("cause");
  });

  it("requires HTTPS in production without contacting the destination", () => {
    expect(
      () =>
        new WebhookAlertNotifier({
          url: "http://127.0.0.1:8080/alerts",
          runtime: "production",
        }),
    ).toThrow(/must use HTTPS/);
    expect(
      () =>
        new WebhookAlertNotifier({
          url: "https://alerts.example.test/webhook",
          runtime: "production",
        }),
    ).not.toThrow();
  });

  it.each(["development", "test"] satisfies readonly WebhookRuntime[])(
    "rejects non-loopback HTTP in %s without making a request",
    (runtime) => {
      expect(
        () =>
          new WebhookAlertNotifier({
            url: "http://192.0.2.1/alerts",
            runtime,
          }),
      ).toThrow(/loopback host/);
    },
  );

  it.each([
    {
      label: "credentials",
      url: "http://user:private-password@127.0.0.1:8080/alerts",
      expected: /credentials/,
      secret: "private-password",
    },
    {
      label: "query string",
      url: "http://127.0.0.1:8080/alerts?token=private-query-value",
      expected: /query string/,
      secret: "private-query-value",
    },
    {
      label: "fragment",
      url: "http://127.0.0.1:8080/alerts#private-fragment-value",
      expected: /fragment/,
      secret: "private-fragment-value",
    },
  ] as const)(
    "rejects a URL containing $label without exposing it",
    (testCase) => {
      let error: Error | undefined;
      try {
        new WebhookAlertNotifier({ url: testCase.url, runtime: "test" });
      } catch (caught) {
        if (caught instanceof Error) error = caught;
      }

      expect(error?.message).toMatch(testCase.expected);
      expect(error?.message).not.toContain(testCase.secret);
      expect(error).not.toHaveProperty("cause");
    },
  );

  it.each([0, -1, 1.5, 60_001, Number.MAX_SAFE_INTEGER])(
    "rejects the timeout bound %s",
    (timeoutMs) => {
      expect(
        () =>
          new WebhookAlertNotifier({
            url: "http://127.0.0.1:8080/alerts",
            runtime: "test",
            timeoutMs,
          }),
      ).toThrow(/between 1 and 60000/);
    },
  );

  it.each([1, 60_000])("accepts the timeout bound %s", (timeoutMs) => {
    expect(
      () =>
        new WebhookAlertNotifier({
          url: "http://127.0.0.1:8080/alerts",
          runtime: "test",
          timeoutMs,
        }),
    ).not.toThrow();
  });

  it.each([
    { name: "bad header", value: "secret", expected: /name is invalid/ },
    { name: "Content-Type", value: "secret", expected: /reserved/ },
    {
      name: "X-Aquarium-Event-Revision",
      value: "secret",
      expected: /reserved/,
    },
    { name: "Authorization", value: "", expected: /non-empty/ },
    {
      name: "Authorization",
      value: "private\r\nInjected: value",
      expected: /single-line/,
    },
    {
      name: "Authorization",
      value: "private\u0000value",
      expected: /value is invalid/,
    },
  ] as const)(
    "rejects invalid authentication header $name without exposing its value",
    (testCase) => {
      let error: Error | undefined;
      try {
        new WebhookAlertNotifier({
          url: "http://127.0.0.1:8080/alerts",
          runtime: "test",
          authHeader: { name: testCase.name, value: testCase.value },
        });
      } catch (caught) {
        if (caught instanceof Error) error = caught;
      }

      expect(error?.message).toMatch(testCase.expected);
      if (testCase.value.length > 0) {
        expect(error?.message).not.toContain(testCase.value);
      }
      expect(error).not.toHaveProperty("cause");
    },
  );
});
