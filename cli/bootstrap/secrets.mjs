// @ts-check
import { join } from "node:path";
import { BOOTSTRAP_PATHS } from "./constants.mjs";
import { validateSecretFilesIgnored } from "./gitignore.mjs";
import { readMcpAppProvider } from "./manifest.mjs";
/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */

/** @param {BootstrapPlan} plan */
export function validateWrittenSecretsIgnored(plan) {
  /** @type {Set<string>} */
  const files = new Set([BOOTSTRAP_PATHS.environment, BOOTSTRAP_PATHS.postgresEnvironment]);
  if (plan.mcpApp) {
    files.add(plan.mcpApp.provider.environmentFile);
  }
  const persistedProvider = readMcpAppProvider(join(plan.root, "tama"));
  if (persistedProvider) {
    files.add(persistedProvider.identity.environmentFile);
  }
  if (plan.localHttps) {
    files.add("tama/tls/local.pem");
    files.add("tama/tls/local-key.pem");
    files.add("tama/tls/rootCA.pem");
  }
  validateSecretFilesIgnored(plan.root, [...files]);
}
