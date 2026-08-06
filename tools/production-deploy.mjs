import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubRepository = "AdrianNO1/AquariumController";
const expectedImageRepository = "ghcr.io/adrianno1/aquarium-controller";
const publisherJobName = "Publish and verify multi-architecture image";

function requireText(value, description) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value.trim();
}

export function parsePiCredentials(contents) {
  const parsed = JSON.parse(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".data/pi-login.json must contain a JSON object.");
  }

  const host = requireText(parsed.host, "Pi host");
  const username = requireText(parsed.username, "Pi username");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new Error("Pi host contains unsupported characters.");
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(username)) {
    throw new Error("Pi username contains unsupported characters.");
  }

  let password;
  if (parsed.password !== undefined) {
    if (typeof parsed.password !== "string" || parsed.password.length === 0) {
      throw new Error("Pi password must be a non-empty string.");
    }
    password = parsed.password;
  }
  return { host, username, password };
}

export function selectSuccessfulMasterRun(runs, headSha) {
  if (!Array.isArray(runs)) {
    throw new Error("GitHub run response was not an array.");
  }
  const matchingRuns = runs.filter(
    (run) =>
      run !== null &&
      typeof run === "object" &&
      run.headSha === headSha &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  if (matchingRuns.length === 0) {
    throw new Error(`No successful completed master push CI run exists for ${headSha}.`);
  }
  return matchingRuns[0];
}

export function selectPublisherJob(response) {
  if (response === null || typeof response !== "object" || !Array.isArray(response.jobs)) {
    throw new Error("GitHub job response did not contain a jobs array.");
  }
  const matchingJobs = response.jobs.filter((job) => job.name === publisherJobName);
  if (matchingJobs.length !== 1) {
    throw new Error(`Expected exactly one ${publisherJobName} job.`);
  }
  const job = matchingJobs[0];
  if (job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`${publisherJobName} did not complete successfully.`);
  }
  if (!Number.isInteger(job.databaseId)) {
    throw new Error("Publisher job did not have a numeric database ID.");
  }
  return job;
}

export function parsePublishedImageReference(log) {
  const references = new Set(
    [...log.matchAll(/Published immutable image:\s+(ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64})/g)].map(
      (match) => match[1],
    ),
  );
  if (references.size !== 1) {
    throw new Error("Could not identify exactly one immutable image reference in the publisher log.");
  }
  const [reference] = references;
  if (!reference.startsWith(`${expectedImageRepository}@sha256:`)) {
    throw new Error(`CI published an unexpected image repository: ${reference}`);
  }
  return {
    reference,
    digest: reference.slice(`${expectedImageRepository}@sha256:`.length),
  };
}

export function parseBackupResult(output, username) {
  const fields = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.+)$/.exec(line);
    if (match) {
      if (fields.has(match[1])) {
        throw new Error(`Remote backup returned duplicate ${match[1]} fields.`);
      }
      fields.set(match[1], match[2]);
    }
  }
  if (!output.split(/\r?\n/).includes("LIVE_BACKUP_COMPLETE")) {
    throw new Error("Remote backup did not report successful completion.");
  }

  const bundle = fields.get("BUNDLE");
  const sha256 = fields.get("BUNDLE_SHA256");
  if (
    typeof bundle !== "string" ||
    !new RegExp(`^/home/${username}/aquarium-production-[A-Za-z0-9._-]+\\.tar\\.gz$`).test(bundle)
  ) {
    throw new Error("Remote backup returned an unsafe bundle path.");
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Remote backup returned an invalid SHA-256 digest.");
  }
  return { bundle, sha256 };
}

