// @ts-check
import { formatAgentSetupPrompt } from "../bootstrap/agent-prompt.mjs";
import { inspectProject } from "../bootstrap/detect-project.mjs";
import { readSetupUrl } from "../bootstrap/environment.mjs";
import { readAgentSkillMode } from "../bootstrap/manifest.mjs";
import { prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import { printHuman, resultEnvelope } from "../output/bootstrap.mjs";
import { createProgressBar } from "../terminal.mjs";
import { runBootstrapWorkflow } from "../workflows/bootstrap.mjs";
import { mcpAppOptions } from "../workflows/options.mjs";
import { bootstrapUsage, parseBootstrap } from "./bootstrap-options.mjs";

/** @typedef {import("../types.mjs").BootstrapCommandOptions} BootstrapCommandOptions */
/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").ExitCode} ExitCode */
/** @typedef {import("../types.mjs").McpAppPrepared} McpAppPrepared */

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
        "Install Tama Kit's agent skills in this repository? " +
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

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
async function executeBootstrap(argv, io) {
  const options = parseBootstrap(argv);
  if (options.help) {
    io.stdout(bootstrapUsage());
    return EXIT_CODES.SUCCESS;
  }

  const inspection = inspectProject({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
  });
  const skillMode = await selectSkillMode(options, io, inspection.tamaDirectory);
  /** @type {McpAppPrepared | null} */
  let mcpAppPrepared = null;
  if (options.mcpApp) {
    mcpAppPrepared = await prepareMcpApp({
      root: inspection.root,
      tamaDirectory: inspection.tamaDirectory,
      framework: inspection.framework,
      options: mcpAppOptions(options),
      nonInteractive: options.json || !io.interactive,
      io,
    });
    options.allowedOrigins = mcpAppPrepared.allowedOrigins;
  }
  const color = Boolean(io.color && !options.noColor && !options.json);
  const progress = createProgressBar(io, {
    enabled: !options.json,
    color,
    total: options.dryRun
      ? 1
      : options.activate
        ? 10
        : options.start
          ? mcpAppPrepared
            ? 6
            : 5
          : 4,
  });

  const prompt = io.prompt;
  const { plan, healthUrl } = await runBootstrapWorkflow({
    options,
    cwd: io.cwd,
    skillMode,
    mcpAppPrepared,
    progress,
    authorizeLocalCa:
      io.interactive && prompt
        ? async () => {
            const answer = (await prompt("Authorize mkcert -install to trust the local CA? [y/N] "))
              .trim()
              .toLowerCase();
            return answer === "y" || answer === "yes";
          }
        : undefined,
  });

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
