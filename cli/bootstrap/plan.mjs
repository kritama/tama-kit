// @ts-check

import { join, relative, resolve } from "node:path";
import { ownershipError, usageError } from "../errors.mjs";
import { planRootCompose } from "./compose.mjs";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { BOOTSTRAP_PATHS, BOOTSTRAP_SCHEMA_VERSION, DEFAULTS } from "./constants.mjs";
import { inspectProject } from "./detect-project.mjs";
import { planEnvironment, resolveEnvironmentPort } from "./environment.mjs";
import { planGitignore, validateSecretFilesUntracked } from "./gitignore.mjs";
import {
  localHttpsPaths,
  renderLocalCaDockerfile,
  resolveLocalHttpsTopology,
  usesLocalHttpsTopology,
} from "./local-https.mjs";
import { planMcpApp, resolveMcpAppState } from "./mcp-app.mjs";
import {
  contractTamaPort,
  invalidOfficialTamaImageTag,
  loadTamaContract,
  MCP_APP_COMPATIBILITY_IDENTIFIER,
} from "./mcp-app-contract.mjs";
import {
  mcpAppLocalContractFilename,
  serializeMcpAppLocalContract,
} from "./mcp-app-local-contract.mjs";
import { createOwnedFilePlanner } from "./owned-files.mjs";
import { resolveProviderTopology } from "./provider-topology.mjs";
import { SETUP_CHECKLIST } from "./setup-progress.mjs";
import { planAgentSkills } from "./skills.mjs";
import { renderTemplate } from "./templates.mjs";
import { planTerraform } from "./terraform.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapPlanOptions} BootstrapPlanOptions */
/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").McpAppPlan} McpAppPlan */
/** @typedef {import("../types.mjs").PublicBootstrapPlan} PublicBootstrapPlan */

const TAMA_EXTRA_HOSTS_BLOCK = "    extra_hosts:\n      - host.docker.internal:host-gateway\n";

/** @param {McpAppPlan | null} mcpApp */
function mcpAppExample(mcpApp) {
  if (!mcpApp) {
    return "";
  }
  const derivedIdentities = mcpApp.localHttps
    ? []
    : [
        `TAMA_MCP_APP_RESOURCE=${mcpApp.resource}`,
        `TAMA_MCP_APP_INTROSPECTION_CLIENT_ID=${mcpApp.introspectionClientId}`,
      ];
  return [
    "",
    "# MCP App public configuration. Private JWK material is intentionally omitted.",
    `TAMA_MCP_APP_MODE=${mcpApp.lifecycle}`,
    ...derivedIdentities.slice(0, 1),
    `TAMA_MCP_APP_AUTHORIZATION_SERVER=${mcpApp.providerOrigin}`,
    `TAMA_MCP_APP_JWKS_URI=${mcpApp.providerOrigin}/.well-known/jwks.json`,
    `TAMA_MCP_APP_INTROSPECTION_ENDPOINT=${mcpApp.providerOrigin}/auth/introspections`,
    "TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM=RS256",
    "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS=[]",
    ...derivedIdentities.slice(1),
    `TAMA_MCP_APP_ALLOWED_ORIGINS=${mcpApp.allowedOrigins.join(",")}`,
  ].join("\n");
}

