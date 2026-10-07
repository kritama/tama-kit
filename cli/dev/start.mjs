// @ts-check

import { startupError } from "../errors.mjs";
import { CapturedProcessError, runCapturedProcess } from "../shared/captured-process.mjs";
import { processEnvironment } from "../shared/environment.mjs";
import { runProcess } from "../shared/process.mjs";
import { devSetupDiagnostic, lockedProvider, toolInstallDiagnostic } from "./diagnostics.mjs";

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Trusted Node spawn errno (ENOENT, EACCES, ...); only allowlisted values
 * are accepted downstream. Arbitrary error text is never forwarded.
 * @param {unknown} error
 */
function spawnErrorCode(error) {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * Run a development setup subprocess. In quiet (JSON) mode both streams are
 * captured internally with bounds so the diagnostic projector can recognize
 * safe phase facts; in interactive mode the child streams are inherited so
 * the user sees the full subprocess output.
 * @param {"database"|"mix-setup"|"tool-install"|"foundation"} phase
 * @param {string} label public failure label, message text unchanged
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env?: NodeJS.ProcessEnv, quiet: boolean}} options
 */
async function runDevSubprocess(phase, label, command, args, options) {
  try {
    if (options.quiet) {
      await runCapturedProcess(command, args, { cwd: options.cwd, env: options.env });
    } else {
      await runProcess(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    }
  } catch (error) {
    // Always attach a safe phase diagnostic: when the child was captured,
    // project from its bounded tails; when the executable could not spawn
    // (ENOENT/EACCES/...), project the static phase diagnostic plus the
    // allowlisted spawn errno. The message itself is unchanged.
    const trusted = phase === "foundation" ? { provider: lockedProvider(options.cwd) } : {};
    const diagnostic =
      error instanceof CapturedProcessError
        ? devSetupDiagnostic(phase, { stdout: error.stdout, stderr: error.stderr }, trusted)
        : devSetupDiagnostic(
            phase,
            { stdout: "", stderr: "" },
            { ...trusted, spawnFailure: spawnErrorCode(error) },
          );
    // root is retained internally so the JSON re-projector can verify the
    // provider record against the checkout's own lock file before publishing.
    throw startupError(`${label} failed: ${errorMessage(error)}`, {
      diagnostic,
      root: options.cwd,
    });
  }
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
 * Probe a command once and classify the outcome so a present-but-broken
 * tool is never reported as missing. Only a spawn ENOENT means the
 * executable is absent; permission errors, symlink loops, and nonzero
 * exits all mean it is present but not working.
 * @param {string} command @param {string[]} args @param {string} cwd
 * @returns {Promise<"working" | "present" | "missing">}
 */
async function probeCommand(command, args, cwd) {
  try {
    await runProcess(command, args, { cwd, stdio: "ignore" });
    return "working";
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    return "present";
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
  const mise = await probeCommand("mise", ["--version"], plan.root);
  if (mise !== "working") {
    if (mise === "missing") {
      throw startupError(
        "OpenTofu is required; install the version declared in .tool-versions or install mise",
        { diagnostic: toolInstallDiagnostic("opentofu-unavailable") },
      );
    }
    throw startupError("OpenTofu is required, but the installed mise could not be executed", {
      diagnostic: toolInstallDiagnostic("opentofu-unusable"),
    });
  }
  await runDevSubprocess("tool-install", "OpenTofu installation", "mise", ["install", "opentofu"], {
    cwd: plan.root,
    quiet,
  });
  if (
    !(await commandSucceeds("mise", ["exec", "opentofu", "--", "tofu", "--version"], plan.root))
  ) {
    throw startupError("mise installed OpenTofu but could not execute it", {
      diagnostic: toolInstallDiagnostic("opentofu-unusable"),
    });
  }
  return "mise";
}

/** @param {import("../types.mjs").DevSetupPlan} plan @param {{quiet?: boolean}} [options] */
export async function startDevDatabase(plan, { quiet = false } = {}) {
  await runDevSubprocess(
    "database",
    "isolated PostgreSQL startup",
    "docker",
    ["compose", "-f", plan.composeFile, "up", "-d", "--wait", "postgres"],
    { cwd: plan.root, env: processEnvironment(plan.environment), quiet },
  );
}

/** @param {import("../types.mjs").DevSetupPlan} plan @param {{quiet?: boolean}} [options] */
export async function runMixSetup(plan, { quiet = false } = {}) {
  await runDevSubprocess("mix-setup", "mix setup", "bash", ["-c", "source .envrc && mix setup"], {
    cwd: plan.root,
    env: processEnvironment(plan.environment),
    quiet,
  });
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
  const command = "source .envrc && MIX_ENV=test mix cmd ./scripts/setup.sh";
  const executable = resolvedTofuRunner === "mise" ? "mise" : "bash";
  const args =
    resolvedTofuRunner === "mise"
      ? ["exec", "opentofu", "--", "bash", "-c", command]
      : ["-c", command];
  await runDevSubprocess("foundation", "test foundation setup", executable, args, {
    cwd: plan.root,
    env: processEnvironment(plan.environment),
    quiet,
  });
  return "created";
}
