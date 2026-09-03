// @ts-check

import { join, relative } from "node:path";
import { usageError } from "../errors.mjs";
import { planRootCompose } from "./compose.mjs";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { BOOTSTRAP_SCHEMA_VERSION, DEFAULTS } from "./constants.mjs";
import { inspectProject } from "./detect-project.mjs";
import { planEnvironment, resolveEnvironmentPort } from "./environment.mjs";
import { planGitignore, validateSecretFilesUntracked } from "./gitignore.mjs";
import { createManagedFilePlanner, readMcpAppProvider } from "./manifest.mjs";
import { planMcpApp, resolveMcpAppState } from "./mcp-app.mjs";
import {
  contractTamaPort,
  loadTamaContract,
  MCP_APP_COMPATIBILITY_IDENTIFIER,
} from "./mcp-app-contract.mjs";
import { planAgentSkills } from "./skills.mjs";
import { renderTemplate } from "./templates.mjs";
import { planTerraform } from "./terraform.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapPlanOptions} BootstrapPlanOptions */
/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").McpAppPlan} McpAppPlan */
/** @typedef {import("../types.mjs").PersistedMcpAppProvider} PersistedMcpAppProvider */
/** @typedef {import("../types.mjs").PublicBootstrapPlan} PublicBootstrapPlan */

const TAMA_EXTRA_HOSTS_BLOCK = "    extra_hosts:\n      - host.docker.internal:host-gateway\n";

/** @param {McpAppPlan | null} mcpApp */
function mcpAppExample(mcpApp) {
  if (!mcpApp) {
    return "";
  }
  return [
    "",
    "# MCP App public configuration. Private JWK material is intentionally omitted.",
    `TAMA_MCP_APP_MODE=${mcpApp.lifecycle}`,
    `TAMA_MCP_APP_RESOURCE=${mcpApp.resource}`,
    `TAMA_MCP_APP_AUTHORIZATION_SERVER=${mcpApp.providerOrigin}`,
    `TAMA_MCP_APP_JWKS_URI=${mcpApp.providerOrigin}/.well-known/jwks.json`,
    `TAMA_MCP_APP_INTROSPECTION_ENDPOINT=${mcpApp.providerOrigin}/auth/introspections`,
    "TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM=RS256",
    "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS=[]",
    `TAMA_MCP_APP_INTROSPECTION_CLIENT_ID=${mcpApp.introspectionClientId}`,
    `TAMA_MCP_APP_ALLOWED_ORIGINS=${mcpApp.allowedOrigins.join(",")}`,
  ].join("\n");
}

