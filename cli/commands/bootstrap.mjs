// @ts-check

import { relative } from "node:path";
import { parseArgs } from "node:util";
import { formatAgentSetupPrompt } from "../bootstrap/agent-prompt.mjs";
import { formatComposeUpCommand } from "../bootstrap/compose-command.mjs";
import { inspectProject } from "../bootstrap/detect-project.mjs";
import { readSetupUrl } from "../bootstrap/environment.mjs";
import { readAgentSkillMode } from "../bootstrap/manifest.mjs";
import { createBootstrapPlan, publicPlan } from "../bootstrap/plan.mjs";
import { startCompose, validateCompose, validateComposePrerequisite } from "../bootstrap/start.mjs";
import { applyOperationsTransactionally } from "../bootstrap/write.mjs";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import { createProgressBar, paint, renderBox } from "../terminal.mjs";

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
 * @property {import("../types.mjs").AgentSkillMode} [skillMode]
 * @property {boolean} dryRun
 * @property {boolean} start
 * @property {boolean} json
 * @property {boolean} noColor
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
    "  --skills <mode>        Agent skills: local or manual",
    "  --dry-run              Inspect and report without writing",
    "  --start                Start Compose and wait for Tama health",
    "  --json                 Emit machine-readable output",
    "  --no-color             Disable terminal colors",
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
  const hasWhitespaceOrControl = [...value].some(
    (character) => /\s/u.test(character) || character.charCodeAt(0) <= 0x1f,
  );
  if (value.length === 0 || hasWhitespaceOrControl) {
    throw usageError("image must be a non-empty container reference without whitespace");
  }
  return value;
}

/** @param {string | undefined} value */
function parseSkillMode(value) {
  if (value === undefined || value === "local" || value === "manual") {
    return value;
  }
  throw usageError(`skills must be either local or manual: ${value}`);
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
        skills: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        start: { type: "boolean", default: false },
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
    skillMode: parseSkillMode(parsed.values.skills),
    dryRun: parsed.values["dry-run"] ?? false,
    start: parsed.values.start ?? false,
    json: parsed.values.json ?? false,
    noColor: parsed.values["no-color"] ?? false,
    help: parsed.values.help ?? false,
  };
}

/**
 * @param {BootstrapCommandOptions} options
 * @param {CommandIO} io
 * @param {string} tamaDirectory
 * @returns {Promise<import("../types.mjs").AgentSkillMode>}
 */
async function selectSkillMode(options, io, tamaDirectory) {
  const recorded = readAgentSkillMode(tamaDirectory);
  if (recorded === "local") {
    if (options.skillMode === "manual") {
      throw usageError(
        "repository-local Tama Kit skills are already managed; --skills manual does not uninstall them",
      );
    }
    return "local";
  }
  if (options.skillMode) {
    return options.skillMode;
  }
  if (recorded) {
    return recorded;
  }
  if (options.json || !io.interactive || !io.prompt) {
    return "manual";
  }

  while (true) {
    const answer = (
      await io.prompt(
        "Install Tama Kit's graph-builder and graph-audit skills in this repository? " +
          "Choose no to install them yourself later. [Y/n] ",
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      return "local";
    }
    if (answer === "n" || answer === "no") {
      return "manual";
    }
    io.stderr("Please answer yes or no.");
  }
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
    agentPrompt: dryRun ? null : formatAgentSetupPrompt(plan),
    ...result,
  };
}

/**
 * @param {CommandIO} io
 * @param {BootstrapResult} result
 * @param {boolean} color
 * @param {string | null} setupUrl
 */
