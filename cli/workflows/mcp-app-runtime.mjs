// @ts-check
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
import { startupError } from "../errors.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import { mcpAppOptions } from "./options.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapCommandOptions} BootstrapCommandOptions */
/** @typedef {import("../types.mjs").McpAppPrepared} McpAppPrepared */
/** @typedef {import("../types.mjs").McpAppBootstrapOptions} McpAppBootstrapOptions */
/** @typedef {ReturnType<typeof import("../terminal.mjs").createProgressBar>} Progress */

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

/** @param {Partial<typeof runtimeEffects>} [overrides] */
export function createBootstrapRuntime(overrides = {}) {
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
   * @param {{
   *   options: BootstrapCommandOptions,
   *   cwd: string,
   *   skillMode: import("../types.mjs").AgentSkillMode,
   *   mcpAppPrepared: McpAppPrepared,
   * }} input
   * @returns {Promise<BootstrapPlan>}
   */
  async function rollbackActivation({ options, cwd, skillMode, mcpAppPrepared }) {
    const plan = createBootstrapPlan({
      cwd: cwd,
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
   *   cwd: string,
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

  /** @param {{ options: BootstrapCommandOptions, cwd: string, skillMode: import("../types.mjs").AgentSkillMode, mcpAppPrepared: McpAppPrepared | null, plan: BootstrapPlan, progress: Progress }} input */
  return async function startBootstrapRuntime({
    options,
    cwd,
    skillMode,
    mcpAppPrepared,
    plan,
    progress,
  }) {
    let healthUrl;
    const requestedMcpApp = mcpAppPrepared ? mcpAppOptions(options) : undefined;
    if (options.start) {
      progress.update(4, "Starting Tama services");
      try {
        healthUrl = await startCompose(plan, { quiet: options.json });
      } catch (error) {
        if (plan.mcpApp?.lifecycle === "enabled" && mcpAppPrepared) {
          progress.update(6, "Restoring prepared configuration");
          await restorePreparedRuntime({
            options,
            cwd,
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
            platform === "linux" &&
            new URL(plan.mcpApp.providerOrigin).hostname === "host.docker.internal"
              ? resolveComposeHostGatewayAddress(plan)
              : undefined;
        } catch (error) {
          const wasEnabled = plan.mcpApp.lifecycle === "enabled";
          if (wasEnabled) {
            progress.update(6, "Restoring prepared configuration");
            await restorePreparedRuntime({
              options,
              cwd,
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
              cwd,
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
            cwd: cwd,
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
              cwd,
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
              cwd,
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

    return { plan, healthUrl };
  };
}
export const startBootstrapRuntime = createBootstrapRuntime();
