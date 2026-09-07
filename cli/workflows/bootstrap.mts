import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectCurrentConfiguration } from "../bootstrap/current-config.mjs";
import {
  discoverMkcert,
  localHttpsPaths,
  planLocalHttpsCertificates,
  resolveLocalHttpsNames,
} from "../bootstrap/local-https.mjs";
import { prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import { createBootstrapPlan } from "../bootstrap/plan.mjs";
import { validateWrittenSecretsIgnored } from "../bootstrap/secrets.mjs";
import { validateCompose, validateComposePrerequisite } from "../bootstrap/start.mjs";
import { CLIError, ownershipError } from "../errors.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import { planBootstrap, reviewedPlanDigest } from "./bootstrap-plan.mjs";
import { startBootstrapRuntime } from "./mcp-app-runtime.mjs";
import { mcpAppOptions } from "./options.mjs";
import { writeScaffold } from "./scaffold-write.mjs";

type BootstrapPlan = import("../types.mjs").BootstrapPlan;
type BootstrapCommandOptions = import("../types.mjs").BootstrapCommandOptions;
type McpAppPrepared = import("../types.mjs").McpAppPrepared;
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
    reviewedPlan,
  }: {
    options: BootstrapCommandOptions;
    cwd: string;
    skillMode: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared: McpAppPrepared | null;
    progress: Progress;
    authorizeLocalCa?: () => Promise<boolean>;
    reviewedPlan?: BootstrapPlan;
  }) {
    progress.update(0, "Planning bootstrap changes");
    let plan: BootstrapPlan;
    let healthUrl: string | undefined;
    try {
      const input = { options, cwd, skillMode, mcpAppPrepared };
      const validateReview = async () => {
        if (reviewedPlan) {
          const prepared = mcpAppPrepared
            ? await prepareMcpApp({
                root: reviewedPlan.root,
                tamaDirectory: join(reviewedPlan.root, "tama"),
                framework: reviewedPlan.framework,
                options: mcpAppOptions(options),
                nonInteractive: true,
                io: { cwd: reviewedPlan.root, stdout() {}, stderr() {} },
              })
            : null;
          const fresh = planBootstrap(
            { ...input, mcpAppPrepared: prepared, materializeSecrets: false },
            createBootstrapPlan,
          );
          if (reviewedPlanDigest(fresh) !== reviewedPlanDigest(reviewedPlan)) {
            throw ownershipError(
              "the bootstrap plan changed after review; review it again before writing",
            );
          }
        }
      };
      await validateReview();
      plan = planBootstrap({ ...input, materializeSecrets: !options.dryRun }, createBootstrapPlan);
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
          await validateReview();
          const certificatePlan = planLocalHttpsCertificates(plan.root, plan.localHttps, {
            installLocalCa: options.installLocalCa,
          });
          plan.operations.push(...certificatePlan.operations);
        }
        await validateReview();
        progress.update(2, "Writing project-owned files");
        const apply = options.developerOwned
          ? (validate: () => void | Promise<void>) => writeScaffold(plan, validate)
          : (validate: () => void | Promise<void>) =>
              applyOperationsTransactionally(plan.operations, validate);
        await apply(() => {
          validateWrittenSecretsIgnored(plan);
          progress.update(3, "Validating Compose configuration");
          return validateCompose(plan, { checkPrerequisite: false });
        });
        if (options.start) {
          if (options.developerOwned) {
            const current = inspectCurrentConfiguration({
              cwd,
              targetPath: plan.root,
              composeFiles: [plan.composeFile],
              providerService: options.providerService,
            });
            plan = { ...current, operations: plan.operations };
          }
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
