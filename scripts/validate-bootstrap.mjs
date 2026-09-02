#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

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
  "TAMA_OAUTH_PRIVATE_JWK",
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
  return parseEnv(content);
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

/**
 * Prove the running image implements the private-JWK contract: it publishes
 * exactly the generated key's public half at /.well-known/jwks.json with
 * RS256/sig metadata and no private parameters.
 * @param {string} baseUrl
 * @param {Record<string, string>} environment
 */
async function assertJwksContract(baseUrl, environment) {
  const jwksResponse = await fetch(`${baseUrl}/.well-known/jwks.json`);
  assert.equal(jwksResponse.status, 200, "JWKS endpoint did not respond");
  const document = /** @type {{ keys: Array<Record<string, unknown>> }} */ (
    await jwksResponse.json()
  );
  assert.ok(Array.isArray(document.keys), "JWKS document is missing keys");
  const entry = document.keys.find((key) => key.kid === environment.TAMA_OAUTH_PRIVATE_JWK_ID);
  assert.ok(entry, "JWKS document is missing the configured key");
  assert.equal(entry.kty, "RSA");
  assert.equal(entry.alg, "RS256");
  assert.equal(entry.use, "sig");
  for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
    assert.equal(member in entry, false, `JWKS entry exposes private member ${member}`);
  }
  const publicJwk = /** @type {Record<string, string>} */ (
    createPublicKey(
      createPrivateKey({ key: JSON.parse(environment.TAMA_OAUTH_PRIVATE_JWK), format: "jwk" }),
    ).export({ format: "jwk" })
  );
  assert.equal(entry.n, publicJwk.n);
  assert.equal(entry.e, publicJwk.e);
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
    "--skills",
    "local",
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
  assert.match(result.agentPrompt, /terraform -chdir=tama plan/u);
  assert.match(result.agentPrompt, /Do not run terraform apply until I explicitly approve/u);
  const generatedEnvironment = environmentValues(readFileSync(environmentFile, "utf8"));
  assert.equal(bootstrapOutput.includes(generatedEnvironment.TAMA_SETUP_TOKEN), false);
  assert.equal(existsSync(join(project, "tama", ".tama-kit.json")), true);
  assert.equal(existsSync(join(project, "tama", "AGENTS.md")), true);
  assert.equal(existsSync(join(project, ".agents", "skills", "graph-builder", "SKILL.md")), true);
  assert.equal(existsSync(join(project, ".agents", "skills", "graph-audit", "SKILL.md")), true);

  execute("docker", ["compose", "-f", composeFile, "config", "--quiet"], { cwd: project });
  execute("terraform", ["-chdir=tama", "fmt", "-check"], { cwd: project });
  execute("terraform", ["-chdir=tama", "init", "-backend=false", "-input=false"], {
    cwd: project,
  });
  execute("terraform", ["-chdir=tama", "validate"], { cwd: project });

  if (runtime) {
    const response = await fetch(result.healthUrl, { redirect: "follow" });
    assert.equal(response.ok, true);
    const setupUrl = `http://localhost:${generatedEnvironment.TAMA_PORT}/setup/root?token=${generatedEnvironment.TAMA_SETUP_TOKEN}`;
    const setupResponse = await fetch(setupUrl, { redirect: "follow" });
    assert.equal(setupResponse.ok, true);
    await assertJwksContract(
      `http://localhost:${generatedEnvironment.TAMA_PORT}`,
      generatedEnvironment,
    );
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
    execute(installedBinary, [
      "bootstrap",
      packagedProject,
      "--dry-run",
      "--json",
      "--skills",
      "local",
    ]),
  );
  assert.equal(packagedResult.ok, true);
  assert.equal(packagedResult.mode, "dry-run");
  assert.equal(packagedResult.skillMode, "local");
  assert.equal(
    packagedResult.changes.some((change) =>
      change.path.endsWith(".agents/skills/graph-builder/SKILL.md"),
    ),
    true,
  );

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
      "--skills",
      "local",
    ]),
  );
  assert.equal(npxResult.ok, true);
  assert.equal(npxResult.mode, "dry-run");
  assert.equal(npxResult.skillMode, "local");

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