/** @param {McpAppPlan | null} mcpApp */
function mcpAppReadmeGuidance(mcpApp) {
  if (!mcpApp) {
    return "";
  }
  const providerService = mcpApp.localHttps?.providerService;
  const providerRuntime = providerService
    ? `provider Compose service \`${providerService}\``
    : "host-native provider";
  return [
    "",
    "## MCP App provider integration",
    "",
    `The provider fragment \`${mcpApp.provider.environmentFile}\` and \`${BOOTSTRAP_PATHS.environment}\` contain private signing material. Keep both files untracked and never paste their values into chat or logs.`,
    "",
    "The non-secret local bridge contract is at `tama/contracts/mcp-app-provider-v1.json`. It records resolved names and loader evidence; it is local configuration, not proof that the provider implements the OAuth runtime contract.",
    "",
    `The exact provider issuer is \`${mcpApp.providerOrigin}\`; the exact Tama resource is \`${mcpApp.resource}\`. Browser/MCP clients are limited to: ${mcpApp.allowedOrigins.map((origin) => `\`${origin}\``).join(", ")}.`,
    "",
    ...(mcpApp.localHttps
      ? [
          `Caddy is the public HTTPS entry point at \`${mcpApp.localHttps.providerOrigin}\` and \`${mcpApp.localHttps.tamaOrigin}\`. The private upstreams (${mcpApp.localHttps.providerUpstream} and ${mcpApp.localHttps.tamaUpstream}) are Docker routing details and must not be used as OAuth identities.`,
          providerService
            ? `The provider runs in the application-owned Compose service \`${providerService}\`. Its development image, listener, environment loader, and lifecycle restart remain application-owned.`
            : "The provider remains host-native in MIX_ENV=dev.",
          "Tama runs in the official release image with MIX_ENV=prod and trusts the public mkcert CA through the generated derived image.",
          `Verify the public runtime with \`curl --cacert tama/tls/rootCA.pem ${mcpApp.localHttps.healthUrl}\` after starting Compose.`,
          "",
        ]
      : []),
    `Activation is staged. Run \`tama-kit setup --activate\` to verify prepared state and enable Tama. Tama Kit does not restart the ${providerRuntime}: set the provider mode variable to \`enabled\`, restart the provider, then rerun the same command. An enabled checkpoint is reported only after both live services pass verification.`,
  ].join("\n");
}

/**
 * @param {(filename: string, content: string) => FileOperation} planFile
 * @param {string} filename
 * @param {string} templateName
 * @param {Record<string, string | number>} replacements
 * @returns {FileOperation}
 */
function generatedTemplate(planFile, filename, templateName, replacements) {
  return planFile(filename, renderTemplate(templateName, replacements));
}

