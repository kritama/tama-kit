// @ts-check

import { parseArgs } from "node:util";
import { relative } from "node:path";

import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import { formatComposeUpCommand } from "../bootstrap/compose-command.mjs";
import { createBootstrapPlan, publicPlan } from "../bootstrap/plan.mjs";
import {
  startCompose,
  validateCompose,
  validateComposePrerequisite,
} from "../bootstrap/start.mjs";
import { applyOperationsTransactionally } from "../bootstrap/write.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapResult} BootstrapResult */
/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").ExitCode} ExitCode */

/**
 * @typedef {object} BootstrapCommandOptions
 * @property {string} [targetPath]
 * @property {string} [composePath]
 * @property {number} [port]
 * @property {string} [image]
 * @property {boolean} dryRun
 * @property {boolean} start
 * @property {boolean} json
 * @property {boolean} help
 */

function usage() {
  return [
    "Usage: tama-kit bootstrap [path] [options]",
    "",
    "Options:",
    "  --compose <path>       Select an existing Compose file",
    "  --port <port>          Host port for Tama (default: 4000)",
    "  --image <reference>    Override the tested Tama image",
    "  --dry-run              Inspect and report without writing",
    "  --start                Start Compose and wait for Tama health",
    "  --json                 Emit machine-readable output",
    "  -h, --help             Show help",
  ].join("\n");
}

/** @param {string | undefined} value */
function parsePort(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw usageError(`port must be an integer: ${value}`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) {
    throw usageError(`port must be between 1 and 65535: ${value}`);
  }
  return port;
}

/** @param {string | undefined} value */
function validateImage(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || /[\s\x00-\x1f]/u.test(value)) {
    throw usageError("image must be a non-empty container reference without whitespace");
  }
  return value;
}

/** @param {string[]} argv @returns {BootstrapCommandOptions} */
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        compose: { type: "string" },
        port: { type: "string" },
        image: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        start: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`${message}\n\n${usage()}`);
  }
  if (parsed.positionals.length > 1) {
    throw usageError(`expected at most one project path\n\n${usage()}`);
  }
  if (parsed.values.start && parsed.values["dry-run"]) {
    throw usageError("--start cannot be combined with --dry-run");
  }
  return {
    targetPath: parsed.positionals[0],
    composePath: parsed.values.compose,
    port: parsePort(parsed.values.port),
    image: validateImage(parsed.values.image),
    dryRun: parsed.values["dry-run"] ?? false,
    start: parsed.values.start ?? false,
    json: parsed.values.json ?? false,
    help: parsed.values.help ?? false,
  };
}

/**
 * @param {BootstrapPlan} plan
 * @param {{dryRun: boolean, started: boolean, healthUrl?: string}} status
 * @returns {BootstrapResult}
 */
function resultEnvelope(plan, { dryRun, started, healthUrl }) {
  const result = publicPlan(plan);
  return {
    ok: true,
    mode: dryRun ? "dry-run" : "write",
    started,
    healthUrl: healthUrl ?? null,
    ...result,
  };
}

/** @param {CommandIO} io @param {BootstrapResult} result */
function printHuman(io, result) {
  io.stdout(`Tama Kit bootstrap (${result.mode})`);
  io.stdout(`Project: ${result.root}`);
  io.stdout(`Framework: ${result.framework}`);
  io.stdout(`Compose: ${relative(result.root, result.composeFile)}`);
  io.stdout(`Global foundation: ${result.terraform.foundation}`);
  io.stdout("");

  const changes = result.changes.filter((change) => change.action !== "unchanged");
  if (changes.length === 0) {
    io.stdout("No changes required.");
  } else {
    io.stdout("Changes:");
    for (const change of changes) {
      const display = relative(result.root, change.path) || ".";
      io.stdout(`  ${change.action.padEnd(6)} ${display}${change.sensitive ? " (sensitive)" : ""}`);
    }
  }

  if (result.started) {
    io.stdout("");
    io.stdout(`Tama is healthy at ${result.healthUrl}`);
    io.stdout(
      "Setup: load .tama.env, then open http://localhost:${TAMA_PORT}/setup/root?token=${TAMA_SETUP_TOKEN}",
    );
  } else if (result.mode !== "dry-run") {
    io.stdout("");
    io.stdout(`Next: ${formatComposeUpCommand(result.composeFile)}`);
    io.stdout(
      "Setup: load .tama.env, then open http://localhost:${TAMA_PORT}/setup/root?token=${TAMA_SETUP_TOKEN}",
    );
  }
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
async function executeBootstrap(argv, io) {
  const options = parse(argv);
  if (options.help) {
    io.stdout(usage());
    return EXIT_CODES.SUCCESS;
  }

  const plan = createBootstrapPlan({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
    port: options.port,
    image: options.image,
  });

  let healthUrl;
  if (!options.dryRun) {
    validateComposePrerequisite();
    await applyOperationsTransactionally(plan.operations, () =>
      validateCompose(plan, { checkPrerequisite: false }),
    );
    if (options.start) {
      healthUrl = await startCompose(plan, { quiet: options.json });
    }
  }

  const result = resultEnvelope(plan, {
    dryRun: options.dryRun,
    started: options.start,
    healthUrl,
  });
  if (options.json) {
    io.stdout(JSON.stringify(result, null, 2));
  } else {
    printHuman(io, result);
  }
  return EXIT_CODES.SUCCESS;
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
export async function runBootstrap(argv, io) {
  const jsonRequested = argv.includes("--json");
  try {
    return await executeBootstrap(argv, io);
  } catch (error) {
    if (!jsonRequested) {
      throw error;
    }
    const cliError =
      error instanceof CLIError
        ? error
        : new CLIError(error instanceof Error ? error.message : String(error));
    io.stdout(
      JSON.stringify({
        ok: false,
        error: {
          category: cliError.category,
          exitCode: cliError.exitCode,
          message: cliError.message,
        },
      }),
    );
    return cliError.exitCode;
  }
}