function printHuman(io, result, color, setupUrl) {
  io.stdout(paint(color, "bold", `Tama Kit bootstrap (${result.mode})`));
  io.stdout(`${paint(color, "dim", "Project:")} ${result.root}`);
  io.stdout(`${paint(color, "dim", "Framework:")} ${result.framework}`);
  io.stdout(`${paint(color, "dim", "Compose:")} ${relative(result.root, result.composeFile)}`);
  io.stdout(`${paint(color, "dim", "Global foundation:")} ${result.terraform.foundation}`);
  io.stdout(
    `${paint(color, "dim", "Agent skills:")} ${
      result.skillMode === "local"
        ? paint(color, "green", "repository-local (.agents/skills)")
        : paint(color, "yellow", "manual installation")
    }`,
  );
  io.stdout("");

  const changes = result.changes.filter((change) => change.action !== "unchanged");
  if (changes.length === 0) {
    io.stdout(paint(color, "green", "No changes required."));
  } else {
    io.stdout(paint(color, "bold", "Changes:"));
    for (const change of changes) {
      const display = relative(result.root, change.path) || ".";
      const actionStyle = change.action === "create" ? "green" : "yellow";
      const action = paint(color, actionStyle, change.action.padEnd(6));
      const sensitive = change.sensitive ? paint(color, "magenta", " (sensitive)") : "";
      io.stdout(`  ${action} ${display}${sensitive}`);
    }
  }

  if (result.skillMode === "manual") {
    io.stdout("");
    io.stdout(paint(color, "bold", "Install the agent skills later with either:"));
    io.stdout(`  ${paint(color, "cyan", "npx skills add kritama/tama-kit --agent codex --yes")}`);
    io.stdout("");
    io.stdout("Or install the Tama Kit Codex plugin:");
    io.stdout(`  ${paint(color, "cyan", "codex plugin marketplace add kritama/tama-kit")}`);
    io.stdout(`  ${paint(color, "cyan", "codex plugin add tama-kit@upmaru")}`);
  }

  /** @param {{title?: string, lines: string[], style?: import("../terminal.mjs").PaintStyle}} box */
  function printBox(box) {
    const maxWidth = io.columns === undefined ? undefined : Math.max(1, io.columns - 4);
    for (const line of renderBox({ ...box, color, maxWidth })) {
      io.stdout(line);
    }
  }

  /** @param {string | null} url */
  function printSetupUrlBox(url) {
    if (!url) {
      return;
    }
    io.stdout("");
    printBox({ title: "Private setup URL", lines: [url], style: "magenta" });
  }

  if (result.started) {
    io.stdout("");
    io.stdout(`Tama is healthy at ${result.healthUrl}`);
    printSetupUrlBox(setupUrl);
  } else if (result.mode !== "dry-run") {
    const composeReference = relative(io.cwd, result.composeFile) || result.composeFile;
    io.stdout("");
    printBox({ title: "Next", lines: [formatComposeUpCommand(composeReference)], style: "cyan" });
    printSetupUrlBox(setupUrl);
  }

  if (result.agentPrompt) {
    io.stdout("");
    printBox({
      title: "Copy this prompt into your coding agent",
      lines: result.agentPrompt.split("\n"),
    });
  }
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
async function executeBootstrap(argv, io) {
  const options = parse(argv);
  if (options.help) {
    io.stdout(usage());
    return EXIT_CODES.SUCCESS;
  }

  const inspection = inspectProject({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
  });
  const skillMode = await selectSkillMode(options, io, inspection.tamaDirectory);
  const color = Boolean(io.color && !options.noColor && !options.json);
  const progress = createProgressBar(io, {
    enabled: !options.json,
    color,
    total: options.dryRun ? 1 : options.start ? 5 : 4,
  });

  progress.update(0, "Planning bootstrap changes");
  /** @type {BootstrapPlan} */
  let plan;
  let healthUrl;
  try {
    plan = createBootstrapPlan({
      cwd: io.cwd,
      targetPath: options.targetPath,
      composePath: options.composePath,
      port: options.port,
      image: options.image,
      skillMode,
    });
    if (options.dryRun) {
      progress.finish("Plan ready");
    } else {
      progress.update(1, "Checking Docker Compose");
      validateComposePrerequisite();
      progress.update(2, "Writing managed files");
      await applyOperationsTransactionally(plan.operations, () => {
        progress.update(3, "Validating Compose configuration");
        return validateCompose(plan, { checkPrerequisite: false });
      });
      if (options.start) {
        progress.update(4, "Starting Tama services");
        healthUrl = await startCompose(plan, { quiet: options.json });
      }
      progress.finish(options.start ? "Tama is ready" : "Bootstrap complete");
    }
  } catch (error) {
    progress.stop();
    throw error;
  }

  const result = resultEnvelope(plan, {
    dryRun: options.dryRun,
    started: options.start,
    healthUrl,
  });
  if (options.json) {
    io.stdout(JSON.stringify(result, null, 2));
  } else {
    const setupUrl = options.dryRun ? null : readSetupUrl(plan.root);
    if (setupUrl) {
      result.agentPrompt = formatAgentSetupPrompt(plan, { setupUrl });
    }
    printHuman(io, result, color, setupUrl);
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