/** @param {BootstrapPlanOptions} options @returns {BootstrapPlan} */
export function createBootstrapPlan(options) {
  const inspection = inspectProject(options);
  const skillMode = options.skillMode ?? "manual";
  const mcpAppPrepared = options.mcpApp?.requested ? (options.mcpAppPrepared ?? null) : null;
  if (options.mcpApp?.requested && !mcpAppPrepared)
    throw usageError("the MCP App provider identity must be prepared before planning");
  const tamaImage =
    options.image ?? (mcpAppPrepared ? DEFAULTS.mcpAppTamaImage : DEFAULTS.tamaImage);
  const invalidOfficialTag = invalidOfficialTamaImageTag(tamaImage);
  if (invalidOfficialTag) throw usageError(invalidOfficialTag);
  if (
    mcpAppPrepared &&
    resolve(inspection.root, mcpAppPrepared.identity.environmentFile) ===
      resolve(inspection.selectedCompose)
  )
    throw usageError("the provider environment fragment collides with the selected Compose file");
  const secretFiles = [
    BOOTSTRAP_PATHS.environment,
    BOOTSTRAP_PATHS.postgresEnvironment,
    ...(mcpAppPrepared ? [mcpAppPrepared.identity.environmentFile] : []),
  ];
  validateSecretFilesUntracked(inspection.root, secretFiles);
  const providerTopology = resolveProviderTopology(options.mcpApp, inspection.selectedCompose);
  const localHttpsTopology =
    mcpAppPrepared &&
    options.mcpApp &&
    usesLocalHttpsTopology(options.mcpApp, mcpAppPrepared.contractDocument)
      ? resolveLocalHttpsTopology({
          ...providerTopology,
          localDomain: options.mcpApp.localDomain,
          providerPort: options.mcpApp.providerPort,
          allowedOrigins: mcpAppPrepared.allowedOrigins,
        })
      : null;
  if (!localHttpsTopology && (options.mcpApp?.providerService || options.mcpApp?.providerRuntime))
    throw usageError("provider runtime selection requires local HTTPS");
  if (localHttpsTopology) {
    const paths = localHttpsPaths(inspection.root);
    validateSecretFilesUntracked(inspection.root, [
      ...secretFiles,
      ...[paths.certificate, paths.privateKey, paths.rootCertificate].map((path) =>
        relative(inspection.root, path),
      ),
    ]);
  }
  const mcpAppState = mcpAppPrepared
    ? resolveMcpAppState({
        root: inspection.root,
        identity: mcpAppPrepared.identity,
        contractPath: mcpAppPrepared.contractPath,
        contractDocument: mcpAppPrepared.contractDocument,
        selectedCompose: inspection.selectedCompose,
        topology: localHttpsTopology,
      })
    : null;
  const mcpAppFreshPort = mcpAppPrepared
    ? (contractTamaPort(mcpAppPrepared.contractDocument, loadTamaContract()) ?? undefined)
    : undefined;
  const port = localHttpsTopology
    ? localHttpsTopology.tamaPort
    : resolveEnvironmentPort(inspection.root, options.port, mcpAppFreshPort);
  const ownedFiles = createOwnedFilePlanner(
    inspection.root,
    options.generationId ?? "bootstrap",
    Boolean(options.resumePending),
  );
  const localContractOperation = mcpAppState
    ? ownedFiles.plan(
        mcpAppLocalContractFilename(inspection.root),
        serializeMcpAppLocalContract(mcpAppState.localContract),
      )
    : null;
  /** @type {McpAppPlan | null} */
  let mcpApp = null;
  /** @type {import("../types.mjs").McpAppEnvironmentInput | null} */
  let mcpAppEnvironment = null;
  if (mcpAppPrepared && mcpAppState && options.mcpApp) {
    const result = planMcpApp({
      root: inspection.root,
      options: { ...options.mcpApp, localHttps: localHttpsTopology },
      identity: mcpAppPrepared.identity,
      state: mcpAppState,
      contractDocument: mcpAppPrepared.contractDocument,
      port,
      tamaImage,
      manageFile: ownedFiles.plan,
      materializeKeys: options.materializeSecrets ?? true,
      localContractOperation: /** @type {FileOperation} */ (localContractOperation),
    });
    mcpApp = result.plan;
    mcpAppEnvironment = result.environmentInput;
    if (localHttpsTopology) {
      const updatedContractOperation = ownedFiles.plan(
        mcpAppLocalContractFilename(inspection.root),
        serializeMcpAppLocalContract(
          /** @type {import("../types.mjs").McpAppLocalContract} */ (mcpApp.localContract),
        ),
      );
      mcpApp.localContractOperation = updatedContractOperation;
      mcpApp.operations[0] = updatedContractOperation;
      if (mcpAppState) {
        mcpAppState.localContract = /** @type {import("../types.mjs").McpAppLocalContract} */ (
          mcpApp.localContract
        );
      }
    }
  }
  const mcpAppDoc = mcpApp;
  const environment = planEnvironment(
    inspection.root,
    localHttpsTopology ? undefined : options.port,
    mcpAppEnvironment ?? undefined,
    options.materializeSecrets ?? true,
    localHttpsTopology ? localHttpsTopology.tamaPort : mcpAppFreshPort,
  );
  const providerUsesHostGateway =
    Boolean(localHttpsTopology) ||
    (mcpApp ? new URL(mcpApp.providerOrigin).hostname === "host.docker.internal" : false);
  const replacements = {
    PORT: environment.port,
    CONTAINER_PORT: DEFAULTS.containerPort,
    TAMA_IMAGE: tamaImage,
    POSTGRES_IMAGE: DEFAULTS.postgresImage,
    TAMA_EXTRA_HOSTS: providerUsesHostGateway ? TAMA_EXTRA_HOSTS_BLOCK : "",
    CADDY_IMAGE: localHttpsTopology?.caddyImage ?? "",
    CADDY_EXTRA_HOSTS: localHttpsTopology?.providerService ? "" : TAMA_EXTRA_HOSTS_BLOCK,
    PROVIDER_DEPENDENCY: localHttpsTopology?.providerService
      ? `      ${localHttpsTopology.providerService}:\n        condition: ${localHttpsTopology.providerDependency}\n`
      : "",
    HTTPS_PORT: localHttpsTopology?.httpsPort ?? "",
    PROVIDER_HOST: localHttpsTopology?.providerHost ?? "",
    TAMA_HOST: localHttpsTopology?.tamaHost ?? "",
    PROVIDER_UPSTREAM: localHttpsTopology?.providerUpstream ?? "",
    TAMA_UPSTREAM: localHttpsTopology?.tamaUpstream ?? "",
    TAMA_LOCAL_IMAGE: `${tamaImage.replace(/[^a-zA-Z0-9_.-]+/gu, "-")}-local-ca`,
  };

  /** @type {FileOperation[]} */
  const operations = [
    ...planGitignore(inspection.root, {
      current: mcpApp?.provider.environmentFile ?? null,
      localHttps: Boolean(localHttpsTopology),
    }),
    environment.operation,
    environment.postgresOperation,
  ];
  operations.push(
    generatedTemplate(
      ownedFiles.plan,
      join(inspection.root, BOOTSTRAP_PATHS.environmentExample),
      "tama-env.example",
      {
        PORT: environment.port,
        PHX_HOST: mcpAppDoc?.localHttps?.tamaHost ?? "localhost",
        TAMA_OAUTH_ISSUER:
          mcpAppDoc?.localHttps?.tamaOrigin ?? `http://localhost:${environment.port}`,
        TAMA_MCP_RESOURCE: mcpAppDoc?.localHttps
          ? `${mcpAppDoc.localHttps.tamaOrigin}/mcp`
          : `http://localhost:${environment.port}/mcp`,
        TAMA_MCP_ALLOWED_ORIGINS:
          mcpAppDoc?.localHttps?.allowedOrigins?.join(",") ??
          `http://localhost:${environment.port}`,
        TAMA_BASE_URL: mcpAppDoc?.localHttps?.tamaOrigin ?? `http://localhost:${environment.port}`,
        MCP_APP_EXAMPLE: mcpAppExample(mcpAppDoc),
      },
    ),
  );
  if (localHttpsTopology) {
    operations.push(
      generatedTemplate(ownedFiles.plan, join(inspection.tamaDirectory, "Caddyfile"), "Caddyfile", {
        PROVIDER_HOST: localHttpsTopology.providerHost,
        TAMA_HOST: localHttpsTopology.tamaHost,
        PROVIDER_UPSTREAM: localHttpsTopology.providerUpstream,
        TAMA_UPSTREAM: localHttpsTopology.tamaUpstream,
      }),
    );
    operations.push(
      ownedFiles.plan(
        join(inspection.tamaDirectory, "tama-local-ca.Dockerfile"),
        renderLocalCaDockerfile(tamaImage),
      ),
    );
  }
  operations.push(
    generatedTemplate(
      ownedFiles.plan,
      join(inspection.root, BOOTSTRAP_PATHS.compose),
      localHttpsTopology ? "compose-mcp-app-https.yaml" : "compose.yaml",
      replacements,
    ),
  );
  operations.push(
    planRootCompose(
      inspection.selectedCompose,
      join(inspection.root, BOOTSTRAP_PATHS.compose),
      renderTemplate("root-compose.yaml"),
    ),
  );
  if (mcpApp) {
    operations.push(...mcpApp.operations);
  }

  const terraform = planTerraform(
    inspection.tamaDirectory,
    {
      terraformVersion: DEFAULTS.terraformVersion,
      providerVersion: DEFAULTS.providerVersion,
      globalModuleVersion: DEFAULTS.globalModuleVersion,
    },
    ownedFiles.plan,
  );
  operations.push(...terraform.operations);
  const projectComposePath = relative(inspection.root, inspection.selectedCompose);
  operations.push(
    generatedTemplate(
      ownedFiles.documentation,
      join(inspection.tamaDirectory, "README.md"),
      "README.md",
      {
        PORT: environment.port,
        TAMA_PUBLIC_URL:
          mcpAppDoc?.localHttps?.healthUrl ?? `http://localhost:${environment.port}/`,
        COMPOSE_UP_COMMAND: formatComposeUpCommand(
          projectComposePath,
          mcpAppDoc?.localHttps ? "caddy" : "tama",
          Boolean(mcpAppDoc?.localHttps),
        ),
        COMPOSE_PS_COMMAND: formatComposePsCommand(projectComposePath),
        MCP_APP_GUIDANCE: mcpAppReadmeGuidance(mcpAppDoc),
        SETUP_CHECKLIST,
      },
    ),
  );
  operations.push(
    generatedTemplate(
      ownedFiles.documentation,
      join(inspection.tamaDirectory, "AGENTS.md"),
      "AGENTS.md",
      {},
    ),
  );
  if (skillMode === "local") {
    operations.push(...planAgentSkills(inspection.root, ownedFiles.documentation));
  }
  operations.push(ownedFiles.receiptOperation());
  if (options.resumePending) {
    const pending = new Set(options.resumePending);
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      const path = relative(inspection.root, operation.path).split("\\").join("/");
      if (path === BOOTSTRAP_PATHS.manifest) continue;
      if (operation.action === "create" && !pending.has(path))
        throw ownershipError(
          "resume cannot recreate a destination not listed as pending in the unfinished receipt",
          { path },
        );
      if (operation.action === "update" && operation.owner !== "user") {
        throw ownershipError(
          "resume configuration disagrees with existing output; use the original generation options. No files were written",
          { path },
        );
      }
    }
    for (const path of pending)
      if (
        !(
          localHttpsTopology &&
          ["tama/tls/local.pem", "tama/tls/local-key.pem", "tama/tls/rootCA.pem"].includes(path)
        ) &&
        !operations.some(
          (operation) => relative(inspection.root, operation.path).split("\\").join("/") === path,
        )
      )
        throw ownershipError(
          "resume options do not include all pending destinations; supply the original generation options",
          { path },
        );
  }

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
    localHttps: localHttpsTopology,
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
    providerContract:
      plan.mcpApp?.localContract && plan.mcpApp.localContractOperation
        ? {
            path: relative(plan.root, plan.mcpApp.localContractOperation.path),
            source: plan.mcpApp.localContract.source.type,
            sourcePath: plan.mcpApp.localContract.source.provider_contract_path,
            bindingSource: plan.mcpApp.bindings.source,
            compatibilityIdentifier: plan.mcpApp.localContract.compatibility_identifier,
            environmentLoading: plan.mcpApp.localContract.environment_loading.status,
            environmentLoadingMechanism: plan.mcpApp.localContract.environment_loading.mechanism,
            environmentLoadingEvidencePath:
              plan.mcpApp.localContract.environment_loading.evidence_path,
            action: plan.mcpApp.localContractOperation.action,
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
          jwksUri: `${plan.mcpApp.providerOrigin}${plan.mcpApp.localContract?.public_endpoints.jwks ?? "/.well-known/jwks.json"}`,
          introspectionEndpoint: `${plan.mcpApp.providerOrigin}${plan.mcpApp.localContract?.public_endpoints.introspection ?? "/auth/introspections"}`,
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
    localHttps: plan.localHttps
      ? {
          profile: plan.localHttps.profile,
          localDomain: plan.localHttps.localDomain,
          providerHost: plan.localHttps.providerHost,
          tamaHost: plan.localHttps.tamaHost,
          providerOrigin: plan.localHttps.providerOrigin,
          tamaOrigin: plan.localHttps.tamaOrigin,
          resource: plan.localHttps.resource,
          healthUrl: plan.localHttps.healthUrl,
          providerUpstream: plan.localHttps.providerUpstream,
          tamaUpstream: plan.localHttps.tamaUpstream,
          providerPort: plan.localHttps.providerPort,
          tamaPort: plan.localHttps.tamaPort,
          httpsPort: plan.localHttps.httpsPort,
          certificateNames: plan.localHttps.certificateNames,
          caddyImage: plan.localHttps.caddyImage,
          trustMechanism: plan.localHttps.trustMechanism,
          allowedOrigins: plan.localHttps.allowedOrigins,
        }
      : null,
  };
}
