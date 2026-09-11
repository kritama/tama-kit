// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOOTSTRAP_PATHS } from "./constants.mjs";
import { validateSecretFilesIgnored } from "./gitignore.mjs";
import { validateMcpAppLocalContract } from "./mcp-app-local-contract.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */

/** @param {BootstrapPlan} plan */
export function validateWrittenSecretsIgnored(plan) {
  /** @type {Set<string>} */
  const files = new Set([BOOTSTRAP_PATHS.environment, BOOTSTRAP_PATHS.postgresEnvironment]);
  if (plan.mcpApp) {
    files.add(plan.mcpApp.provider.environmentFile);
  }
  const contractPath = join(plan.root, BOOTSTRAP_PATHS.mcpAppLocalContract);
  if (!plan.mcpApp && existsSync(contractPath)) {
    const contract = validateMcpAppLocalContract(JSON.parse(readFileSync(contractPath, "utf8")));
    files.add(contract.provider.environment_file);
  }
  if (plan.localHttps) {
    files.add("tama/tls/local.pem");
    files.add("tama/tls/local-key.pem");
    files.add("tama/tls/rootCA.pem");
  }
  validateSecretFilesIgnored(plan.root, [...files]);
}
