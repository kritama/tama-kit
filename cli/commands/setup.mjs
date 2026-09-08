// @ts-check
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { inspectCurrentConfiguration, inspectTerraform } from "../bootstrap/current-config.mjs";
import { createLocalHttpsFetch } from "../bootstrap/mcp-app-verify.mjs";
import { publicPlan } from "../bootstrap/plan.mjs";
import { setupProgress } from "../bootstrap/setup-progress.mjs";
import { fetchWithTimeout } from "../bootstrap/start.mjs";
import { lifecycleCheckpoint } from "../domain/lifecycle.mjs";
import { CLIError, EXIT_CODES, startupError, usageError } from "../errors.mjs";
import { createProgressBar } from "../terminal.mjs";
import { planTamaModeChange } from "../workflows/activation.mjs";
import { startBootstrapRuntime } from "../workflows/mcp-app-runtime.mjs";
import { CancelledInput, questions } from "./questions.mjs";

export function setupUsage(command = "setup") {
  return [
    `Usage: tama-kit ${command} [path] [options]`,
    command === "doctor"
      ? "Inspect current configuration without writing or initializing providers."
      : "Start and verify current project configuration without regenerating files.",
    "  --compose <path>          Compose root, then overrides (repeatable)",
    "  --service <name>          Select the Tama service",
    "  --proxy-service <name>    Select the HTTPS proxy service",
    "  --env-file <path>         Select Tama's loaded private environment file",
    "  --contract <path>         Select the project-owned local MCP App contract",
    "  --provider-service <name> Select the provider service",
    "  --ca-file <path>          Select the HTTPS CA certificate",
    ...(command === "doctor"
      ? ["  --terraform-root <path>   Terraform directory for read-only doctor validation"]
      : []),
    ...(command === "doctor"
      ? ["  --runtime                Also run non-mutating runtime probes"]
      : [
          "  --activate               Verify prepared services and enable Tama; provider restart remains application-owned",
          "  --dry-run                Show current configuration and proposed mode edit without starting or writing",
        ]),
    "  --json                   Machine-readable output; never prompts",
    "  --non-interactive        Do not prompt",
    "  --no-color               Disable color",
    "  -h, --help               Show help",
  ].join("\n");
}

/** @param {string[]} argv @param {string} command */
export function parseSetup(argv, command) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        compose: { type: "string", multiple: true },
        service: { type: "string" },
        "proxy-service": { type: "string" },
        "env-file": { type: "string" },
        contract: { type: "string" },
        "provider-service": { type: "string" },
        "ca-file": { type: "string" },
        "terraform-root": { type: "string" },
        runtime: { type: "boolean" },
        activate: { type: "boolean" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        "non-interactive": { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    throw usageError(`invalid ${command} arguments\n${setupUsage(command)}`);
  }
  if (command === "doctor" && (parsed.values.activate || parsed.values["dry-run"]))
    throw usageError("doctor accepts --runtime, not setup mutation options");
  if (command === "setup" && parsed.values.runtime)
    throw usageError("--runtime is a doctor option");
  if (command === "setup" && parsed.values["terraform-root"] !== undefined)
    throw usageError("--terraform-root is a doctor option");
  if (parsed.positionals.length > 1) throw usageError("expected at most one project path");
  return parsed;
}

