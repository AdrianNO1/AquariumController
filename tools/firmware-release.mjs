import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firmwareSourcePath = join(
  repositoryRoot,
  "firmware",
  "esp32",
  "ESP32Code",
  "ESP32Code.ino",
);
const safeConfigurationPath = join(
  repositoryRoot,
  "firmware",
  "esp32",
  "ESP32Code",
  "firmware-config.example.h",
);
const compilerDockerfilePath = join(
  repositoryRoot,
  "firmware",
  "esp32",
  "Dockerfile.compile",
);
const artifactDirectory = join(
  repositoryRoot,
  "firmware",
  "esp32",
  "artifacts",
);
const protocolSourcePath = join(
  repositoryRoot,
  "packages",
  "esp-protocol",
  "src",
  "index.ts",
);
const fakeEspSourcePath = join(
  repositoryRoot,
  "packages",
  "fake-esp",
  "src",
  "fake-esp.ts",
);

const usage = `Usage: npm run firmware:release -- <version> [--check] [--replace]

Builds the generic production OTA image with the pinned Docker toolchain,
validates its embedded release settings, writes it under firmware/esp32/artifacts,
and updates the controller's exact size and SHA-256 metadata.

Before running, set the same version in the real sketch, @aquarium/esp-protocol,
and @aquarium/fake-esp. --check builds and validates without writing. Existing
artifacts are protected unless --replace is explicitly supplied for an
unshipped correction.`;

const argumentsList = process.argv.slice(2);
if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const replaceExisting = argumentsList.includes("--replace");
const checkOnly = argumentsList.includes("--check");
const positionalArguments = argumentsList.filter(
  (argument) => argument !== "--check" && argument !== "--replace",
);
if (positionalArguments.length !== 1) {
  throw new TypeError(usage);
}
const version = positionalArguments[0];
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new TypeError(`Firmware version must be numeric SemVer: ${version}`);
}

const [
  firmwareSource,
  safeConfiguration,
  compilerDockerfile,
  protocolSource,
  fakeEspSource,
] = await Promise.all([
  readFile(firmwareSourcePath, "utf8"),
  readFile(safeConfigurationPath, "utf8"),
  readFile(compilerDockerfilePath, "utf8"),
  readFile(protocolSourcePath, "utf8"),
  readFile(fakeEspSourcePath, "utf8"),
]);

assertContains(
  firmwareSource,
  `const char* VERSION = "${version}";`,
  "the ESP32 sketch version",
);
assertContains(
  firmwareSource,
  "const bool TEST = false;",
  "the production TEST flag",
);
if (firmwareSource.includes("const bool TEST = true;")) {
  throw new Error("Refusing to release firmware while TEST=true");
}
assertContains(
  protocolSource,
  `export const CURRENT_ESP_FIRMWARE_VERSION = "${version}";`,
  "the protocol firmware version",
);
assertContains(
  fakeEspSource,
  `export const FAKE_ESP_FIRMWARE_VERSION = "${version}";`,
  "the fake ESP firmware version",
);
assertContains(
  compilerDockerfile,
  "COPY firmware/esp32/ESP32Code/firmware-config.example.h ./firmware-config.h",
  "the safe generic firmware configuration input",
);

const safeConfigurationValues = [
  "replace-with-wifi-ssid",
  "replace-with-wifi-password",
  "192.0.2.1",
  "replace-with-mqtt-username",
  "replace-with-mqtt-password",
  "pool.ntp.org",
];
for (const value of safeConfigurationValues) {
  assertContains(safeConfiguration, value, `safe configuration value ${value}`);
}

const artifactFileName = `ESP32Code-${version}.bin`;
const artifactPath = join(artifactDirectory, artifactFileName);
if (!checkOnly && !replaceExisting && (await exists(artifactPath))) {
  throw new Error(
    `${artifactFileName} already exists; use a new version or explicitly pass --replace for an unshipped correction`,
  );
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "aquarium-firmware-release-"),
);
try {
  const buildOutputDirectory = join(temporaryDirectory, "output");
  run("docker", [
    "buildx",
    "build",
    "--progress=plain",
    "--file",
    compilerDockerfilePath,
    "--output",
    `type=local,dest=${buildOutputDirectory.replaceAll("\\", "/")}`,
    repositoryRoot,
  ]);

  const compiledBinaryPath = join(
    buildOutputDirectory,
    "ESP32Code.ino.bin",
  );
  const compiledBinary = await readFile(compiledBinaryPath);
  validateCompiledBinary(compiledBinary, version, safeConfigurationValues);

  const sha256 = createHash("sha256").update(compiledBinary).digest("hex");
  const nextProtocolSource = updateArtifactMetadata(protocolSource, {
    fileName: artifactFileName,
    sizeBytes: compiledBinary.byteLength,
    sha256,
  });

  if (!checkOnly) {
    await copyFile(compiledBinaryPath, artifactPath);
    await writeFile(protocolSourcePath, nextProtocolSource, "utf8");
  }

  console.log(
    checkOnly
      ? "Firmware release build validated without writing files."
      : "Firmware release artifact prepared successfully.",
  );
  console.log(`Version: ${version}`);
  console.log(`Artifact: ${artifactPath}`);
  console.log(`Size: ${compiledBinary.byteLength} bytes`);
  console.log(`SHA-256: ${sha256}`);
  console.log(
    "Next: review the binary/metadata diff, update current-version documentation, and run the repository checks before committing.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function validateCompiledBinary(binary, targetVersion, expectedSafeValues) {
  const requiredValues = [
    targetVersion,
    "aquarium/command",
    "aquarium/announce",
    "aquarium/response",
    ...expectedSafeValues,
  ];
  for (const value of requiredValues) {
    if (!binary.includes(Buffer.from(value, "ascii"))) {
      throw new Error(`Compiled firmware is missing expected value: ${value}`);
    }
  }
  for (const topic of [
    "test/aquarium/command",
    "test/aquarium/announce",
    "test/aquarium/response",
  ]) {
    if (binary.includes(Buffer.from(topic, "ascii"))) {
      throw new Error(`Compiled release firmware contains test topic: ${topic}`);
    }
  }
}

function updateArtifactMetadata(source, artifact) {
  const start = source.indexOf("export const ESP_FIRMWARE_ARTIFACT = {");
  const endMarker = "} as const;";
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("Could not locate ESP_FIRMWARE_ARTIFACT metadata");
  }
  const blockEnd = end + endMarker.length;
  const block = source.slice(start, blockEnd);
  const nextBlock = replaceRequired(
    replaceRequired(
      replaceRequired(
        block,
        /fileName: "ESP32Code-[^"]+\.bin"/u,
        `fileName: "${artifact.fileName}"`,
        "artifact filename",
      ),
      /sizeBytes: [\d_]+/u,
      `sizeBytes: ${formatInteger(artifact.sizeBytes)}`,
      "artifact size",
    ),
    /[a-f0-9]{64}/u,
    artifact.sha256,
    "artifact SHA-256",
  );
  return `${source.slice(0, start)}${nextBlock}${source.slice(blockEnd)}`;
}

function replaceRequired(source, pattern, replacement, description) {
  if (!pattern.test(source)) {
    throw new Error(`Could not locate ${description} metadata`);
  }
  return source.replace(pattern, replacement);
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
}

function assertContains(source, expected, description) {
  if (!source.includes(expected)) {
    throw new Error(`Could not verify ${description}: expected ${expected}`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function run(command, argumentsForCommand) {
  const result = spawnSync(command, argumentsForCommand, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
