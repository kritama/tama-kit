// @ts-check

import { validateSecretFilesUntracked } from "../shared/git.mjs";
import { planDevEnvironment } from "./environment.mjs";
import { planDevGitignore } from "./gitignore.mjs";
import { inspectDevProject } from "./project.mjs";

/** @param {{cwd: string, targetPath?: string, tamaPort?: number, postgresPort?: number}} options @returns {import("../types.mjs").DevSetupPlan} */
export function createDevSetupPlan(options) {
  const project = inspectDevProject(options);
  validateSecretFilesUntracked(project.root, [".envrc", ".tama.dev.postgres.env"]);
  const environment = planDevEnvironment(project.root, {
    tamaPort: options.tamaPort,
    postgresPort: options.postgresPort,
  });
  return {
    root: project.root,
    composeFile: project.composeFile,
    postgresPort: environment.postgresPort,
    tamaPort: environment.tamaPort,
    environment: environment.values,
    operations: [...planDevGitignore(project.root), ...environment.operations],
  };
}

/** @param {ReturnType<typeof createDevSetupPlan>} plan */
export function publicDevSetupPlan(plan) {
  return {
    root: plan.root,
    composeFile: plan.composeFile,
    postgres: {
      service: "postgres",
      host: "127.0.0.1",
      port: plan.postgresPort,
      containerPort: 5432,
    },
    tamaPort: plan.tamaPort,
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