export function confirmationMatches(answer, headSha) {
  return answer === `DEPLOY ${headSha.slice(0, 12)}`;
}

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${options.description ?? command} failed with exit code ${result.status}.`);
  }
  return capture ? result.stdout : "";
}

function git(args, capture = true) {
  return run(
    "git",
    ["-c", `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`, ...args],
    { capture, description: `git ${args[0]}` },
  );
}

function readCredentials() {
  const credentialsPath = join(repositoryRoot, ".data", "pi-login.json");
  if (!existsSync(credentialsPath)) {
    throw new Error(`Missing ignored Pi credential file: ${credentialsPath}`);
  }
  return parsePiCredentials(readFileSync(credentialsPath, "utf8"));
}

function createSshEnvironment(credentials) {
  const environment = { ...process.env };
  if (process.platform === "win32" && credentials.password !== undefined) {
    environment.AQUARIUM_DEPLOY_ASKPASS = "1";
    environment.SSH_ASKPASS = join(repositoryRoot, "tools", "production-ssh-askpass.cmd");
    environment.SSH_ASKPASS_REQUIRE = "force";
    environment.DISPLAY = environment.DISPLAY || "aquarium-production-deploy";
  }
  return environment;
}

function sshArguments() {
  return [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
}

function remoteCommand(target, command, environment, capture = false) {
  return run("ssh", [...sshArguments(), target, command], {
    capture,
    env: environment,
    description: "remote Pi command",
  });
}

function parseJson(output, description) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function printHelp() {
  console.log(`Usage: npm run production:deploy [-- --dry-run]

Deploys the exact successful master CI image to the configured Raspberry Pi.
The command creates and verifies an off-host backup, requires typed confirmation,
and verifies or automatically rolls back the controller update.

