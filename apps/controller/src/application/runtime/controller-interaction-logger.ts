import type { InteractionLogInput } from "../../infrastructure/storage/interaction-repository.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KNOWN_HTTP_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const MAX_ROUTE_TEMPLATE_LENGTH = 512;

interface InteractionWriter {
  log(input: InteractionLogInput): Promise<object>;
}

export interface HttpResponseMetadata {
  readonly method: string;
  readonly routeTemplate: string | null;
  readonly statusCode: number;
}

export interface HttpResponseInteractionRecorder {
  recordHttpResponse(metadata: HttpResponseMetadata): void;
}

export interface ControllerInteractionLoggerOptions {
  readonly now?: () => number;
  readonly onPersistenceError: (error: Error) => void;
}

/**
 * Persists deliberate controller-boundary diagnostics without copying request
 * data or exception details. Writes are detached from HTTP responses and can
 * be drained during shutdown before the events database is closed.
 */
export class ControllerInteractionLogger implements HttpResponseInteractionRecorder {
  readonly #writer: InteractionWriter;
  readonly #now: () => number;
  readonly #onPersistenceError: (error: Error) => void;
  readonly #pending = new Set<Promise<void>>();
  readonly #reporterFailures: Error[] = [];

  constructor(
    writer: InteractionWriter,
    options: ControllerInteractionLoggerOptions,
  ) {
    this.#writer = writer;
    this.#now = options.now ?? Date.now;
    this.#onPersistenceError = options.onPersistenceError;
  }

  recordHttpResponse(metadata: HttpResponseMetadata): void {
    const method = normalizeHttpMethod(metadata.method);
    if (!MUTATION_METHODS.has(method) && metadata.statusCode < 500) {
      return;
    }

    // This is transport-outcome metadata only. state_events remains the
    // authoritative audit record for the mutation and its domain payload.
    this.#persist({
      occurredAtMs: this.#now(),
      direction: "outbound",
      kind: "http.response-outcome",
      severity:
        metadata.statusCode >= 500
          ? "critical"
          : metadata.statusCode >= 400
            ? "warning"
            : "info",
      outcome: metadata.statusCode >= 400 ? "failed" : "succeeded",
      byteCount: 0,
      retentionClass: metadata.statusCode >= 500 ? "critical" : "audit",
      payload: {
        method,
        routeTemplate: sanitizeRouteTemplate(metadata.routeTemplate),
        statusCode: metadata.statusCode,
      },
      payloadSchemaVersion: 1,
    });
  }

  recordRuntimeCallbackFailure(error: Error): void {
    this.#persist({
      occurredAtMs: this.#now(),
      direction: "internal",
      kind: "controller.runtime-callback-error",
      severity: "critical",
      outcome: "failed",
      byteCount: 0,
      retentionClass: "critical",
      payload: {
        errorClass: sanitizeErrorIdentifier(error.constructor.name),
        errorName: sanitizeErrorIdentifier(error.name),
      },
      payloadSchemaVersion: 1,
    });
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
    if (this.#reporterFailures.length > 0) {
      throw new AggregateError(
        this.#reporterFailures,
        "Controller interaction persistence error reporter failed",
      );
    }
  }

  #persist(input: InteractionLogInput): void {
    let write: Promise<object>;
    try {
      write = this.#writer.log(input);
    } catch (error) {
      this.#reportPersistenceError(toError(error));
      return;
    }

    const pending = write.then(
      () => undefined,
      (error) => this.#reportPersistenceError(toError(error)),
    );
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  #reportPersistenceError(error: Error): void {
    try {
      this.#onPersistenceError(error);
    } catch (reporterError) {
      this.#reporterFailures.push(
        new AggregateError(
          [error, toError(reporterError)],
          "Unable to report controller interaction persistence failure",
        ),
      );
    }
  }
}

function normalizeHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return KNOWN_HTTP_METHODS.has(normalized) ? normalized : "OTHER";
}

function sanitizeRouteTemplate(routeTemplate: string | null): string | null {
  if (
    routeTemplate === null ||
    routeTemplate.length === 0 ||
    routeTemplate.length > MAX_ROUTE_TEMPLATE_LENGTH ||
    !routeTemplate.startsWith("/") ||
    routeTemplate.includes("?") ||
    routeTemplate.includes("#")
  ) {
    return null;
  }
  return routeTemplate;
}

function sanitizeErrorIdentifier(identifier: string): string {
  return SAFE_ERROR_IDENTIFIER.test(identifier) ? identifier : "Error";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
