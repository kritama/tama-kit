// @ts-check

import { spawn } from "node:child_process";

import { startupError } from "../errors.mjs";
import { processEnvironment } from "./environment.mjs";

/** @param {string} command @param {string[]} args @param {import("node:child_process").SpawnOptions} options */
function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}`));
      }
    });
  });
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {import("../types.mjs").DevSetupPlan} plan @param {{quiet?: boolean}} [options] */
export async function startDevDatabase(plan, { quiet = false } = {}) {
  try {
    await runProcess(
      "docker",
      ["compose", "-f", plan.composeFile, "up", "-d", "--wait", "postgres"],
      {
        cwd: plan.root,
        env: processEnvironment(plan.environment),
        stdio: quiet ? "ignore" : "inherit",
      },
    );
  } catch (error) {
    throw startupError(`isolated PostgreSQL startup failed: ${errorMessage(error)}`);
  }
}

/** @param {import("../types.mjs").DevSetupPlan} plan @param {{quiet?: boolean}} [options] */
export async function runMixSetup(plan, { quiet = false } = {}) {
  try {
    await runProcess("bash", ["-c", "source .envrc && mix setup"], {
      cwd: plan.root,
      env: processEnvironment(plan.environment),
      stdio: quiet ? "ignore" : "inherit",
    });
  } catch (error) {
    throw startupError(`mix setup failed: ${errorMessage(error)}`);
  }
}

/** @param {import("../types.mjs").DevSetupPlan} plan @param {{quiet?: boolean}} [options] */
export async function runTestFoundationSetup(plan, { quiet = false } = {}) {
  try {
    await runProcess("bash", ["-c", "source .envrc && MIX_ENV=test mix cmd ./scripts/setup.sh"], {
      cwd: plan.root,
      env: processEnvironment(plan.environment),
      stdio: quiet ? "ignore" : "inherit",
    });
  } catch (error) {
    throw startupError(`test foundation setup failed: ${errorMessage(error)}`);
  }
}
