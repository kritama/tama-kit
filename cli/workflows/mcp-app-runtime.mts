import { readFileSync } from "node:fs";
import { localHttpsPaths } from "../bootstrap/local-https.mjs";
import {
  createHttpHostMappedFetch,
  createLocalHttpsFetch,
  verifyMcpApp,
} from "../bootstrap/mcp-app-verify.mjs";
import {
  probeComposeProviderEndpoint,
  resolveComposeHostGatewayAddress,
  startCompose,
  validateCompose,
} from "../bootstrap/start.mjs";
import { activationStep } from "../domain/lifecycle.mjs";
import { CLIError, startupError } from "../errors.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import { planTamaModeChange } from "./activation.mjs";

type Plan = import("../types.mjs").BootstrapPlan;
type Options = import("../types.mjs").BootstrapCommandOptions;
type Progress = ReturnType<typeof import("../terminal.mjs").createProgressBar>;

function diagnosticDetails(...failures: unknown[]) {
  for (const failure of failures)
    if (failure instanceof CLIError && failure.details?.diagnostic)
      return { diagnostic: failure.details.diagnostic };
  return undefined;
}
function safeMessage(error: unknown) {
  return error instanceof CLIError
    ? error.message
    : "runtime verification or recovery could not complete";
}
const runtimeEffects = {
  planTamaModeChange,
  probeComposeProviderEndpoint,
  resolveComposeHostGatewayAddress,
  startCompose,
  validateCompose,
  applyOperationsTransactionally,
  verifyMcpApp,
  readFileSync,
  createHttpHostMappedFetch,
  createLocalHttpsFetch,
  platform: process.platform,
};

export function createBootstrapRuntime(overrides: Partial<typeof runtimeEffects> = {}) {
  const effects = { ...runtimeEffects, ...overrides };
  async function verify(plan: Plan) {
    if (!plan.mcpApp) return;
    if (plan.mcpApp.lifecycle === "disabled" || plan.mcpApp.providerLifecycle === "disabled")
      return;
    const providerTransportHost =
      effects.platform === "linux" &&
      new URL(plan.mcpApp.providerOrigin).hostname === "host.docker.internal"
        ? effects.resolveComposeHostGatewayAddress(plan)
        : undefined;
    const verification = await effects.verifyMcpApp({
      root: plan.root,
      plan: plan.mcpApp,
      fetch: plan.localHttps
        ? effects.createLocalHttpsFetch(
            effects.readFileSync(
              plan.runtime?.caFile ?? localHttpsPaths(plan.root).rootCertificate,
            ),
          )
        : globalThis.fetch,
      providerFetch: providerTransportHost
        ? effects.createHttpHostMappedFetch(providerTransportHost)
        : undefined,
      probeProviderFromContainer: async (endpoint) =>
        effects.probeComposeProviderEndpoint(plan, endpoint),
    });
    plan.mcpAppVerification = verification;
    if (!verification.verified)
      throw startupError(
        `MCP App verification failed. Failed probes: ${verification.probes
          .filter((probe) => !probe.ok)
          .map((probe) => `${probe.name}: ${probe.reason ?? "verification failed"}`)
          .join("; ")}`,
      );
  }
  return async function startBootstrapRuntime({
    options,
    plan,
    progress,
    probeOnly = false,
  }: {
    options: Options;
    plan: Plan;
    progress: Progress;
    probeOnly?: boolean;
    cwd?: string;
    skillMode?: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared?: import("../types.mjs").McpAppPrepared | null;
  }) {
    let healthUrl: string | undefined;
    if (options.start && !probeOnly) {
      progress.update(4, "Starting selected Tama services");
      healthUrl = await effects.startCompose(plan, { quiet: options.json });
    }
    progress.update(5, "Verifying current MCP App configuration");
    try {
      await verify(plan);
    } catch (error) {
      throw startupError(
        `${safeMessage(error)}. Configuration was preserved.`,
        diagnosticDetails(error),
      );
    }
    if (
      !plan.mcpApp ||
      probeOnly ||
      activationStep(options.activate, plan.mcpApp.lifecycle, plan.mcpApp.providerLifecycle)
        .kind !== "enable-tama"
    )
      return { plan, healthUrl };
    const change = effects.planTamaModeChange(plan);
    progress.update(6, "Enabling Tama MCP App mode");
    await effects.applyOperationsTransactionally([change.operation], () =>
      effects.validateCompose(change.plan, { checkPrerequisite: false }),
    );
    try {
      progress.update(7, "Restarting selected Tama services");
      healthUrl = await effects.startCompose(change.plan, { quiet: options.json });
      progress.update(8, "Verifying enabled Tama state");
      await verify(change.plan);
    } catch (failure) {
      progress.update(9, "Restoring this activation's mode change");
      try {
        const restore = change.restore();
        await effects.applyOperationsTransactionally([restore], () =>
          effects.validateCompose(plan, { checkPrerequisite: false }),
        );
        await effects.startCompose(plan, { quiet: options.json });
      } catch (recovery) {
        throw startupError(
          `MCP App activation failed: ${safeMessage(failure)}. Restoring the selected Tama mode also failed: ${safeMessage(recovery)}. Inspect the current configuration before retrying.`,
          diagnosticDetails(failure, recovery),
        );
      }
      throw startupError(
        `MCP App activation failed: ${safeMessage(failure)}. Tama was restarted in its previous mode; provider configuration was preserved.`,
        diagnosticDetails(failure),
      );
    }
    return { plan: change.plan, healthUrl };
  };
}
export const startBootstrapRuntime = createBootstrapRuntime();
