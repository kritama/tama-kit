type BootstrapCommandOptions = import("../types.mjs").BootstrapCommandOptions;
type McpAppBootstrapOptions = import("../types.mjs").McpAppBootstrapOptions;

export function mcpAppOptions(options: BootstrapCommandOptions): McpAppBootstrapOptions {
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
