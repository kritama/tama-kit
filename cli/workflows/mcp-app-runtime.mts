import { readFileSync } from "node:fs";
import { localHttpsPaths } from "../bootstrap/local-https.mjs";
import {
  createHttpHostMappedFetch,
  createLocalHttpsFetch,
  verifyMcpApp,
} from "../bootstrap/mcp-app-verify.mjs";
import { createBootstrapPlan } from "../bootstrap/plan.mjs";
import { validateWrittenSecretsIgnored } from "../bootstrap/secrets.mjs";
import {
  probeComposeProviderEndpoint,
  resolveComposeHostGatewayAddress,
  startCompose,
  validateCompose,
} from "../bootstrap/start.mjs";
import { activationStep, assertNever } from "../domain/lifecycle.mjs";
import { startupError } from "../errors.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import { mcpAppOptions } from "./options.mjs";

type BootstrapPlan = import("../types.mjs").BootstrapPlan;
type BootstrapCommandOptions = import("../types.mjs").BootstrapCommandOptions;
type McpAppPrepared = import("../types.mjs").McpAppPrepared;
type McpAppBootstrapOptions = import("../types.mjs").McpAppBootstrapOptions;
type Progress = ReturnType<typeof import("../terminal.mjs").createProgressBar>;

const runtimeEffects = {
  createBootstrapPlan,
  validateWrittenSecretsIgnored,
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
  const {
    createBootstrapPlan,
    validateWrittenSecretsIgnored,
    probeComposeProviderEndpoint,
    resolveComposeHostGatewayAddress,
    startCompose,
    validateCompose,
    applyOperationsTransactionally,
    verifyMcpApp,
    readFileSync,
    createHttpHostMappedFetch,
    createLocalHttpsFetch,
    platform,
  } = { ...runtimeEffects, ...overrides };
  /**
   * Re-plans the bootstrap with activation withdrawn and rewrites the managed
   * files, returning both sides to prepared after a failed verification.
   *
   */
  async function rollbackActivation({
    options,
    cwd,
    skillMode,
    mcpAppPrepared,
  }: {
    options: BootstrapCommandOptions;
    cwd: string;
    skillMode: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared: McpAppPrepared;
  }): Promise<BootstrapPlan> {
    const plan = createBootstrapPlan({
      cwd,
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
   */
  async function restorePreparedRuntime(
    input: {
      options: BootstrapCommandOptions;
      cwd: string;
      skillMode: import("../types.mjs").AgentSkillMode;
      mcpAppPrepared: McpAppPrepared;
      quiet: boolean;
    },
    failure: unknown,
  ) {
    try {
      const rollbackPlan = await rollbackActivation(input);
      await startCompose(rollbackPlan, { quiet: input.quiet });
      return rollbackPlan;
    } catch (recoveryError) {
      const original = failure instanceof Error ? failure.message : String(failure);
      const recovery =
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      throw startupError(
        `MCP App activation failed: ${original}. Restoring prepared mode also failed: ${recovery}. Inspect the managed configuration and both services before retrying.`,
      );
    }
  }

  function failedProbeSummary(verification: import("../types.mjs").McpAppVerification) {
    return verification.probes
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.name}: ${entry.reason ?? "verification failed"}`)
      .join("; ");
  }

  function verificationFetch(plan: BootstrapPlan) {
    return plan.localHttps
      ? createLocalHttpsFetch(readFileSync(localHttpsPaths(plan.root).rootCertificate))
      : globalThis.fetch;
  }

  async function verifyPlan(
    plan: BootstrapPlan,
    providerFetch: Parameters<typeof verifyMcpApp>[0]["providerFetch"],
    recover?: (failure: unknown) => Promise<unknown>,
  ) {
    if (!plan.mcpApp) throw startupError("MCP App verification plan was unexpectedly empty");
    try {
      return await verifyMcpApp({
        root: plan.root,
        plan: plan.mcpApp,
        fetch: verificationFetch(plan),
        probeProviderFromContainer: async (endpoint) =>
          probeComposeProviderEndpoint(plan, endpoint),
        providerFetch,
      });
    } catch (error) {
      if (recover) await recover(error);
      const message = error instanceof Error ? error.message : String(error);
      throw startupError(
        `MCP App verification could not complete. ${recover ? "Tama was restarted in prepared mode and the provider fragment was restored to prepared; restart the provider so its live state also returns to prepared. " : "The integration remains prepared. "}Verification failure: ${message}`,
      );
    }
  }

  return async function startBootstrapRuntime({
    options,
    cwd,
    skillMode,
    mcpAppPrepared,
    plan,
    progress,
  }: {
    options: BootstrapCommandOptions;
    cwd: string;
    skillMode: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared: McpAppPrepared | null;
    plan: BootstrapPlan;
    progress: Progress;
  }) {
    const recoveryContext = mcpAppPrepared
      ? { options, cwd, skillMode, mcpAppPrepared, quiet: options.json }
      : null;
    async function recover(failure: unknown, step: number) {
      if (!recoveryContext)
        throw startupError("Cannot recover an MCP App runtime without its prepared identity");
      progress.update(step, "Restoring prepared configuration");
      return restorePreparedRuntime(recoveryContext, failure);
    }
    let healthUrl: string | undefined;
    const requestedMcpApp = mcpAppPrepared ? mcpAppOptions(options) : undefined;
    if (options.start) {
      progress.update(4, "Starting Tama services");
      try {
        healthUrl = await startCompose(plan, { quiet: options.json });
      } catch (error) {
        if (plan.mcpApp?.lifecycle === "enabled" && mcpAppPrepared) {
          await recover(error, 6);
          const message = error instanceof Error ? error.message : String(error);
          throw startupError(
            "Tama failed to start in enabled MCP App mode. Tama was restarted in prepared mode and the provider fragment was restored to prepared; restart the provider so its live state also returns to prepared. " +
              `Startup failure: ${message}`,
          );
        }
        throw error;
      }
      if (plan.mcpApp && mcpAppPrepared) {
        let providerTransportHost: string | undefined;
        try {
          providerTransportHost =
            platform === "linux" &&
            new URL(plan.mcpApp.providerOrigin).hostname === "host.docker.internal"
              ? resolveComposeHostGatewayAddress(plan)
              : undefined;
        } catch (error) {
          const wasEnabled = plan.mcpApp.lifecycle === "enabled";
          if (wasEnabled) {
            await recover(error, 6);
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
        const verification = await verifyPlan(
          plan,
          providerFetch,
          plan.mcpApp.lifecycle === "enabled" ? (failure) => recover(failure, 6) : undefined,
        );
        plan.mcpAppVerification = verification;
        if (!verification.verified) {
          const wasEnabled = plan.mcpApp.lifecycle === "enabled";
          if (wasEnabled) {
            await recover(new Error(`Failed probes: ${failedProbeSummary(verification)}`), 6);
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

        const step = activationStep(
          options.activate,
          plan.mcpApp.lifecycle,
          plan.mcpApp.providerLifecycle,
        );
        switch (step.kind) {
          case "observe":
            break;
          case "enable-tama": {
            progress.update(6, "Enabling Tama MCP App mode");
            const tamaEnabledPlan = createBootstrapPlan({
              cwd,
              targetPath: options.targetPath,
              composePath: options.composePath,
              port: options.port,
              image: options.image,
              skillMode,
              mcpApp: {
                ...(requestedMcpApp as McpAppBootstrapOptions),
                activate: true,
                targetMode: step.targetMode,
                providerMode: step.providerMode,
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
              await recover(error, 9);
              const message = error instanceof Error ? error.message : String(error);
              throw startupError(
                "Tama failed to start in enabled MCP App mode. Tama was restarted in prepared mode; the provider remained prepared. " +
                  `Startup failure: ${message}`,
              );
            }
            progress.update(9, "Verifying enabled Tama state");
            const enabledVerification = await verifyPlan(
              tamaEnabledPlan,
              providerFetch,
              (failure) => recover(failure, 9),
            );
            tamaEnabledPlan.mcpAppVerification = enabledVerification;
            if (!enabledVerification.verified) {
              await recover(
                new Error(`Failed probes: ${failedProbeSummary(enabledVerification)}`),
                9,
              );
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
            break;
          }
          default:
            assertNever(step);
        }
      }
    }

    return { plan, healthUrl };
  };
}
export const startBootstrapRuntime = createBootstrapRuntime();
