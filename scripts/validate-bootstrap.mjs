#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.argv.slice(2).includes("--runtime");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tama-kit-bootstrap-validation-"));
const project = join(temporaryRoot, "project");
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const packagedProject = join(temporaryRoot, "packaged-project");
const npxProject = join(temporaryRoot, "npx-project");
const npmCache = join(temporaryRoot, "npm-cache");
const composeFile = join(project, "compose.yaml");
const environmentFile = join(project, ".tama.env");

const SENSITIVE_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "SECRET_KEY_BASE",
  "TAMA_CLIENT_SECRET",
  "TAMA_JWT_SECRET",
  "TAMA_OAUTH_SIGNING_KEY",
  "TAMA_SETUP_TOKEN",
  "TAMA_VAULT_KEY",
];

mkdirSync(project);
mkdirSync(packageDirectory);
mkdirSync(packagedProject);
mkdirSync(npxProject);

/** @param {string} command @param {string[]} args @param {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} [options] */
function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/** @param {string} content */
function environmentValues(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

/** @param {unknown} error @param {"stdout" | "stderr"} stream */
function commandOutput(error, stream) {
  if (!error || typeof error !== "object" || !(stream in error)) {
    return "";
  }
  const output = error[stream];
  return typeof output === "string" ? output.trim() : "";
}

/** @param {string} content */
function redactRuntimeSecrets(content) {
  if (!content || !existsSync(environmentFile)) {
    return content;
  }
  const values = environmentValues(readFileSync(environmentFile, "utf8"));
  return SENSITIVE_ENVIRONMENT_VARIABLES.map((name) => values[name])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, value) => redacted.replaceAll(value, "[REDACTED]"), content);
}

/** @param {unknown} error */
function reportBootstrapFailure(error) {
  const stdout = redactRuntimeSecrets(commandOutput(error, "stdout"));
  const stderr = redactRuntimeSecrets(commandOutput(error, "stderr"));
  if (stdout) {
    console.error(`bootstrap stdout:\n${stdout}`);
  }
  if (stderr) {
    console.error(`bootstrap stderr:\n${stderr}`);
  }
  if (!runtime || !existsSync(composeFile)) {
    return;
  }

  for (const [label, args] of [
    ["status", ["compose", "-f", composeFile, "ps", "--all"]],
    ["logs", ["compose", "-f", composeFile, "logs", "--no-color", "--tail", "200"]],
  ]) {
    try {
      const output = redactRuntimeSecrets(execute("docker", args, { cwd: project }).trim());
      if (output) {
        console.error(`docker compose ${label}:\n${output}`);
      }
    } catch (diagnosticError) {
      const output = redactRuntimeSecrets(
        [commandOutput(diagnosticError, "stdout"), commandOutput(diagnosticError, "stderr")]
          .filter(Boolean)
          .join("\n"),
      );
      console.error(
        `warning: failed to collect Docker Compose ${label}${output ? `:\n${output}` : ""}`,
      );
    }
  }
}

try {
  const bootstrapArguments = [
    join(REPOSITORY_ROOT, "bin", "tama-kit.mjs"),
    "bootstrap",
    project,
    "--json",
  ];
  if (runtime) {
    bootstrapArguments.push("--start");
  }
  let bootstrapOutput;
  try {
    bootstrapOutput = execute(process.execPath, bootstrapArguments);
  } catch (error) {
    reportBootstrapFailure(error);
    throw error;
  }
  const result = JSON.parse(bootstrapOutput);
  assert.equal(result.ok, true);
  assert.equal(result.started, runtime);
  assert.equal(existsSync(join(project, "tama", ".tama-kit.json")), true);

  execute("docker", ["compose", "-f", composeFile, "config", "--quiet"], { cwd: project });
  execute("terraform", ["-chdir=tama", "fmt", "-check"], { cwd: project });
  execute("terraform", ["-chdir=tama", "init", "-backend=false", "-input=false"], {
    cwd: project,
  });
  execute("terraform", ["-chdir=tama", "validate"], { cwd: project });

  if (runtime) {
    const response = await fetch(result.healthUrl, { redirect: "follow" });
    assert.equal(response.ok, true);
    const environment = environmentValues(readFileSync(join(project, ".tama.env"), "utf8"));
    const setupUrl = `http://localhost:${environment.TAMA_PORT}/setup/root?token=${environment.TAMA_SETUP_TOKEN}`;
    const setupResponse = await fetch(setupUrl, { redirect: "follow" });
    assert.equal(setupResponse.ok, true);
  }

  const packed = JSON.parse(
    execute("npm", ["pack", "--json", "--pack-destination", packageDirectory, "--cache", npmCache]),
  );
  const tarball = join(packageDirectory, packed[0].filename);
  execute("npm", [
    "install",
    "--ignore-scripts",
    "--prefix",
    installDirectory,
    "--cache",
    npmCache,
    tarball,
  ]);
  const installedBinary = join(installDirectory, "node_modules", ".bin", "tama-kit");
  const packagedResult = JSON.parse(
    execute(installedBinary, ["bootstrap", packagedProject, "--dry-run", "--json"]),
  );
  assert.equal(packagedResult.ok, true);
  assert.equal(packagedResult.mode, "dry-run");

  const npxResult = JSON.parse(
    execute("npx", [
      "--yes",
      "--cache",
      npmCache,
      "--package",
      tarball,
      "tama-kit",
      "bootstrap",
      npxProject,
      "--dry-run",
      "--json",
    ]),
  );
  assert.equal(npxResult.ok, true);
  assert.equal(npxResult.mode, "dry-run");

  console.log(
    `Bootstrap validation passed (${runtime ? "runtime, Compose, Terraform, package" : "Compose, Terraform, package"}).`,
  );
} finally {
  if (runtime && existsSync(composeFile)) {
    try {
      execute("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], {
        cwd: project,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`warning: failed to clean up bootstrap containers: ${message}`);
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
