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

/** @param {string} command @param {string[]} args @param {string} cwd */
async function commandSucceeds(command, args, cwd) {
  try {
    await runProcess(command, args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("../types.mjs").DevSetupPlan} plan
 * @param {{quiet?: boolean}} [options]
 * @returns {Promise<"direct" | "mise">}
 */
export async function ensureOpenTofu(plan, { quiet = false } = {}) {
  if (await commandSucceeds("tofu", ["--version"], plan.root)) {
    return "direct";
  }
  if (!(await commandSucceeds("mise", ["--version"], plan.root))) {
    throw startupError(
      "OpenTofu is required; install the version declared in .tool-versions or install mise",
    );
  }
  try {
    await runProcess("mise", ["install", "opentofu"], {
      cwd: plan.root,
      stdio: quiet ? "ignore" : "inherit",
    });
  } catch (error) {
    throw startupError(`OpenTofu installation failed: ${errorMessage(error)}`);
  }
  if (
    !(await commandSucceeds("mise", ["exec", "opentofu", "--", "tofu", "--version"], plan.root))
  ) {
    throw startupError("mise installed OpenTofu but could not execute it");
  }
  return "mise";
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

/** @param {import("../types.mjs").DevSetupPlan} plan */
async function testFoundationReady(plan) {
  return commandSucceeds(
    "bash",
    [
      "-c",
      "source .envrc && MIX_ENV=test mix run -e 'if Tama.Global.space(), do: :ok, else: System.halt(1)'",
    ],
    plan.root,
  );
}

/**
 * @param {import("../types.mjs").DevSetupPlan} plan
 * @param {{quiet?: boolean, tofuRunner?: "direct" | "mise"}} [options]
 * @returns {Promise<"preserved" | "created">}
 */
export async function runTestFoundationSetup(plan, { quiet = false, tofuRunner } = {}) {
  if (await testFoundationReady(plan)) {
    return "preserved";
  }
  const resolvedTofuRunner = tofuRunner ?? (await ensureOpenTofu(plan, { quiet }));
  try {
    const command = "source .envrc && MIX_ENV=test mix cmd ./scripts/setup.sh";
    const executable = resolvedTofuRunner === "mise" ? "mise" : "bash";
    const args =
      resolvedTofuRunner === "mise"
        ? ["exec", "opentofu", "--", "bash", "-c", command]
        : ["-c", command];
    await runProcess(executable, args, {
      cwd: plan.root,
      env: processEnvironment(plan.environment),
      stdio: quiet ? "ignore" : "inherit",
    });
    return "created";
  } catch (error) {
    throw startupError(`test foundation setup failed: ${errorMessage(error)}`);
  }
}