/** @param {string[]} argv @param {import("../types.mjs").CommandIO} io @param {"setup" | "doctor"} [command] */
export async function runSetup(argv, io, command = "setup") {
  const json = argv.includes("--json");
  try {
    const { values, positionals } = parseSetup(argv, command);
    if (values.help) {
      io.stdout(setupUsage(command));
      return EXIT_CODES.SUCCESS;
    }
    const doctor = command === "doctor";
    const dryRun = Boolean(values["dry-run"]);
    const progress = createProgressBar(io, { enabled: false, color: false, total: 10 });
    let plan = inspectCurrentConfiguration({
      cwd: io.cwd,
      targetPath: positionals[0],
      composeFiles: values.compose,
      service: values.service,
      proxyService: values["proxy-service"],
      environmentFile: values["env-file"],
      contractPath: values.contract,
      providerService: values["provider-service"],
      caFile: values["ca-file"],
    });
    let activate = Boolean(values.activate);
    if (activate && !plan.mcpApp)
      throw usageError(
        "--activate requires an MCP App configuration; add it with tama-kit generate mcp-app first",
      );
    const activationAvailable = Boolean(
      plan.mcpApp &&
        lifecycleCheckpoint(plan.mcpApp.lifecycle, plan.mcpApp.providerLifecycle).kind !==
          "configured",
    );
    if (activate && !activationAvailable)
      throw usageError(
        "--activate requires both services prepared, or Tama enabled with its provider prepared/enabled. Set disabled services to prepared through their current configuration before activating.",
      );
    if (!doctor && !dryRun && !json && !values["non-interactive"] && io.interactive && io.prompt) {
      const next = await questions(io).choice("Current project configuration found.", [
        "Start and verify services",
        ...(activationAvailable ? ["Start and activate MCP App"] : []),
        "Finish",
      ]);
      if (next === (activationAvailable ? 2 : 1)) throw new CancelledInput();
      activate ||= next === 1;
    }
    let healthUrl;
    const probe = doctor && values.runtime;
    if ((!doctor && !dryRun) || probe) {
      const result = await startBootstrapRuntime({
        plan,
        progress,
        probeOnly: Boolean(probe),
        options: {
          dryRun: false,
          start: !doctor,
          activate: !doctor && activate,
          json: true,
          noColor: true,
          help: false,
          mcpApp: Boolean(plan.mcpApp),
          acknowledgeLocalDomainRisk: false,
          installLocalCa: false,
          migrateLocalHttps: false,
          migrateProviderIdentity: false,
        },
      });
      plan = /** @type {typeof plan} */ (result.plan);
      healthUrl = result.healthUrl;
      if (probe) {
        const response = await fetchWithTimeout(
          plan.runtime.healthUrl,
          2000,
          plan.runtime.caFile ? createLocalHttpsFetch(readFileSync(plan.runtime.caFile)) : fetch,
        );
        if (!response.ok) throw startupError("runtime health probe failed");
        healthUrl = plan.runtime.healthUrl;
      }
    } else if (
      !doctor &&
      activate &&
      plan.mcpApp?.lifecycle === "prepared" &&
      plan.mcpApp.providerLifecycle === "prepared"
    ) {
      plan = /** @type {typeof plan} */ (planTamaModeChange(plan).plan);
    }
    const result = {
      ok: true,
      command,
      mode: doctor ? "inspect" : dryRun ? "dry-run" : "setup",
      ...publicPlan(plan),
      started: !doctor && !dryRun,
      healthUrl: healthUrl ?? null,
      configuration: {
        status: "valid",
        composeFiles: plan.runtime.composeFiles,
        service: plan.runtime.service,
        proxyService: plan.runtime.proxyService ?? null,
      },
      setup: setupProgress(plan, { dryRun, started: Boolean(healthUrl) }),
      ...(doctor
        ? {
            terraform: inspectTerraform(plan.root, undefined, values["terraform-root"]),
            runtime: { checked: Boolean(probe), healthy: Boolean(healthUrl) },
          }
        : {}),
    };
    if (json) io.stdout(JSON.stringify(result, null, 2));
    else {
      io.stdout(
        `${command}: current configuration is valid. ${healthUrl ? `Tama is healthy at ${healthUrl}` : "Runtime was not checked."}`,
      );
      io.stdout(
        `Compose: ${plan.runtime.composeFiles.join(", ")}; Tama service: ${plan.runtime.service}`,
      );
      for (const change of result.changes)
        io.stdout(
          `${change.action}: ${change.path}${change.sensitive ? " (private content hidden)" : ""}`,
        );
      for (const action of result.setup.nextActions) io.stdout(action.description);
    }
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof CancelledInput) {
      io.stdout("Setup paused. Run tama-kit setup to continue.");
      return EXIT_CODES.SUCCESS;
    }
    const failure =
      error instanceof CLIError
        ? error
        : new CLIError(
            `${command} could not complete; inspect the selected configuration and runtime locally`,
          );
    if (json)
      io.stdout(
        JSON.stringify({
          ok: false,
          error: {
            category: failure.category,
            exitCode: failure.exitCode,
            message: failure.message,
            ...(failure.details?.diagnostic ? { diagnostic: failure.details.diagnostic } : {}),
          },
        }),
      );
    else io.stderr(failure.message);
    return failure.exitCode;
  }
}
