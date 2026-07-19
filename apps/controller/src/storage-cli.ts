import {
  executeStorageCommand,
  parseStorageCommandArguments,
} from "./infrastructure/storage/storage-commands.js";

try {
  const command = parseStorageCommandArguments(process.argv.slice(2));
  const result = await executeStorageCommand(command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Storage command failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
