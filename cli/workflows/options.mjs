// @ts-check
/** @typedef {import("../types.mjs").BootstrapCommandOptions} BootstrapCommandOptions */
/** @typedef {import("../types.mjs").McpAppBootstrapOptions} McpAppBootstrapOptions */

/** @param {BootstrapCommandOptions} options @returns {McpAppBootstrapOptions} */
export function mcpAppOptions(options) {
  return {
    requested: options.mcpApp,
    contractPath: options.mcpAppContract,
    providerName: options.providerName,
    providerPrefix: options.providerPrefix,
    providerEnvironmentFile: options.providerEnvironmentFile,
    providerOrigin: options.providerOrigin,
    tamaOrigin: options.tamaOrigin,
    localDomain: options.localDomain,
    acknowledgeLocalDomainRisk: options.acknowledgeLocalDomainRisk,
    providerPort: options.providerPort,
    installLocalCa: options.installLocalCa,
    migrateLocalHttps: options.migrateLocalHttps,
    allowedOrigins: options.allowedOrigins,
    activate: options.activate,
    migrateProviderIdentity: options.migrateProviderIdentity,
  };
}
