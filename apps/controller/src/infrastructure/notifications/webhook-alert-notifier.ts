import type {
  AlertNotificationV1,
  AlertNotifier,
} from "../../application/alerts/index.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const RESERVED_AUTH_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "x-aquarium-event-revision",
  "x-aquarium-payload-version",
]);

export type WebhookRuntime = "development" | "test" | "production";

export interface WebhookAuthHeader {
  readonly name: string;
  readonly value: string;
}

export interface WebhookAlertNotifierOptions {
  readonly url: string;
  readonly runtime: WebhookRuntime;
  readonly timeoutMs?: number;
  readonly authHeader?: WebhookAuthHeader;
}

export interface ValidatedWebhookAlertNotifierOptions {
  readonly url: URL;
  readonly runtime: WebhookRuntime;
  readonly timeoutMs: number;
  readonly authHeader?: WebhookAuthHeader;
}

export type WebhookDeliveryFailureCode =
  "timeout" | "transport" | "http-status";

export class WebhookDeliveryError extends Error {
  override readonly name = "WebhookDeliveryError";
  readonly code: WebhookDeliveryFailureCode;
  readonly statusCode: number | null;

  constructor(
    code: WebhookDeliveryFailureCode,
    message: string,
    statusCode: number | null = null,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function parseWebhookUrl(rawUrl: string, runtime: WebhookRuntime): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError("Webhook URL must be an absolute URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("Webhook URL must not contain credentials");
  }
  if (url.search.length > 0) {
    throw new TypeError("Webhook URL must not contain a query string");
  }
  if (url.hash.length > 0) {
    throw new TypeError("Webhook URL must not contain a fragment");
  }

  if (runtime === "production") {
    if (url.protocol !== "https:") {
      throw new TypeError("Production webhook URL must use HTTPS");
    }
  } else if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new TypeError(
      "Development and test webhook URLs must use HTTP on a loopback host",
    );
  }
  return url;
}

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `Webhook timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function validateAuthHeader(
  authHeader: WebhookAuthHeader | undefined,
): WebhookAuthHeader | undefined {
  if (authHeader === undefined) return undefined;
  if (!HTTP_HEADER_NAME.test(authHeader.name)) {
    throw new TypeError("Webhook authentication header name is invalid");
  }
  if (RESERVED_AUTH_HEADERS.has(authHeader.name.toLowerCase())) {
    throw new TypeError(
      `Webhook authentication header ${authHeader.name} is reserved`,
    );
  }
  if (
    authHeader.value.length === 0 ||
    authHeader.value.includes("\r") ||
    authHeader.value.includes("\n")
  ) {
    throw new TypeError(
      "Webhook authentication header value must be non-empty and single-line",
    );
  }
  try {
    const headers = new Headers();
    headers.set(authHeader.name, authHeader.value);
  } catch {
    throw new TypeError("Webhook authentication header value is invalid");
  }
  return { name: authHeader.name, value: authHeader.value };
}

export function validateWebhookAlertNotifierOptions(
  options: WebhookAlertNotifierOptions,
): ValidatedWebhookAlertNotifierOptions {
  const authHeader = validateAuthHeader(options.authHeader);
  return {
    url: parseWebhookUrl(options.url, options.runtime),
    runtime: options.runtime,
    timeoutMs: validateTimeout(options.timeoutMs),
    ...(authHeader === undefined ? {} : { authHeader }),
  };
}

/**
 * A single-attempt webhook adapter. Redirects are rejected so development/test
 * loopback confinement cannot be bypassed and delivery policy remains with the
 * durable outbox worker rather than an implicit fetch retry loop.
 */
export class WebhookAlertNotifier implements AlertNotifier {
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #authHeader: WebhookAuthHeader | undefined;

  constructor(options: WebhookAlertNotifierOptions) {
    const validated = validateWebhookAlertNotifierOptions(options);
    this.#url = validated.url;
    this.#timeoutMs = validated.timeoutMs;
    this.#authHeader = validated.authHeader;
  }

  async send(notification: AlertNotificationV1): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "x-aquarium-event-revision": String(notification.eventRevision),
      "x-aquarium-payload-version": String(notification.schemaVersion),
    });
    if (this.#authHeader !== undefined) {
      headers.set(this.#authHeader.name, this.#authHeader.value);
    }

    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers,
        body: JSON.stringify(notification),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WebhookDeliveryError(
          "http-status",
          `Webhook responded with HTTP ${response.status}`,
          response.status,
        );
      }
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof WebhookDeliveryError) throw error;
      if (controller.signal.aborted) {
        throw new WebhookDeliveryError(
          "timeout",
          `Webhook delivery exceeded ${this.#timeoutMs} milliseconds`,
        );
      }
      throw new WebhookDeliveryError("transport", "Webhook transport failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
