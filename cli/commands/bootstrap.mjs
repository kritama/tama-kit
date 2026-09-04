// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { formatAgentSetupPrompt } from "../bootstrap/agent-prompt.mjs";
import { formatComposeUpCommand } from "../bootstrap/compose-command.mjs";
import { BOOTSTRAP_PATHS } from "../bootstrap/constants.mjs";
import { inspectProject } from "../bootstrap/detect-project.mjs";
import { readSetupUrl } from "../bootstrap/environment.mjs";
import { validateSecretFilesIgnored } from "../bootstrap/gitignore.mjs";
import {
  discoverMkcert,
  localHttpsPaths,
  planLocalHttpsCertificates,
  resolveLocalHttpsNames,
} from "../bootstrap/local-https.mjs";
import { readAgentSkillMode, readMcpAppProvider } from "../bootstrap/manifest.mjs";
import { prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import {
  createHttpHostMappedFetch,
  createLocalHttpsFetch,
  verifyMcpApp,
} from "../bootstrap/mcp-app-verify.mjs";
import { createBootstrapPlan, publicPlan } from "../bootstrap/plan.mjs";
import {
  probeComposeProviderEndpoint,
  resolveComposeHostGatewayAddress,
  startCompose,
  validateCompose,
  validateComposePrerequisite,
} from "../bootstrap/start.mjs";
import { applyOperationsTransactionally } from "../bootstrap/write.mjs";
import { CLIError, EXIT_CODES, startupError, usageError } from "../errors.mjs";
import { createProgressBar, paint, renderBox } from "../terminal.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapResult} BootstrapResult */
/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").ExitCode} ExitCode */
/** @typedef {import("../types.mjs").McpAppBootstrapOptions} McpAppBootstrapOptions */
/** @typedef {import("../types.mjs").McpAppPrepared} McpAppPrepared */

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
 * @property {boolean} mcpApp
 * @property {string} [mcpAppContract]
 * @property {string} [providerName]
 * @property {string} [providerPrefix]
 * @property {string} [providerEnvironmentFile]
 * @property {string} [providerOrigin]
 * @property {string} [localDomain]
 * @property {boolean} acknowledgeLocalDomainRisk
 * @property {number} [providerPort]
 * @property {boolean} installLocalCa
 * @property {boolean} migrateLocalHttps
 * @property {string} [tamaOrigin]
 * @property {string[]} [allowedOrigins]
 * @property {boolean} activate
 * @property {boolean} migrateProviderIdentity
 */

function usage() {
  return [
    "Usage: tama-kit bootstrap [path] [options]",
    "",
    "Options:",
    "  --compose <path>       Select an existing Compose file",
    "  --port <port>          Host port for Tama (default: 4000)",
    "  --image <reference>    Override Tama image (official versions use <version>-server; latest is unsuffixed)",
    "  --skills <mode>        Agent skills: local or manual",
    "  --dry-run              Inspect and report without writing",
    "  --start                Start Compose and wait for Tama health",
    "  --json                 Emit machine-readable output",
    "  --no-color             Disable terminal colors",
    "  -h, --help             Show help",
    "MCP App provider integration:",
    "  --mcp-app              Plan the MCP App provider integration",
    "  --mcp-app-contract <path> Provider bootstrap contract (default: discover)",
    "  --provider-name <name> Provider identity name",
    "  --provider-prefix <prefix> Environment prefix override",
    "  --provider-env-file <path> Provider fragment override inside tama/",
    "  --provider-origin <origin> Provider issuer origin (advanced/migration assertion)",
    "  --tama-origin <origin> Exact public Tama origin",
    "  --local-domain <name>  Local HTTPS base name (default: app.localhost)",
    "  --acknowledge-local-domain-risk Allow an explicitly selected non-.localhost name",
    "  --provider-port <port> Host-native provider upstream port (default: 4000)",
    "  --install-local-ca     Explicitly authorize mkcert -install",
    "  --migrate-local-https  Explicitly migrate an existing HTTP MCP App topology",
    "  --allowed-origin <origin> Allowed client origin; HTTPS off loopback, max 32 unique (repeatable)",
    "  --migrate-provider-identity Migrate the persisted provider identity",
    "  --activate             Activate the integration after verification",
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
        "mcp-app": { type: "boolean", default: false },
        "mcp-app-contract": { type: "string" },
        "provider-name": { type: "string" },
        "provider-prefix": { type: "string" },
        "provider-env-file": { type: "string" },
        "provider-origin": { type: "string" },
        "tama-origin": { type: "string" },
        "local-domain": { type: "string" },
        "acknowledge-local-domain-risk": { type: "boolean", default: false },
        "provider-port": { type: "string" },
        "install-local-ca": { type: "boolean", default: false },
        "migrate-local-https": { type: "boolean", default: false },
        "allowed-origin": { type: "string", multiple: true },
        "migrate-provider-identity": { type: "boolean", default: false },
        activate: { type: "boolean", default: false },
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
  const mcpAppFlags = [
    parsed.values["mcp-app-contract"] === undefined ? null : "--mcp-app-contract",
    parsed.values["provider-name"] === undefined ? null : "--provider-name",
    parsed.values["provider-prefix"] === undefined ? null : "--provider-prefix",
    parsed.values["provider-env-file"] === undefined ? null : "--provider-env-file",
    parsed.values["provider-origin"] === undefined ? null : "--provider-origin",
    parsed.values["tama-origin"] === undefined ? null : "--tama-origin",
    parsed.values["local-domain"] === undefined ? null : "--local-domain",
    parsed.values["acknowledge-local-domain-risk"] ? "--acknowledge-local-domain-risk" : null,
    parsed.values["provider-port"] === undefined ? null : "--provider-port",
    parsed.values["install-local-ca"] ? "--install-local-ca" : null,
    parsed.values["migrate-local-https"] ? "--migrate-local-https" : null,
    Array.isArray(parsed.values["allowed-origin"]) && parsed.values["allowed-origin"].length > 0
      ? "--allowed-origin"
      : null,
    parsed.values["migrate-provider-identity"] ? "--migrate-provider-identity" : null,
  ].filter((flag) => flag !== null);
  if (mcpAppFlags.length > 0 && !parsed.values["mcp-app"]) {
    throw usageError(`${mcpAppFlags.join(", ")} require --mcp-app`);
  }
  if (parsed.values.activate && !parsed.values["mcp-app"]) {
    throw usageError("--activate requires --mcp-app");
  }
  if (parsed.values.activate && !parsed.values.start) {
    throw usageError("--activate requires --start so verification can probe the running services");
  }
  if (parsed.values["migrate-provider-identity"] && !parsed.values["provider-name"]) {
    throw usageError("--migrate-provider-identity requires an explicit --provider-name");
  }
  if (parsed.values["migrate-provider-identity"] && parsed.values.activate) {
    throw usageError(
      "provider identity migration must complete in prepared mode before activation",
    );
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
    mcpApp: parsed.values["mcp-app"] ?? false,
    mcpAppContract: parsed.values["mcp-app-contract"],
    providerName: parsed.values["provider-name"],
    providerPrefix: parsed.values["provider-prefix"],
    providerEnvironmentFile: parsed.values["provider-env-file"],
    providerOrigin: parsed.values["provider-origin"],
    tamaOrigin: parsed.values["tama-origin"],
    localDomain: parsed.values["local-domain"],
    acknowledgeLocalDomainRisk: parsed.values["acknowledge-local-domain-risk"] ?? false,
    providerPort: parsePort(parsed.values["provider-port"]),
    installLocalCa: parsed.values["install-local-ca"] ?? false,
    migrateLocalHttps: parsed.values["migrate-local-https"] ?? false,
    allowedOrigins: parsed.values["allowed-origin"],
    activate: parsed.values.activate ?? false,
    migrateProviderIdentity: parsed.values["migrate-provider-identity"] ?? false,
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
    localHttps: plan.localHttps
      ? {
          profile: plan.localHttps.profile,
          localDomain: plan.localHttps.localDomain,
          providerHost: plan.localHttps.providerHost,
          tamaHost: plan.localHttps.tamaHost,
          providerOrigin: plan.localHttps.providerOrigin,
          tamaOrigin: plan.localHttps.tamaOrigin,
          resource: plan.localHttps.resource,
          healthUrl: plan.localHttps.healthUrl,
          providerUpstream: plan.localHttps.providerUpstream,
          tamaUpstream: plan.localHttps.tamaUpstream,
          providerPort: plan.localHttps.providerPort,
          tamaPort: plan.localHttps.tamaPort,
          httpsPort: plan.localHttps.httpsPort,
          certificateNames: plan.localHttps.certificateNames,
          caddyImage: plan.localHttps.caddyImage,
          trustMechanism: plan.localHttps.trustMechanism,
          allowedOrigins: plan.localHttps.allowedOrigins,
          certificateReady: Object.values(localHttpsPaths(plan.root))
            .filter((path) => path.endsWith(".pem"))
            .every(existsSync),
        }
      : null,
  };
}

/** @param {BootstrapPlan} plan */
export function validateWrittenSecretsIgnored(plan) {
  /** @type {Set<string>} */
  const files = new Set([BOOTSTRAP_PATHS.environment, BOOTSTRAP_PATHS.postgresEnvironment]);
  if (plan.mcpApp) {
    files.add(plan.mcpApp.provider.environmentFile);
  }
  const persistedProvider = readMcpAppProvider(join(plan.root, "tama"));
  if (persistedProvider) {
    files.add(persistedProvider.identity.environmentFile);
  }
  if (plan.localHttps) {
    files.add("tama/tls/local.pem");
    files.add("tama/tls/local-key.pem");
    files.add("tama/tls/rootCA.pem");
  }
  validateSecretFilesIgnored(plan.root, [...files]);
}

/**
 * Re-plans the bootstrap with activation withdrawn and rewrites the managed
 * files, returning both sides to prepared after a failed verification.
 *
 * @param {{
 *   options: BootstrapCommandOptions,
 *   io: CommandIO,
 *   skillMode: import("../types.mjs").AgentSkillMode,
 *   mcpAppPrepared: McpAppPrepared,
 * }} input
 * @returns {Promise<BootstrapPlan>}
 */
async function rollbackActivation({ options, io, skillMode, mcpAppPrepared }) {
  const plan = createBootstrapPlan({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
    port: options.port,
    image: options.image,
    skillMode,
    mcpApp: {
      ...mcpAppOptions({ ...options, activate: false }),
      targetMode: "prepared",
      providerMode: "prepared",
    },
    mcpAppPrepared,
  });
  await applyOperationsTransactionally(plan.operations, () => {
    validateWrittenSecretsIgnored(plan);
    return validateCompose(plan, { checkPrerequisite: false });
  });
  return plan;
}

/**
 * Restores both managed fragments to prepared and restarts the Tama Compose
 * runtime so its live mode matches the files. The provider process remains
 * operator-owned and may still require its own restart.
 *
 * @param {{
 *   options: BootstrapCommandOptions,
 *   io: CommandIO,
 *   skillMode: import("../types.mjs").AgentSkillMode,
 *   mcpAppPrepared: McpAppPrepared,
 *   quiet: boolean,
 * }} input
 */
async function restorePreparedRuntime(input) {
  const rollbackPlan = await rollbackActivation(input);
  await startCompose(rollbackPlan, { quiet: input.quiet });
  return rollbackPlan;
}

/** @param {import("../types.mjs").McpAppVerification} verification */
function failedProbeSummary(verification) {
  return verification.probes
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.name}: ${entry.reason ?? "verification failed"}`)
    .join("; ");
}

/** @param {BootstrapPlan} plan */
function verificationFetch(plan) {
  return plan.localHttps
    ? createLocalHttpsFetch(readFileSync(localHttpsPaths(plan.root).rootCertificate))
    : globalThis.fetch;
}

/** @param {BootstrapCommandOptions} options @returns {McpAppBootstrapOptions} */
function mcpAppOptions(options) {
  return {
    requested: options.mcpApp,
    contractPath: options.mcpAppContract,
    providerName: options.providerName,
    providerPrefix: options.providerPrefix,
    providerEnvironmentFile: options.providerEnvironmentFile,
    providerOrigin: options.providerOrigin,
    tamaOrigin: options.tamaOrigin,
    localDomain: options.localDomain,
    acknowledgeLocalDomainRisk: options.acknowledgeLocalDomainRisk,
    providerPort: options.providerPort,
    installLocalCa: options.installLocalCa,
    migrateLocalHttps: options.migrateLocalHttps,
    allowedOrigins: options.allowedOrigins,
    activate: options.activate,
    migrateProviderIdentity: options.migrateProviderIdentity,
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

  if (result.providerContract) {
    io.stdout("");
    io.stdout(paint(color, "bold", "MCP App local contract:"));
    io.stdout(
      `  ${paint(color, "dim", "Path:")} ${paint(color, "cyan", result.providerContract.path)} (${result.providerContract.action})`,
    );
    io.stdout(
      `  ${paint(color, "dim", "Source:")} ${result.providerContract.source}` +
        (result.providerContract.sourcePath
          ? ` (${paint(color, "cyan", result.providerContract.sourcePath)})`
          : ""),
    );
    io.stdout(`  ${paint(color, "dim", "Bindings:")} ${result.providerContract.bindingSource}`);
    io.stdout(
      `  ${paint(color, "dim", "Environment loading:")} ${result.providerContract.environmentLoading}` +
        (result.providerContract.environmentLoadingEvidencePath
          ? ` via ${result.providerContract.environmentLoadingMechanism} (${paint(color, "cyan", result.providerContract.environmentLoadingEvidencePath)})`
          : ""),
    );
  }

  if (result.provider?.environmentLoading === "unverified") {
    io.stdout("");
    io.stdout(paint(color, "yellow", "Provider environment loading is not verified:"));
    io.stdout(
      `  Configure the provider process to load ${paint(color, "cyan", result.provider.environmentFile)} before starting or restarting it.`,
    );
  }

  if (result.localHttps) {
    io.stdout("");
    io.stdout(paint(color, "bold", "MCP App local HTTPS topology:"));
    io.stdout(`  Provider: ${result.localHttps.providerOrigin}`);
    io.stdout(`  Tama: ${result.localHttps.tamaOrigin}`);
    io.stdout(`  Resource: ${result.localHttps.resource}`);
    io.stdout(
      `  Caddy is the public entry point; upstreams are ${result.localHttps.providerUpstream} and ${result.localHttps.tamaUpstream}.`,
    );
    io.stdout(
      `  Certificate: ${result.localHttps.certificateReady ? "generated/reused" : "planned; generated during write"}; CA trust requires explicit mkcert authorization when needed.`,
    );
  }

  /** @param {{title?: string, lines: string[], style?: import("../terminal.mjs").PaintStyle}} box */
  function printBox(box) {
    const maxWidth = io.columns === undefined ? undefined : io.columns - 4;
    for (const line of renderBox({ ...box, color, maxWidth })) {
      io.stdout(line);
    }
  }

  /** @param {string | null} url */
  function printSetupUrl(url) {
    if (!url) {
      return;
    }
    io.stdout("");
    io.stdout(paint(color, "bold", "Private setup URL:"));
    io.stdout(`  ${paint(color, "magenta", url)}`);
  }

  if (result.started) {
    io.stdout("");
    io.stdout(`Tama is healthy at ${result.healthUrl}`);
    printSetupUrl(setupUrl);
  } else if (result.mode !== "dry-run") {
    const composeReference = relative(io.cwd, result.composeFile) || result.composeFile;
    io.stdout("");
    io.stdout(paint(color, "bold", "Next:"));
    io.stdout(
      `  ${paint(
        color,
        "cyan",
        formatComposeUpCommand(
          composeReference,
          result.localHttps ? "caddy" : "tama",
          Boolean(result.localHttps),
        ),
      )}`,
    );
    printSetupUrl(setupUrl);
  }

  if (result.mcpApp?.providerActivationRequired && result.provider) {
    io.stdout("");
    io.stdout(paint(color, "bold", "Provider activation required:"));
    io.stdout(
      `  Set the provider's ${paint(color, "cyan", result.provider.modeVariable)} to ${paint(color, "cyan", "enabled")}, restart the provider, then rerun this command with ${paint(color, "cyan", "--start --activate")}.`,
    );
    io.stdout(
      "  Tama Kit will record the enabled checkpoint only after both services verify live.",
    );
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

  progress.update(0, "Planning bootstrap changes");
  /** @type {BootstrapPlan} */
  let plan;
  let healthUrl;
  try {
    /** @type {McpAppBootstrapOptions | undefined} */
    const requestedMcpApp = mcpAppPrepared ? mcpAppOptions(options) : undefined;
    /** @type {McpAppBootstrapOptions | undefined} */
    const initialMcpApp =
      requestedMcpApp && options.activate
        ? {
            ...requestedMcpApp,
            activate: false,
            targetMode: "prepared",
            preserveEnabledProvider: true,
          }
        : requestedMcpApp;
    plan = createBootstrapPlan({
      cwd: io.cwd,
      targetPath: options.targetPath,
      composePath: options.composePath,
      port: options.port,
      image: options.image,
      skillMode,
      mcpApp: initialMcpApp,
      mcpAppPrepared,
      materializeSecrets: !options.dryRun,
    });
    if (options.activate && plan.mcpApp?.providerLifecycle === "enabled") {
      plan = createBootstrapPlan({
        cwd: io.cwd,
        targetPath: options.targetPath,
        composePath: options.composePath,
        port: options.port,
        image: options.image,
        skillMode,
        mcpApp: {
          .../** @type {McpAppBootstrapOptions} */ (requestedMcpApp),
          activate: true,
          targetMode: "enabled",
          providerMode: "enabled",
        },
        mcpAppPrepared,
        materializeSecrets: !options.dryRun,
      });
    }
    if (options.dryRun) {
      if (plan.localHttps) {
        await resolveLocalHttpsNames(plan.localHttps);
      }
      progress.finish("Plan ready");
    } else {
      progress.update(1, "Checking Docker Compose");
      validateComposePrerequisite();
      if (plan.localHttps) {
        progress.update(2, "Checking local HTTPS prerequisites");
        await resolveLocalHttpsNames(plan.localHttps);
        const tlsPaths = localHttpsPaths(plan.root);
        const certificateNeedsGeneration = [
          tlsPaths.certificate,
          tlsPaths.privateKey,
          tlsPaths.rootCertificate,
        ].some((path) => !existsSync(path));
        let localCaExists = false;
        if (certificateNeedsGeneration) {
          try {
            discoverMkcert();
            localCaExists = true;
          } catch (error) {
            if (!(error instanceof CLIError) || error.details?.prerequisite !== "mkcert-local-ca") {
              throw error;
            }
          }
        }
        if (
          certificateNeedsGeneration &&
          !localCaExists &&
          !options.installLocalCa &&
          io.interactive &&
          io.prompt
        ) {
          const answer = (
            await io.prompt("Authorize mkcert -install to trust the local CA? [y/N] ")
          )
            .trim()
            .toLowerCase();
          if (answer === "y" || answer === "yes") {
            options.installLocalCa = true;
          }
        }
        const certificatePlan = planLocalHttpsCertificates(plan.root, plan.localHttps, {
          installLocalCa: options.installLocalCa,
        });
        plan.operations.push(...certificatePlan.operations);
      }
      progress.update(2, "Writing managed files");
      await applyOperationsTransactionally(plan.operations, () => {
        validateWrittenSecretsIgnored(plan);
        progress.update(3, "Validating Compose configuration");
        return validateCompose(plan, { checkPrerequisite: false });
      });
      if (options.start) {
        progress.update(4, "Starting Tama services");
        try {
          healthUrl = await startCompose(plan, { quiet: options.json });
        } catch (error) {
          if (plan.mcpApp?.lifecycle === "enabled" && mcpAppPrepared) {
            progress.update(6, "Restoring prepared configuration");
            await restorePreparedRuntime({
              options,
              io,
              skillMode,
              mcpAppPrepared,
              quiet: options.json,
            });
            const message = error instanceof Error ? error.message : String(error);
            throw startupError(
              "Tama failed to start in enabled MCP App mode. Tama was restarted in prepared mode and the provider fragment was restored to prepared; restart the provider so its live state also returns to prepared. " +
                `Startup failure: ${message}`,
            );
          }
          throw error;
        }
        if (plan.mcpApp && mcpAppPrepared) {
          let providerTransportHost;
          try {
            providerTransportHost =
              process.platform === "linux" &&
              new URL(plan.mcpApp.providerOrigin).hostname === "host.docker.internal"
                ? resolveComposeHostGatewayAddress(plan)
                : undefined;
          } catch (error) {
            const wasEnabled = plan.mcpApp.lifecycle === "enabled";
            if (wasEnabled) {
              progress.update(6, "Restoring prepared configuration");
              await restorePreparedRuntime({
                options,
                io,
                skillMode,
                mcpAppPrepared,
                quiet: options.json,
              });
            }
            const message = error instanceof Error ? error.message : String(error);
            throw startupError(
              `${wasEnabled ? "MCP App activation" : "MCP App prepared-state"} verification could not resolve the provider transport. ` +
                `${wasEnabled ? "Tama was restarted in prepared mode and the provider fragment was restored to prepared; restart the provider so its live state also returns to prepared. " : "The integration remains prepared. "}` +
                `Transport failure: ${message}`,
            );
          }
          const providerFetch = providerTransportHost
            ? createHttpHostMappedFetch(providerTransportHost)
            : undefined;
          progress.update(5, "Verifying MCP App integration");
          const verification = await verifyMcpApp({
            root: plan.root,
            plan: plan.mcpApp,
            fetch: verificationFetch(plan),
            probeProviderFromContainer: async (endpoint) =>
              probeComposeProviderEndpoint(plan, endpoint),
            providerFetch,
          });
          plan.mcpAppVerification = verification;
          if (!verification.verified) {
            const wasEnabled = plan.mcpApp.lifecycle === "enabled";
            if (wasEnabled) {
              progress.update(6, "Restoring prepared configuration");
              await restorePreparedRuntime({
                options,
                io,
                skillMode,
                mcpAppPrepared,
                quiet: options.json,
              });
            }
            throw startupError(
              `${wasEnabled ? "MCP App activation" : "MCP App prepared-state"} verification failed. ` +
                `${wasEnabled ? "Tama was restarted in prepared mode and the provider fragment was restored to prepared; restart the provider so its live state also returns to prepared. " : "The integration remains prepared. "}` +
                `Failed probes: ${failedProbeSummary(verification)}`,
              {
                providerOrigin: plan.mcpApp.providerOrigin,
                tamaOrigin: plan.mcpApp.tamaOrigin,
                providerReachable: verification.providerReachable,
                tamaReachable: verification.tamaReachable,
              },
            );
          }

          if (
            options.activate &&
            plan.mcpApp.lifecycle === "prepared" &&
            plan.mcpApp.providerLifecycle === "prepared"
          ) {
            progress.update(6, "Enabling Tama MCP App mode");
            const tamaEnabledPlan = createBootstrapPlan({
              cwd: io.cwd,
              targetPath: options.targetPath,
              composePath: options.composePath,
              port: options.port,
              image: options.image,
              skillMode,
              mcpApp: {
                .../** @type {McpAppBootstrapOptions} */ (requestedMcpApp),
                activate: true,
                targetMode: "enabled",
                providerMode: "prepared",
              },
              mcpAppPrepared,
              materializeSecrets: true,
            });
            if (!tamaEnabledPlan.mcpApp) {
              throw startupError("MCP App activation plan was unexpectedly empty");
            }
            await applyOperationsTransactionally(tamaEnabledPlan.operations, () => {
              validateWrittenSecretsIgnored(tamaEnabledPlan);
              progress.update(7, "Validating enabled Tama configuration");
              return validateCompose(tamaEnabledPlan, { checkPrerequisite: false });
            });
            progress.update(8, "Restarting Tama in enabled mode");
            try {
              healthUrl = await startCompose(tamaEnabledPlan, { quiet: options.json });
            } catch (error) {
              progress.update(9, "Restoring prepared configuration");
              await restorePreparedRuntime({
                options,
                io,
                skillMode,
                mcpAppPrepared,
                quiet: options.json,
              });
              const message = error instanceof Error ? error.message : String(error);
              throw startupError(
                "Tama failed to start in enabled MCP App mode. Tama was restarted in prepared mode; the provider remained prepared. " +
                  `Startup failure: ${message}`,
              );
            }
            progress.update(9, "Verifying enabled Tama state");
            const enabledVerification = await verifyMcpApp({
              root: tamaEnabledPlan.root,
              plan: tamaEnabledPlan.mcpApp,
              fetch: verificationFetch(tamaEnabledPlan),
              probeProviderFromContainer: async (endpoint) =>
                probeComposeProviderEndpoint(tamaEnabledPlan, endpoint),
              providerFetch,
            });
            tamaEnabledPlan.mcpAppVerification = enabledVerification;
            if (!enabledVerification.verified) {
              progress.update(9, "Restoring prepared configuration");
              await restorePreparedRuntime({
                options,
                io,
                skillMode,
                mcpAppPrepared,
                quiet: options.json,
              });
              throw startupError(
                "Tama MCP App activation verification failed. Tama was restarted in prepared mode; the provider remained prepared. " +
                  `Failed probes: ${failedProbeSummary(enabledVerification)}`,
                {
                  providerOrigin: tamaEnabledPlan.mcpApp.providerOrigin,
                  tamaOrigin: tamaEnabledPlan.mcpApp.tamaOrigin,
                  providerReachable: enabledVerification.providerReachable,
                  tamaReachable: enabledVerification.tamaReachable,
                },
              );
            }
            plan = tamaEnabledPlan;
          }
        }
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
