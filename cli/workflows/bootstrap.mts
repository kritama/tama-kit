import { existsSync } from "node:fs";
import {
  discoverMkcert,
  localHttpsPaths,
  planLocalHttpsCertificates,
  resolveLocalHttpsNames,
} from "../bootstrap/local-https.mjs";
import { createBootstrapPlan } from "../bootstrap/plan.mjs";
import { validateWrittenSecretsIgnored } from "../bootstrap/secrets.mjs";
import { validateCompose, validateComposePrerequisite } from "../bootstrap/start.mjs";
import { CLIError } from "../errors.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import { startBootstrapRuntime } from "./mcp-app-runtime.mjs";
import { mcpAppOptions } from "./options.mjs";

type BootstrapPlan = import("../types.mjs").BootstrapPlan;
type BootstrapCommandOptions = import("../types.mjs").BootstrapCommandOptions;
type McpAppPrepared = import("../types.mjs").McpAppPrepared;
type McpAppBootstrapOptions = import("../types.mjs").McpAppBootstrapOptions;
type Progress = ReturnType<typeof import("../terminal.mjs").createProgressBar>;

const bootstrapEffects = {
  createBootstrapPlan,
  validateWrittenSecretsIgnored,
  validateComposePrerequisite,
  validateCompose,
  applyOperationsTransactionally,
  startBootstrapRuntime,
  resolveLocalHttpsNames,
  discoverMkcert,
  planLocalHttpsCertificates,
  existsSync,
};

export function createBootstrapWorkflow(overrides: Partial<typeof bootstrapEffects> = {}) {
  const {
    createBootstrapPlan,
    validateWrittenSecretsIgnored,
    validateComposePrerequisite,
    validateCompose,
    applyOperationsTransactionally,
    startBootstrapRuntime,
    resolveLocalHttpsNames,
    discoverMkcert,
    planLocalHttpsCertificates,
    existsSync,
  } = { ...bootstrapEffects, ...overrides };

  return async function runBootstrapWorkflow({
    options,
    cwd,
    skillMode,
    mcpAppPrepared,
    progress,
    authorizeLocalCa,
  }: {
    options: BootstrapCommandOptions;
    cwd: string;
    skillMode: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared: McpAppPrepared | null;
    progress: Progress;
    authorizeLocalCa?: () => Promise<boolean>;
  }) {
    progress.update(0, "Planning bootstrap changes");
    let plan: BootstrapPlan;
    let healthUrl: string | undefined;
    try {
      const requestedMcpApp: McpAppBootstrapOptions | undefined = mcpAppPrepared
        ? mcpAppOptions(options)
        : undefined;
      const initialMcpApp: McpAppBootstrapOptions | undefined =
        requestedMcpApp && options.activate
          ? {
              ...requestedMcpApp,
              activate: false,
              targetMode: "prepared",
              preserveEnabledProvider: true,
            }
          : requestedMcpApp;
      plan = createBootstrapPlan({
        cwd,
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
          cwd,
          targetPath: options.targetPath,
          composePath: options.composePath,
          port: options.port,
          image: options.image,
          skillMode,
          mcpApp: {
            ...(requestedMcpApp as McpAppBootstrapOptions),
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
              if (
                !(error instanceof CLIError) ||
                error.details?.prerequisite !== "mkcert-local-ca"
              ) {
                throw error;
              }
            }
          }
          if (
            certificateNeedsGeneration &&
            !localCaExists &&
            !options.installLocalCa &&
            authorizeLocalCa
          ) {
            options.installLocalCa = await authorizeLocalCa();
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
          ({ plan, healthUrl } = await startBootstrapRuntime({
            options,
            cwd,
            skillMode,
            mcpAppPrepared,
            plan,
            progress,
          }));
        }
        progress.finish(options.start ? "Tama is ready" : "Bootstrap complete");
      }
    } catch (error) {
      progress.stop();
      throw error;
    }

    return { plan, healthUrl };
  };
}
export const runBootstrapWorkflow = createBootstrapWorkflow();
