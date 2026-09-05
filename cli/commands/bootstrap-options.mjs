// @ts-check

import { parseArgs } from "node:util";
import { usageError } from "../errors.mjs";
/** @typedef {import("../types.mjs").BootstrapCommandOptions} BootstrapCommandOptions */

export function bootstrapUsage() {
  return [
    "Usage: tama-kit bootstrap [path] [options]",
    "",
    "Options:",
    "  --compose <path>       Select an existing Compose file",
    "  --port <port>          Host port for Tama (default: 4000)",
    "  --image <reference>    Override Tama image (official versions use <version>-server; latest is unsuffixed)",
    "  --skills <mode>        Agent skills: local or manual",
    "  --dry-run              Inspect and report without writing",
    "  --start                Start Compose and wait for Tama health",
    "  --json                 Emit machine-readable output",
    "  --no-color             Disable terminal colors",
    "  -h, --help             Show help",
    "MCP App provider integration:",
    "  --mcp-app              Plan the MCP App provider integration",
    "  --mcp-app-contract <path> Provider bootstrap contract (default: discover)",
    "  --provider-name <name> Provider identity name",
    "  --provider-prefix <prefix> Environment prefix override",
    "  --provider-env-file <path> Provider fragment override inside tama/",
    "  --provider-origin <origin> Provider issuer origin (advanced/migration assertion)",
    "  --tama-origin <origin> Exact public Tama origin",
    "  --local-domain <name>  Local HTTPS base name (default: app.localhost)",
    "  --acknowledge-local-domain-risk Allow an explicitly selected non-.localhost name",
    "  --provider-port <port> Host-native provider upstream port (default: 4000)",
    "  --install-local-ca     Explicitly authorize mkcert -install",
    "  --migrate-local-https  Explicitly migrate an existing HTTP MCP App topology",
    "  --allowed-origin <origin> Allowed client origin; HTTPS off loopback, max 32 unique (repeatable)",
    "  --migrate-provider-identity Migrate the persisted provider identity",
    "  --activate             Activate the integration after verification",
  ].join("\n");
}

/** @param {string | undefined} value */
function parsePort(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw usageError(`port must be an integer: ${value}`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) {
    throw usageError(`port must be between 1 and 65535: ${value}`);
  }
  return port;
}

/** @param {string | undefined} value */
function validateImage(value) {
  if (value === undefined) {
    return undefined;
  }
  const hasWhitespaceOrControl = [...value].some(
    (character) => /\s/u.test(character) || character.charCodeAt(0) <= 0x1f,
  );
  if (value.length === 0 || hasWhitespaceOrControl) {
    throw usageError("image must be a non-empty container reference without whitespace");
  }
  return value;
}

/** @param {string | undefined} value */
function parseSkillMode(value) {
  if (value === undefined || value === "local" || value === "manual") {
    return value;
  }
  throw usageError(`skills must be either local or manual: ${value}`);
}

/** @param {string[]} argv @returns {BootstrapCommandOptions} */
export function parseBootstrap(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        compose: { type: "string" },
        port: { type: "string" },
        image: { type: "string" },
        skills: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        start: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        "mcp-app": { type: "boolean", default: false },
        "mcp-app-contract": { type: "string" },
        "provider-name": { type: "string" },
        "provider-prefix": { type: "string" },
        "provider-env-file": { type: "string" },
        "provider-origin": { type: "string" },
        "tama-origin": { type: "string" },
        "local-domain": { type: "string" },
        "acknowledge-local-domain-risk": { type: "boolean", default: false },
        "provider-port": { type: "string" },
        "install-local-ca": { type: "boolean", default: false },
        "migrate-local-https": { type: "boolean", default: false },
        "allowed-origin": { type: "string", multiple: true },
        "migrate-provider-identity": { type: "boolean", default: false },
        activate: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`${message}\n\n${bootstrapUsage()}`);
  }
  if (parsed.positionals.length > 1) {
    throw usageError(`expected at most one project path\n\n${bootstrapUsage()}`);
  }
  if (parsed.values.start && parsed.values["dry-run"]) {
    throw usageError("--start cannot be combined with --dry-run");
  }
  const mcpAppFlags = [
    parsed.values["mcp-app-contract"] === undefined ? null : "--mcp-app-contract",
    parsed.values["provider-name"] === undefined ? null : "--provider-name",
    parsed.values["provider-prefix"] === undefined ? null : "--provider-prefix",
    parsed.values["provider-env-file"] === undefined ? null : "--provider-env-file",
    parsed.values["provider-origin"] === undefined ? null : "--provider-origin",
    parsed.values["tama-origin"] === undefined ? null : "--tama-origin",
    parsed.values["local-domain"] === undefined ? null : "--local-domain",
    parsed.values["acknowledge-local-domain-risk"] ? "--acknowledge-local-domain-risk" : null,
    parsed.values["provider-port"] === undefined ? null : "--provider-port",
    parsed.values["install-local-ca"] ? "--install-local-ca" : null,
    parsed.values["migrate-local-https"] ? "--migrate-local-https" : null,
    Array.isArray(parsed.values["allowed-origin"]) && parsed.values["allowed-origin"].length > 0
      ? "--allowed-origin"
      : null,
    parsed.values["migrate-provider-identity"] ? "--migrate-provider-identity" : null,
  ].filter((flag) => flag !== null);
  if (mcpAppFlags.length > 0 && !parsed.values["mcp-app"]) {
    throw usageError(`${mcpAppFlags.join(", ")} require --mcp-app`);
  }
  if (parsed.values.activate && !parsed.values["mcp-app"]) {
    throw usageError("--activate requires --mcp-app");
  }
  if (parsed.values.activate && !parsed.values.start) {
    throw usageError("--activate requires --start so verification can probe the running services");
  }
  if (parsed.values["migrate-provider-identity"] && !parsed.values["provider-name"]) {
    throw usageError("--migrate-provider-identity requires an explicit --provider-name");
  }
  if (parsed.values["migrate-provider-identity"] && parsed.values.activate) {
    throw usageError(
      "provider identity migration must complete in prepared mode before activation",
    );
  }
  return {
    targetPath: parsed.positionals[0],
    composePath: parsed.values.compose,
    port: parsePort(parsed.values.port),
    image: validateImage(parsed.values.image),
    skillMode: parseSkillMode(parsed.values.skills),
    dryRun: parsed.values["dry-run"] ?? false,
    start: parsed.values.start ?? false,
    json: parsed.values.json ?? false,
    noColor: parsed.values["no-color"] ?? false,
    help: parsed.values.help ?? false,
    mcpApp: parsed.values["mcp-app"] ?? false,
    mcpAppContract: parsed.values["mcp-app-contract"],
    providerName: parsed.values["provider-name"],
    providerPrefix: parsed.values["provider-prefix"],
    providerEnvironmentFile: parsed.values["provider-env-file"],
    providerOrigin: parsed.values["provider-origin"],
    tamaOrigin: parsed.values["tama-origin"],
    localDomain: parsed.values["local-domain"],
    acknowledgeLocalDomainRisk: parsed.values["acknowledge-local-domain-risk"] ?? false,
    providerPort: parsePort(parsed.values["provider-port"]),
    installLocalCa: parsed.values["install-local-ca"] ?? false,
    migrateLocalHttps: parsed.values["migrate-local-https"] ?? false,
    allowedOrigins: parsed.values["allowed-origin"],
    activate: parsed.values.activate ?? false,
    migrateProviderIdentity: parsed.values["migrate-provider-identity"] ?? false,
  };
}