Options:
  --dry-run  Resolve and display the exact release without contacting the Pi
  --help     Show this help`);
}

async function resolveRelease() {
  if (git(["branch", "--show-current"]).trim() !== "master") {
    throw new Error("Production deployment is allowed only from the local master branch.");
  }
  if (git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("Tracked working-tree changes must be committed and merged before deployment.");
  }

  git(["fetch", "--no-tags", "origin", "master"], false);
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const remoteSha = git(["rev-parse", "origin/master"]).trim();
  if (headSha !== remoteSha) {
    throw new Error("Local master is not the exact current origin/master commit.");
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Git returned an invalid release commit.");
  }

  run("gh", ["auth", "status"], { description: "GitHub CLI authentication check" });
  const runList = parseJson(
    run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        githubRepository,
        "--workflow",
        "CI",
        "--branch",
        "master",
        "--event",
        "push",
        "--commit",
        headSha,
        "--limit",
        "10",
        "--json",
        "databaseId,headSha,status,conclusion,url",
      ],
      { capture: true, description: "GitHub CI run lookup" },
    ),
    "GitHub CI run lookup",
  );
  const workflowRun = selectSuccessfulMasterRun(runList, headSha);
  if (!Number.isInteger(workflowRun.databaseId) || typeof workflowRun.url !== "string") {
    throw new Error("The selected GitHub run is missing its ID or URL.");
  }

  const jobResponse = parseJson(
    run(
      "gh",
      ["run", "view", "--repo", githubRepository, String(workflowRun.databaseId), "--json", "jobs"],
      {
        capture: true,
        description: "GitHub publisher job lookup",
      },
    ),
    "GitHub publisher job lookup",
  );
  const publisherJob = selectPublisherJob(jobResponse);
  const publisherLog = run(
    "gh",
    [
      "run",
      "view",
      "--repo",
      githubRepository,
      String(workflowRun.databaseId),
      "--job",
      String(publisherJob.databaseId),
      "--log",
    ],
    { capture: true, description: "GitHub publisher log lookup" },
  );
  const image = parsePublishedImageReference(publisherLog);
  return { headSha, workflowRun, image };
}

async function deploy() {
  const argumentsSet = new Set(process.argv.slice(2));
  if (argumentsSet.has("--help")) {
    printHelp();
    return;
  }
  for (const argument of argumentsSet) {
    if (argument !== "--dry-run") {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  const release = await resolveRelease();
  console.log("\nProduction deployment candidate");
  console.log(`  Commit: ${release.headSha}`);
  console.log(`  Image:  ${release.image.reference}`);
  console.log(`  CI:     ${release.workflowRun.url}`);

  if (argumentsSet.has("--dry-run")) {
    console.log("\nDry run complete. No Pi connection was made.");
    return;
  }

  const credentials = readCredentials();
  const target = `${credentials.username}@${credentials.host}`;
  console.log(`  Target: ${target}`);
  console.log("\nThis will create an off-host backup, then restart the production controller.");
  const expectedConfirmation = `DEPLOY ${release.headSha.slice(0, 12)}`;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type ${expectedConfirmation} to continue: `);
  prompt.close();
  if (!confirmationMatches(answer, release.headSha)) {
    throw new Error("Deployment confirmation did not match; nothing was changed on the Pi.");
  }

  const environment = createSshEnvironment(credentials);
  const remoteDirectory = `/tmp/aquarium-production-deploy-${release.headSha.slice(0, 12)}`;
  const localScripts = [
    join(repositoryRoot, "deployment", "pi-backup-production.sh"),
    join(repositoryRoot, "deployment", "pi-deploy-production.sh"),
    join(repositoryRoot, "deployment", "pi-verify-production.sh"),
  ];

  remoteCommand(target, `install -d -m 0700 -- ${remoteDirectory}`, environment);
  try {
    run("scp", [...sshArguments(), ...localScripts, `${target}:${remoteDirectory}/`], {
      env: environment,
      description: "deployment script upload",
    });

    console.log("\nCreating and verifying the pre-deployment recovery set...");
    const backupOutput = remoteCommand(
      target,
      `bash ${remoteDirectory}/pi-backup-production.sh ${release.headSha} ${release.image.digest}`,
      environment,
      true,
    );
    const backup = parseBackupResult(backupOutput, credentials.username);

    const localBackupDirectory = join(repositoryRoot, ".data", "pi-backups");
    mkdirSync(localBackupDirectory, { recursive: true });
    const localBackupPath = join(localBackupDirectory, basename(backup.bundle));
    if (existsSync(localBackupPath)) {
      throw new Error(`Refusing to replace existing off-host backup: ${localBackupPath}`);
    }
    run("scp", [...sshArguments(), `${target}:${backup.bundle}`, localBackupPath], {
      env: environment,
      description: "off-host production backup copy",
    });
    const localBackupSha256 = await sha256File(localBackupPath);
    if (localBackupSha256 !== backup.sha256) {
      throw new Error("Off-host backup SHA-256 does not match the verified Pi bundle.");
    }
    console.log(`Verified off-host backup: ${localBackupPath}`);
    remoteCommand(target, `rm -- ${backup.bundle}`, environment);

    console.log("\nDeploying the immutable CI image. The Pi script will roll back on failure...");
    remoteCommand(
      target,
      `bash ${remoteDirectory}/pi-deploy-production.sh ${release.headSha} ${release.image.digest}`,
      environment,
    );

    console.log("\nDeployment complete and verified.");
    console.log(`Controller: http://${credentials.host}:3001`);
    console.log(`Backup:     ${localBackupPath}`);
  } finally {
    try {
      remoteCommand(
        target,
        `rm -f -- ${remoteDirectory}/pi-backup-production.sh ${remoteDirectory}/pi-deploy-production.sh ${remoteDirectory}/pi-verify-production.sh && rmdir -- ${remoteDirectory}`,
        environment,
      );
    } catch (error) {
      console.error(`Warning: could not remove temporary Pi scripts: ${error.message}`);
    }
  }
}

async function main() {
  if (process.argv[2] === "--ssh-askpass") {
    if (process.env.AQUARIUM_DEPLOY_ASKPASS !== "1") {
      throw new Error("The SSH askpass helper can only be invoked by the deployment command.");
    }
    const credentials = readCredentials();
    if (credentials.password === undefined) {
      throw new Error("Pi credentials do not contain a password.");
    }
    process.stdout.write(credentials.password);
    return;
  }
  await deploy();
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nProduction deployment stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
