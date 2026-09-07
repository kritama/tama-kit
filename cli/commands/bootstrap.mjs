// @ts-check

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { formatAgentSetupPrompt } from "../bootstrap/agent-prompt.mjs";
import { discoverProject, inspectProject } from "../bootstrap/detect-project.mjs";
import { readSetupUrl } from "../bootstrap/environment.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { readAgentSkillMode, readBootstrapSettings } from "../bootstrap/manifest.mjs";
import { prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import { setupProgress } from "../bootstrap/setup-progress.mjs";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import { printHuman, resultEnvelope } from "../output/bootstrap.mjs";
import { createProgressBar } from "../terminal.mjs";
import { runBootstrapWorkflow } from "../workflows/bootstrap.mjs";
import { planBootstrap } from "../workflows/bootstrap-plan.mjs";
import { mcpAppOptions } from "../workflows/options.mjs";
import {
  ExistingBootstrapTarget,
  prepareBootstrapInput,
  printReview,
  resolveBootstrapInput,
} from "./bootstrap-input.mjs";
import { bootstrapUsage, parseBootstrap } from "./bootstrap-options.mjs";
import { runExistingBootstrap } from "./existing-bootstrap.mjs";
import { CancelledInput, PreviousQuestion, questions } from "./questions.mjs";
import { runSetup } from "./setup.mjs";

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
  let options = parseBootstrap(argv);
  if (options.help) {
    io.stdout(bootstrapUsage());
    return EXIT_CODES.SUCCESS;
  }

  const initialRoot = discoverProject({ cwd: io.cwd, targetPath: options.targetPath }).root;
  const existing = await runExistingBootstrap(options, io, initialRoot);
  if (existing !== null) return existing;
  options.developerOwned = true;
  options.generationId ??= randomUUID();

  const interactive = Boolean(
    io.interactive && io.prompt && !options.json && !options.nonInteractive,
  );
  let guided = null;
  try {
    guided =
      interactive && !options.resumePending ? await resolveBootstrapInput(options, io) : null;
  } catch (error) {
    if (!(error instanceof ExistingBootstrapTarget)) throw error;
    const result = await runExistingBootstrap(error.options, io, error.options.targetPath);
    if (result !== null) return result;
    throw usageError("selected project state changed; rerun bootstrap to review it");
  }
  if (guided) options = guided.options;
  const root = discoverProject({ cwd: io.cwd, targetPath: options.targetPath }).root;
  options.composePath ??= readBootstrapSettings(join(root, "tama"))?.composeFile;
  const inspection = inspectProject({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
  });
  const skillMode = await selectSkillMode(
    options,
    { ...io, interactive: false },
    inspection.tamaDirectory,
  );
  /** @type {McpAppPrepared | null} */
  let mcpAppPrepared = null;
  if (options.mcpApp) {
    mcpAppPrepared = await prepareMcpApp({
      root: inspection.root,
      tamaDirectory: inspection.tamaDirectory,
      framework: inspection.framework,
      options: mcpAppOptions(options),
      nonInteractive: !interactive,
      io,
    });
    options.allowedOrigins = mcpAppPrepared.allowedOrigins;
  }
  const color = Boolean(io.color && !options.noColor && !options.json);

  const q = questions(io);
  if (guided?.statusOnly) {
    io.stdout(
      "Configured status only. Runtime health and Terraform provisioning were not checked.",
    );
    for (const action of setupProgress(guided.reviewedPlan, { dryRun: true, started: false })
      .nextActions)
      io.stdout(action.description);
    return EXIT_CODES.SUCCESS;
  }
  let reviewedPlan = guided?.reviewedPlan;
  /** @type {Awaited<ReturnType<typeof runBootstrapWorkflow>>} */
  let completed;
  while (true) {
    if (guided) mcpAppPrepared = await prepareBootstrapInput(options, io);
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
    try {
      completed = await runBootstrapWorkflow({
        options,
        cwd: io.cwd,
        skillMode,
        mcpAppPrepared,
        progress,
        reviewedPlan,
        authorizeLocalCa: interactive
          ? () =>
              q.confirm(
                "Authorize mkcert -install to trust this local CA in your host trust store?",
              )
          : undefined,
      });
      break;
    } catch (error) {
      if (
        !interactive ||
        !(error instanceof CLIError) ||
        !["prerequisite", "startup"].includes(error.category)
      )
        throw error;
      io.stderr(error.message);
      io.stdout(
        "Completed file changes are retained. Fix the reported prerequisite or provider state before retrying.",
      );
      if (!(await q.confirm("Retry with these settings?"))) throw new CancelledInput();
      // Generation may already have committed before startup failed. Continue from
      // actual files; never retry through the template planner after that boundary.
      if (readGenerationEvidence(join(inspection.root, "tama/.tama-kit.json")).kind !== "absent") {
        return runSetup(
          [
            inspection.root,
            ...(options.composePath ? ["--compose", options.composePath] : []),
            ...(options.activate ? ["--activate"] : []),
            "--non-interactive",
          ],
          io,
        );
      }
      mcpAppPrepared = await prepareBootstrapInput(options, io);
      reviewedPlan = planBootstrap({
        options,
        cwd: io.cwd,
        skillMode,
        mcpAppPrepared,
        materializeSecrets: false,
      });
      printReview(reviewedPlan, io);
      if (!(await q.confirm("Execute the reviewed retry?"))) throw new CancelledInput();
    }
  }
  const { plan, healthUrl } = completed;

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
    if (!jsonRequested && (error instanceof CancelledInput || error instanceof PreviousQuestion)) {
      io.stdout("Setup paused. Rerun tama-kit bootstrap to continue.");
      return EXIT_CODES.SUCCESS;
    }
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
          ...(cliError.category === "startup" && cliError.details?.diagnostic
            ? { diagnostic: cliError.details.diagnostic }
            : {}),
        },
      }),
    );
    return cliError.exitCode;
  }
}
