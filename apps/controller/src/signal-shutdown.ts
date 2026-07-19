export interface SignalShutdownOptions {
  readonly signal: NodeJS.Signals;
  readonly shutdown: (signal: NodeJS.Signals) => Promise<void>;
  readonly reportFailure: (error: Error, signal: NodeJS.Signals) => void;
}

export async function runSignalShutdown(
  options: SignalShutdownOptions,
): Promise<void> {
  try {
    await options.shutdown(options.signal);
  } catch (error) {
    process.exitCode = 1;
    try {
      options.reportFailure(toError(error), options.signal);
    } catch {
      // The signal handler must remain settled even if its logger fails.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
