// @ts-check

import { relative } from "node:path";
import { parseArgs } from "node:util";

import { validateCompose, validateComposePrerequisite } from "../bootstrap/start.mjs";
import { applyOperationsTransactionally } from "../bootstrap/write.mjs";
import { processEnvironment, readDevSetupUrl } from "../dev/environment.mjs";
import { createDevSetupPlan, publicDevSetupPlan } from "../dev/plan.mjs";
import { runMixSetup, runTestFoundationSetup, startDevDatabase } from "../dev/start.mjs";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import { createProgressBar, paint } from "../terminal.mjs";

/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").DevSetupPlan} DevSetupPlan */
/** @typedef {import("../types.mjs").ExitCode} ExitCode */

/**
 * @typedef {object} DevCommandOptions
 * @property {string} [targetPath]
 * @property {number} [postgresPort]
 * @property {boolean} prepareOnly
 * @property {boolean} dryRun
 * @property {boolean} json
 * @property {boolean} noColor
 * @property {boolean} help
 */

function usage() {
  return [
    "Usage: tama-kit dev setup [path] [options]",
    "",
    "Prepare a Tama source checkout for native Phoenix development with an isolated",
    "pgvector PostgreSQL database managed by compose.yml.",
    "",
    "Options:",
    "  --postgres-port <port>  Loopback port for Compose PostgreSQL (default: 55432)",
    "  --prepare-only          Generate private environment files without starting services",
    "  --dry-run               Inspect and report without writing or starting services",
    "  --json                  Emit machine-readable output without secrets",
    "  --no-color              Disable terminal colors",
    "  -h, --help              Show help",
  ].join("\n");
}

/** @param {string | undefined} value */
function parsePort(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw usageError(`postgres port must be an integer: ${value}`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) {
    throw usageError(`postgres port must be between 1 and 65535: ${value}`);
  }
  return port;
}

/** @param {string[]} argv @returns {DevCommandOptions} */
function parse(argv) {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return {
      prepareOnly: false,
      dryRun: false,
      json: false,
      noColor: false,
      help: true,
    };
  }
  if (subcommand !== "setup") {
    throw usageError(`unknown dev command: ${subcommand}\n\n${usage()}`);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        "postgres-port": { type: "string" },
        "prepare-only": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
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
    throw usageError(`expected at most one Tama source path\n\n${usage()}`);
  }
  return {
    targetPath: parsed.positionals[0],
    postgresPort: parsePort(parsed.values["postgres-port"]),
    prepareOnly: parsed.values["prepare-only"] ?? false,
    dryRun: parsed.values["dry-run"] ?? false,
    json: parsed.values.json ?? false,
    noColor: parsed.values["no-color"] ?? false,
    help: parsed.values.help ?? false,
  };
}

/** @param {CommandIO} io @param {ReturnType<typeof resultEnvelope>} result @param {boolean} color @param {string | null} setupUrl */
function printHuman(io, result, color, setupUrl) {
  io.stdout(paint(color, "bold", `Tama Kit development setup (${result.mode})`));
  io.stdout(`${paint(color, "dim", "Project:")} ${result.root}`);
  io.stdout(`${paint(color, "dim", "Compose:")} ${relative(result.root, result.composeFile)}`);
  io.stdout(
    `${paint(color, "dim", "PostgreSQL:")} isolated container at 127.0.0.1:${result.postgres.port}`,
  );
  io.stdout("");

  const changes = result.changes.filter((change) => change.action !== "unchanged");
  if (changes.length === 0) {
    io.stdout(paint(color, "green", "No environment changes required."));
  } else {
    io.stdout(paint(color, "bold", "Changes:"));
    for (const change of changes) {
      const actionStyle = change.action === "create" ? "green" : "yellow";
      io.stdout(
        `  ${paint(color, actionStyle, change.action.padEnd(6))} ${relative(result.root, change.path)}${
          change.sensitive ? paint(color, "magenta", " (sensitive)") : ""
        }`,
      );
    }
  }

  if (result.databaseStarted) {
    io.stdout("");
    io.stdout(
      paint(color, "green", "Compose PostgreSQL is healthy; development and test setup completed."),
    );
  }
  if (setupUrl) {
    io.stdout("");
    io.stdout(paint(color, "bold", "Private setup URL:"));
    io.stdout(`  ${paint(color, "magenta", setupUrl)}`);
  }
  if (result.mode !== "dry-run") {
    io.stdout("");
    io.stdout(paint(color, "bold", "Next:"));
    io.stdout(`  ${paint(color, "cyan", "direnv allow")}`);
    if (result.prepareOnly) {
      io.stdout(`  ${paint(color, "cyan", "tama-kit dev setup")}`);
    } else {
      io.stdout(`  ${paint(color, "cyan", "mix phx.server")}`);
    }
  }
}