/** @param {McpAppPlan | null} mcpApp */
function mcpAppReadmeGuidance(mcpApp) {
  if (!mcpApp) {
    return "";
  }
  return [
    "",
    "## MCP App provider integration",
    "",
    `The provider fragment \`${mcpApp.provider.environmentFile}\` and \`.tama.env\` contain private signing material. Keep both files untracked and never paste their values into chat or logs.`,
    "",
    `The exact provider issuer is \`${mcpApp.providerOrigin}\`; the exact Tama resource is \`${mcpApp.resource}\`. Browser/MCP clients are limited to: ${mcpApp.allowedOrigins.map((origin) => `\`${origin}\``).join(", ")}.`,
    "",
    "Activation is staged. Run bootstrap with `--start --activate` to verify prepared state and enable Tama. Tama Kit does not restart the host-native provider: set the provider mode variable to `enabled`, restart the provider, then rerun the same command. An enabled checkpoint is reported only after both live services pass verification.",
  ].join("\n");
}

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
  const skillMode = options.skillMode ?? "manual";
  const mcpAppPrepared = options.mcpApp?.requested ? (options.mcpAppPrepared ?? null) : null;
  if (options.mcpApp?.requested && mcpAppPrepared === null) {
    throw usageError(
      "internal error: the MCP App provider identity must be prepared before planning",
    );
  }
  validateSecretFilesUntracked(inspection.root, [
    ".tama.env",
    ".tama.postgres.env",
    ...(mcpAppPrepared ? [mcpAppPrepared.identity.environmentFile] : []),
    ...(mcpAppPrepared?.persisted &&
    mcpAppPrepared.persisted.identity.environmentFile !== mcpAppPrepared.identity.environmentFile
      ? [mcpAppPrepared.persisted.identity.environmentFile]
      : []),
  ]);
  const mcpAppState = mcpAppPrepared
    ? resolveMcpAppState({
        root: inspection.root,
        identity: mcpAppPrepared.identity,
        contractPath: mcpAppPrepared.contractPath,
        contractDocument: mcpAppPrepared.contractDocument,
      })
    : null;
  // A fresh MCP App run adopts the Tama port the accepted contract documents
  // so the container and the host-native provider never share a host port.
  const mcpAppFreshPort = mcpAppPrepared
    ? (contractTamaPort(mcpAppPrepared.contractDocument, loadTamaContract()) ?? undefined)
    : undefined;
  const port = resolveEnvironmentPort(inspection.root, options.port, mcpAppFreshPort);
  const managedFiles = createManagedFilePlanner(
    inspection.root,
    inspection.tamaDirectory,
    skillMode,
    mcpAppState,
  );
  /** @type {McpAppPlan | null} */
  let mcpApp = null;
  /** @type {import("../types.mjs").McpAppEnvironmentInput | null} */
  let mcpAppEnvironment = null;
  if (mcpAppPrepared && mcpAppState && options.mcpApp) {
    const result = planMcpApp({
      root: inspection.root,
      options: options.mcpApp,
      identity: mcpAppPrepared.identity,
      state: mcpAppState,
      persisted: mcpAppPrepared.persisted,
      contractDocument: mcpAppPrepared.contractDocument,
      port,
      tamaImage: options.image ?? DEFAULTS.tamaImage,
      manageFile: managedFiles.plan,
      removeManagedFile: managedFiles.remove,
      materializeKeys: options.materializeSecrets ?? true,
    });
    mcpApp = result.plan;
    mcpAppEnvironment = result.environmentInput;
  }
  const environment = planEnvironment(
    inspection.root,
    options.port,
    mcpAppEnvironment ?? undefined,
    options.materializeSecrets ?? true,
    mcpAppFreshPort,
  );
  // The host-gateway mapping must survive ordinary reruns without --mcp-app:
  // the persisted integration (and .tama.env) outlives the current plan, so
  // the mapping is derived from the persisted provider origin as well.
  const persistedMcpApp = readMcpAppProvider(inspection.tamaDirectory);
  const providerUsesHostGateway = [
    ...(mcpApp ? [mcpApp.providerOrigin] : []),
    ...(persistedMcpApp?.providerOrigin ? [persistedMcpApp.providerOrigin] : []),
  ].some((origin) => {
    try {
      return new URL(origin).hostname === "host.docker.internal";
    } catch {
      return false;
    }
  });
  const replacements = {
    PORT: environment.port,
    CONTAINER_PORT: DEFAULTS.containerPort,
    TAMA_IMAGE: options.image ?? DEFAULTS.tamaImage,
    POSTGRES_IMAGE: DEFAULTS.postgresImage,
    TAMA_EXTRA_HOSTS: providerUsesHostGateway ? TAMA_EXTRA_HOSTS_BLOCK : "",
  };

  /** @type {FileOperation[]} */
  const operations = [
    ...planGitignore(inspection.root, mcpApp?.provider.environmentFile ?? null),
    environment.operation,
    environment.postgresOperation,
  ];
  operations.push(
    managedTemplate(
      managedFiles.plan,
      join(inspection.root, ".tama.env.example"),
      "tama-env.example",
      { PORT: environment.port, MCP_APP_EXAMPLE: mcpAppExample(mcpApp) },
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
  if (mcpApp) {
    operations.push(...mcpApp.operations);
  }

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
      MCP_APP_GUIDANCE: mcpAppReadmeGuidance(mcpApp),
    }),
  );
  operations.push(
    managedTemplate(
      managedFiles.plan,
      join(inspection.tamaDirectory, "AGENTS.md"),
      "AGENTS.md",
      {},
    ),
  );
  if (skillMode === "local") {
    operations.push(...planAgentSkills(inspection.root, managedFiles.plan));
  }
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
    skillMode,
    terraform: {
      foundation: terraform.foundation,
      providerVersion: terraform.providerVersion,
      globalModuleVersion: terraform.globalModuleVersion,
    },
    operations,
    mcpApp,
    mcpAppVerification: null,
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
    skillMode: plan.skillMode,
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
    provider: plan.mcpApp
      ? {
          name: plan.mcpApp.provider.name,
          environmentPrefix: plan.mcpApp.provider.environmentPrefix,
          environmentFile: plan.mcpApp.provider.environmentFile,
          identitySource: plan.mcpApp.provider.source,
          contractPath: plan.mcpApp.contractPath,
          mode: plan.mcpApp.providerLifecycle,
          modeVariable: plan.mcpApp.bindings.roles.mode,
          environmentLoading: plan.mcpApp.environmentLoading,
        }
      : null,
    mcpApp: plan.mcpApp
      ? {
          compatibilityIdentifier: MCP_APP_COMPATIBILITY_IDENTIFIER,
          mode: plan.mcpApp.lifecycle,
          providerOrigin: plan.mcpApp.providerOrigin,
          tamaOrigin: plan.mcpApp.tamaOrigin,
          resource: plan.mcpApp.resource,
          allowedOrigins: plan.mcpApp.allowedOrigins,
          jwksUri: `${plan.mcpApp.providerOrigin}/.well-known/jwks.json`,
          introspectionEndpoint: `${plan.mcpApp.providerOrigin}/auth/introspections`,
          introspectionClientId: plan.mcpApp.introspectionClientId,
          providerSigningKeyId: plan.mcpApp.providerSigningKeyId,
          introspectionSigningKeyId: plan.mcpApp.introspectionSigningKeyId,
          environmentLoading: plan.mcpApp.environmentLoading,
          activated:
            plan.mcpApp.lifecycle === "enabled" && plan.mcpApp.providerLifecycle === "enabled",
          providerActivationRequired:
            plan.mcpApp.lifecycle === "enabled" && plan.mcpApp.providerLifecycle !== "enabled",
          providerReachable: plan.mcpAppVerification?.providerReachable ?? false,
          tamaReachable: plan.mcpAppVerification?.tamaReachable ?? false,
          verified: plan.mcpAppVerification?.verified ?? false,
          probes: plan.mcpAppVerification?.probes ?? [],
        }
      : null,
  };
}
