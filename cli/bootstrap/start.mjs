// @ts-check

import { execFileSync, spawn } from "node:child_process";

import { prerequisiteError, startupError } from "../errors.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {Promise<void>}
 */
function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}`));
      }
    });
  });
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function validateComposePrerequisite() {
  /** @type {string} */
  let output;
  try {
    output = execFileSync("docker", ["compose", "version", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw prerequisiteError("Docker Compose 2.20.0 or newer is required");
    }
    throw prerequisiteError("Docker Compose 2.20.0 or newer is required and could not be detected");
  }
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    throw prerequisiteError(`cannot parse Docker Compose version: ${output}`);
  }
  const [, major, minor] = match.map(Number);
  if (major < 2 || (major === 2 && minor < 20)) {
    throw prerequisiteError(`Docker Compose 2.20.0 or newer is required; found ${output}`);
  }
}

/**
 * @param {BootstrapPlan} plan
 * @param {{quiet?: boolean, checkPrerequisite?: boolean}} [options]
 */
export async function validateCompose(
  plan,
  { quiet = true, checkPrerequisite = true } = {},
) {
  if (checkPrerequisite) {
    validateComposePrerequisite();
  }
  try {
    await runProcess(
      "docker",
      ["compose", "-f", plan.composeFile, "config", "--quiet"],
      {
        cwd: plan.root,
        stdio: quiet ? "ignore" : "inherit",
      },
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw prerequisiteError("Docker Compose is required to validate the generated integration");
    }
    throw prerequisiteError(`Docker Compose validation failed: ${errorMessage(error)}`);
  }
}

/** @param {number} port @param {number} [timeoutMs] @returns {Promise<string>} */
async function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://localhost:${port}/`;
  /** @type {Error | undefined} */
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return url;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw startupError(
    `Tama did not become healthy at ${url} within ${Math.round(timeoutMs / 1000)} seconds: ${lastError?.message ?? "unknown error"}`,
  );
}

/** @param {BootstrapPlan} plan @returns {Promise<string>} */
export async function startCompose(plan) {
  try {
    await runProcess(
      "docker",
      ["compose", "-f", plan.composeFile, "up", "-d", "tama"],
      { cwd: plan.root, stdio: "inherit" },
    );
  } catch (error) {
    throw startupError(`Docker Compose startup failed: ${errorMessage(error)}`);
  }
  return waitForHealth(plan.port);
}
