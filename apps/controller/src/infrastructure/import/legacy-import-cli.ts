import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { openStateDatabase } from "../database/index.js";
import { analyzeLegacyDirectory } from "./legacy-import-analyzer.js";
import { importLegacyDirectory } from "./legacy-import-service.js";

const HELP = `Usage:
  npm exec -- tsx apps/controller/src/infrastructure/import/legacy-import-cli.ts --source <directory>
  npm exec -- tsx apps/controller/src/infrastructure/import/legacy-import-cli.ts --source <directory> --commit --state-db <file>

Options:
  --source <directory>  Legacy JSON directory. Defaults to .old/data.
  --commit              Commit only when the complete analysis is valid.
  --state-db <file>     Explicit state.db path; required with --commit.
  --help                Show this help.

Dry-run is the default and never opens or writes a database.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: "string", default: ".old/data" },
      commit: { type: "boolean", default: false },
      "state-db": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const sourceDirectory = resolve(values.source);
  if (!values.commit) {
    const report = await analyzeLegacyDirectory(sourceDirectory);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 2;
    return;
  }

  if (
    values["state-db"] === undefined ||
    values["state-db"].trim().length === 0
  ) {
    throw new TypeError(
      "--state-db is required with --commit; there is no implicit production database path.",
    );
  }
  const database = await openStateDatabase({
    filename: resolve(values["state-db"]),
  });
  try {
    const result = await importLegacyDirectory({
      sourceDirectory,
      dryRun: false,
      database,
      actor: "legacy-import-cli",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.committed) process.exitCode = 2;
  } finally {
    await database.destroy();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Legacy import failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