/** @param {ReturnType<typeof createDevSetupPlan>} plan @param {{dryRun: boolean, prepareOnly: boolean, databaseStarted: boolean, mixSetup: boolean, testFoundationSetup: boolean}} status */
function resultEnvelope(plan, status) {
  return {
    ok: true,
    mode: status.dryRun ? "dry-run" : "write",
    prepareOnly: status.prepareOnly,
    databaseStarted: status.databaseStarted,
    mixSetup: status.mixSetup,
    testFoundationSetup: status.testFoundationSetup,
    ...publicDevSetupPlan(plan),
  };
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
async function executeDev(argv, io) {
  const options = parse(argv);
  if (options.help) {
    io.stdout(usage());
    return EXIT_CODES.SUCCESS;
  }
  const color = Boolean(io.color && !options.noColor && !options.json);
  const fullSetup = !options.dryRun && !options.prepareOnly;
  const progress = createProgressBar(io, {
    enabled: !options.json,
    color,
    total: options.dryRun ? 1 : fullSetup ? 7 : 2,
  });
  progress.update(0, "Planning development setup");
  /** @type {DevSetupPlan} */
  let plan;
  try {
    plan = createDevSetupPlan({
      cwd: io.cwd,
      targetPath: options.targetPath,
      postgresPort: options.postgresPort,
    });
    if (options.dryRun) {
      progress.finish("Plan ready");
    } else if (options.prepareOnly) {
      progress.update(1, "Writing private environment files");
      await applyOperationsTransactionally(plan.operations, () => undefined);
      progress.finish("Environment prepared");
    } else {
      progress.update(1, "Checking Docker Compose");
      validateComposePrerequisite();
      progress.update(2, "Writing private environment files");
      await applyOperationsTransactionally(plan.operations, () => {
        progress.update(3, "Validating compose.yml");
        return validateCompose(plan, {
          checkPrerequisite: false,
          env: processEnvironment(plan.environment),
        });
      });
      progress.update(4, "Starting isolated PostgreSQL");
      await startDevDatabase(plan, { quiet: options.json });
      progress.update(5, "Running mix setup");
      await runMixSetup(plan, { quiet: options.json });
      progress.update(6, "Provisioning the test foundation");
      await runTestFoundationSetup(plan, { quiet: options.json });
      progress.finish("Development environment ready");
    }
  } catch (error) {
    progress.stop();
    throw error;
  }

  const result = resultEnvelope(plan, {
    dryRun: options.dryRun,
    prepareOnly: options.prepareOnly,
    databaseStarted: fullSetup,
    mixSetup: fullSetup,
    testFoundationSetup: fullSetup,
  });
  if (options.json) {
    io.stdout(JSON.stringify(result, null, 2));
  } else {
    const setupUrl = options.dryRun ? null : readDevSetupUrl(plan.root);
    printHuman(io, result, color, setupUrl);
  }
  return EXIT_CODES.SUCCESS;
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
export async function runDev(argv, io) {
  const jsonRequested = argv.includes("--json");
  try {
    return await executeDev(argv, io);
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
