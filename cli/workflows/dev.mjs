// @ts-check
import { validateCompose, validateComposePrerequisite } from "../bootstrap/start.mjs";
import { createDevSetupPlan } from "../dev/plan.mjs";
import { runMixSetup, runTestFoundationSetup, startDevDatabase } from "../dev/start.mjs";
import { processEnvironment } from "../shared/environment.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";

/** @typedef {import("../types.mjs").DevSetupPlan} DevSetupPlan */

const devEffects = {
  createDevSetupPlan,
  validateCompose,
  validateComposePrerequisite,
  runMixSetup,
  runTestFoundationSetup,
  startDevDatabase,
  applyOperationsTransactionally,
};
/** @param {Partial<typeof devEffects>} [overrides] */
export function createDevWorkflow(overrides = {}) {
  const {
    createDevSetupPlan,
    validateCompose,
    validateComposePrerequisite,
    runMixSetup,
    runTestFoundationSetup,
    startDevDatabase,
    applyOperationsTransactionally,
  } = { ...devEffects, ...overrides };
  /** @param {{options: import("../types.mjs").DevCommandOptions, cwd: string, progress: ReturnType<typeof import("../terminal.mjs").createProgressBar>}} input */
  return async function runDevWorkflow({ options, cwd, progress }) {
    progress.update(0, "Planning development setup");
    /** @type {DevSetupPlan} */
    let plan;
    try {
      plan = createDevSetupPlan({
        cwd: cwd,
        targetPath: options.targetPath,
        tamaPort: options.port,
        postgresPort: options.postgresPort,
      });
      if (options.dryRun) {
        progress.finish("Plan ready");
      } else if (options.prepareOnly) {
        progress.update(1, "Writing development environment files");
        await applyOperationsTransactionally(plan.operations, () => undefined);
        progress.finish("Environment prepared");
      } else {
        progress.update(1, "Checking Docker Compose");
        validateComposePrerequisite();
        progress.update(2, "Writing development environment files");
        await applyOperationsTransactionally(plan.operations, () => {
          progress.update(3, "Validating compose.yml");
          return validateCompose(plan, {
            checkPrerequisite: false,
            env: processEnvironment(plan.environment),
          });
        });
        progress.update(4, "Starting isolated PostgreSQL");
        await startDevDatabase(plan, { quiet: options.json });
        progress.update(5, "Running mix setup");
        await runMixSetup(plan, { quiet: options.json });
        progress.update(6, "Ensuring the test foundation");
        await runTestFoundationSetup(plan, { quiet: options.json });
        progress.finish("Development environment ready");
      }
    } catch (error) {
      progress.stop();
      throw error;
    }

    return plan;
  };
}
export const runDevWorkflow = createDevWorkflow();
