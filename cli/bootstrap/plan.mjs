// @ts-check

import { join, relative } from "node:path";
import { planRootCompose } from "./compose.mjs";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { BOOTSTRAP_SCHEMA_VERSION, DEFAULTS } from "./constants.mjs";
import { inspectProject } from "./detect-project.mjs";
import { planEnvironment } from "./environment.mjs";
import { planGitignore, validateSecretFilesUntracked } from "./gitignore.mjs";
import { createManagedFilePlanner } from "./manifest.mjs";
import { renderTemplate } from "./templates.mjs";
import { planTerraform } from "./terraform.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapPlanOptions} BootstrapPlanOptions */
/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").PublicBootstrapPlan} PublicBootstrapPlan */

/**
 * @param {(filename: string, content: string) => FileOperation} planManagedFile
 * @param {string} filename
 * @param {string} templateName
 * @param {Record<string, string | number>} replacements
 * @returns {FileOperation}
 */
function managedTemplate(planManagedFile, filename, templateName, replacements) {
  return planManagedFile(filename, renderTemplate(templateName, replacements));
}

/** @param {BootstrapPlanOptions} options @returns {BootstrapPlan} */
export function createBootstrapPlan(options) {
  const inspection = inspectProject(options);
  validateSecretFilesUntracked(inspection.root);
  const managedFiles = createManagedFilePlanner(inspection.root, inspection.tamaDirectory);
  const environment = planEnvironment(inspection.root, options.port);
  const replacements = {
    PORT: environment.port,
    CONTAINER_PORT: DEFAULTS.containerPort,
    TAMA_IMAGE: options.image ?? DEFAULTS.tamaImage,
    POSTGRES_IMAGE: DEFAULTS.postgresImage,
  };

  /** @type {FileOperation[]} */
  const operations = [environment.operation, environment.postgresOperation];
  operations.push(
    managedTemplate(
      managedFiles.plan,
      join(inspection.root, ".tama.env.example"),
      "tama-env.example",
      { PORT: environment.port },
    ),
  );
  operations.push(
    managedTemplate(
      managedFiles.plan,
      join(inspection.tamaDirectory, "compose.yaml"),
      "compose.yaml",
      replacements,
    ),
  );
  operations.push(
    planRootCompose(
      inspection.selectedCompose,
      join(inspection.tamaDirectory, "compose.yaml"),
      renderTemplate("root-compose.yaml"),
    ),
  );
  operations.push(...planGitignore(inspection.root));

  /** @type {Array<[string, string, Record<string, string | number>]>} */
  const knownTerraformTemplates = [
    ["main.tf", "main.tf", { GLOBAL_MODULE_VERSION: DEFAULTS.globalModuleVersion }],
    [
      "versions.tf",
      "versions.tf",
      {
        TERRAFORM_VERSION: DEFAULTS.terraformVersion,
        PROVIDER_VERSION: DEFAULTS.providerVersion,
      },
    ],
    [
      "tama-kit-global.tf",
      "global-module.tf",
      { GLOBAL_MODULE_VERSION: DEFAULTS.globalModuleVersion },
    ],
  ];
  for (const [filename, templateName, templateReplacements] of knownTerraformTemplates) {
    managedFiles.adoptMarkedFile(join(inspection.tamaDirectory, filename), [
      renderTemplate(templateName, templateReplacements),
    ]);
  }
  const terraform = planTerraform(
    inspection.tamaDirectory,
    {
      terraformVersion: DEFAULTS.terraformVersion,
      providerVersion: DEFAULTS.providerVersion,
      globalModuleVersion: DEFAULTS.globalModuleVersion,
    },
    managedFiles.plan,
    managedFiles.isManagedFile,
  );
  operations.push(...terraform.operations);
  const projectComposePath = relative(inspection.root, inspection.selectedCompose);
  operations.push(
    managedTemplate(managedFiles.plan, join(inspection.tamaDirectory, "README.md"), "README.md", {
      PORT: environment.port,
      COMPOSE_UP_COMMAND: formatComposeUpCommand(projectComposePath),
      COMPOSE_PS_COMMAND: formatComposePsCommand(projectComposePath),
    }),
  );
  operations.push(managedFiles.manifestOperation());

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
      providerVersion: terraform.providerVersion,
      globalModuleVersion: terraform.globalModuleVersion,
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
    changes: plan.operations.map(
      ({ action, path, owner, sensitive, beforeDigest, afterDigest, reason }) => ({
        action,
        path,
        owner,
        sensitive,
        beforeDigest,
        afterDigest,
        reason,
      }),
    ),
  };
}
