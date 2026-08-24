// @ts-check

import { join } from "node:path";

import { BOOTSTRAP_SCHEMA_VERSION, DEFAULTS } from "./constants.mjs";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { planRootCompose } from "./compose.mjs";
import { inspectProject } from "./detect-project.mjs";
import { planEnvironment } from "./environment.mjs";
import { operationForContent } from "./files.mjs";
import { planGitignore } from "./gitignore.mjs";
import { renderTemplate } from "./templates.mjs";
import { planTerraform } from "./terraform.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapPlanOptions} BootstrapPlanOptions */
/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").PublicBootstrapPlan} PublicBootstrapPlan */

/**
 * @param {string} filename
 * @param {string} templateName
 * @param {Record<string, string | number>} replacements
 * @returns {FileOperation}
 */
function managedTemplate(filename, templateName, replacements) {
  return operationForContent(filename, renderTemplate(templateName, replacements));
}

/** @param {BootstrapPlanOptions} options @returns {BootstrapPlan} */
export function createBootstrapPlan(options) {
  const inspection = inspectProject(options);
  const environment = planEnvironment(inspection.root, options.port);
  const replacements = {
    PORT: environment.port,
    TAMA_IMAGE: options.image ?? DEFAULTS.tamaImage,
    POSTGRES_IMAGE: DEFAULTS.postgresImage,
  };

  /** @type {FileOperation[]} */
  const operations = [environment.operation, environment.postgresOperation];
  operations.push(
    managedTemplate(join(inspection.root, ".tama.env.example"), "tama-env.example", {
      PORT: environment.port,
    }),
  );
  operations.push(
    managedTemplate(join(inspection.tamaDirectory, "compose.yaml"), "compose.yaml", replacements),
  );
  operations.push(
    planRootCompose(
      inspection.selectedCompose,
      join(inspection.tamaDirectory, "compose.yaml"),
      renderTemplate("root-compose.yaml"),
    ),
  );
  operations.push(planGitignore(inspection.root));

  const terraform = planTerraform(inspection.tamaDirectory, {
    terraformVersion: DEFAULTS.terraformVersion,
    providerVersion: DEFAULTS.providerVersion,
    globalModuleVersion: DEFAULTS.globalModuleVersion,
  });
  operations.push(...terraform.operations);
  operations.push(
    managedTemplate(join(inspection.tamaDirectory, "README.md"), "README.md", {
      PORT: environment.port,
      COMPOSE_UP_COMMAND: formatComposeUpCommand(inspection.selectedCompose),
      COMPOSE_PS_COMMAND: formatComposePsCommand(inspection.selectedCompose),
    }),
  );

  return {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    root: inspection.root,
    framework: inspection.framework,
    frameworkEvidence: inspection.frameworkEvidence,
    composeFile: inspection.selectedCompose,
    port: environment.port,
    tamaImage: replacements.TAMA_IMAGE,
    postgresImage: replacements.POSTGRES_IMAGE,
    terraform: {
      foundation: terraform.foundation,
      providerVersion: DEFAULTS.providerVersion,
      globalModuleVersion: DEFAULTS.globalModuleVersion,
    },
    operations,
  };
}

/** @param {BootstrapPlan} plan @returns {PublicBootstrapPlan} */
export function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    root: plan.root,
    framework: plan.framework,
    frameworkEvidence: plan.frameworkEvidence,
    composeFile: plan.composeFile,
    port: plan.port,
    tamaImage: plan.tamaImage,
    postgresImage: plan.postgresImage,
    terraform: plan.terraform,
    changes: plan.operations.map(({ action, path, owner, sensitive }) => ({
      action,
      path,
      owner,
      sensitive,
    })),
  };
}
