// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ownershipError, usageError } from "../errors.mjs";
import { planRootCompose, validateComposeDocument } from "./compose.mjs";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { BOOTSTRAP_PATHS, BOOTSTRAP_SCHEMA_VERSION, DEFAULTS } from "./constants.mjs";
import { inspectProject } from "./detect-project.mjs";
import { planEnvironment, readEnvironmentValues, resolveEnvironmentPort } from "./environment.mjs";
import { planGitignore, validateSecretFilesUntracked } from "./gitignore.mjs";
import {
  localHttpsPaths,
  renderLocalCaDockerfile,
  resolveLocalHttpsTopology,
  usesLocalHttpsTopology,
} from "./local-https.mjs";
import { createManagedFilePlanner, readMcpAppProvider } from "./manifest.mjs";
import { persistedTamaOrigin, planMcpApp, resolveMcpAppState } from "./mcp-app.mjs";
import {
  contractTamaPort,
  discoverProviderContract,
  invalidOfficialTamaImageTag,
  loadTamaContract,
  MCP_APP_COMPATIBILITY_IDENTIFIER,
  unpinnedTamaImageTag,
  unsupportedTamaImage,
} from "./mcp-app-contract.mjs";
import {
  MCP_APP_LOCAL_CONTRACT_PATH,
  mcpAppLocalContractFilename,
  serializeMcpAppLocalContract,
} from "./mcp-app-local-contract.mjs";
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
const TAMA_MCP_APP_RESOURCE_PATH = "/mcp/app";

/**
 * Manifests written before Tama images were recorded still have a managed
 * runtime file containing the exact selected image. Read it once so the next
 * plan can preserve and persist that selection instead of substituting a
 * default.
 *
 * @param {string} root
 * @param {PersistedMcpAppProvider} persisted
 */
function legacyMcpAppTamaImage(root, persisted) {
  const filename = persisted.localHttps
    ? join(root, BOOTSTRAP_PATHS.tamaDirectory, "tama-local-ca.Dockerfile")
    : join(root, BOOTSTRAP_PATHS.compose);
  if (!existsSync(filename)) {
    throw ownershipError(`cannot recover the persisted MCP App Tama image: ${filename}`, {
      path: filename,
    });
  }

  let image;
  if (persisted.localHttps) {
    image = readFileSync(filename, "utf8").match(/^FROM\s+(\S+)\s*$/mu)?.[1];
  } else {
    const compose = validateComposeDocument(readFileSync(filename, "utf8"), filename);
    const services =
      compose.services && typeof compose.services === "object" && !Array.isArray(compose.services)
        ? /** @type {Record<string, unknown>} */ (compose.services)
        : null;
    const tama =
      services?.tama && typeof services.tama === "object" && !Array.isArray(services.tama)
        ? /** @type {Record<string, unknown>} */ (services.tama)
        : null;
    image = typeof tama?.image === "string" ? tama.image : undefined;
  }
  if (!image || /\s/u.test(image)) {
    throw ownershipError(`cannot recover the persisted MCP App Tama image: ${filename}`, {
      path: filename,
    });
  }
  return image;
}

/**
 * Builds the public MCP documentation view from the persisted integration so
 * ordinary reruns (which do not re-plan the MCP App) keep the managed example
 * and README section in sync with the live integration instead of dropping
 * it. The signing keys are not documentation material and stay empty.
 *
 * @param {PersistedMcpAppProvider | null} persisted
 * @param {string} root
 * @returns {McpAppPlan | null}
 */
function persistedMcpDocView(persisted, root) {
  if (!persisted?.providerOrigin || !persisted.tamaOrigin) {
    return null;
  }
  const resource = `${persisted.tamaOrigin}${TAMA_MCP_APP_RESOURCE_PATH}`;
  const mode = readEnvironmentValues(root, BOOTSTRAP_PATHS.environment).get("TAMA_MCP_APP_MODE");
  const lifecycle =
    mode === "disabled" || mode === "prepared" || mode === "enabled" ? mode : "prepared";
  return {
    provider: persisted.identity,
    contractSource: persisted.contractSource,
    contractPath: persisted.contractPath,
    bindings: { roles: persisted.bindings, source: persisted.contractSource },
    lifecycle,
    providerLifecycle: lifecycle,
    environmentLoading: persisted.environmentLoading,
    environmentLoadingMechanism: persisted.environmentLoadingMechanism ?? null,
    environmentLoadingEvidencePath: persisted.environmentLoadingEvidencePath ?? null,
    providerOrigin: persisted.providerOrigin,
    tamaOrigin: persisted.tamaOrigin,
    resource,
    allowedOrigins: persisted.allowedOrigins ?? [],
    introspectionClientId: `${resource}/introspection`,
    providerSigningKeyId: "",
    introspectionSigningKeyId: "",
    operations: [],
    localHttps: persisted.localHttps ?? null,
  };
}

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
  return [
    "",
    "## MCP App provider integration",
    "",
    `The provider fragment \`${mcpApp.provider.environmentFile}\` and \`${BOOTSTRAP_PATHS.environment}\` contain private signing material. Keep both files untracked and never paste their values into chat or logs.`,
    "",
    "The non-secret local bridge contract is managed at `tama/contracts/mcp-app-provider-v1.json`. It records resolved names and loader evidence; it is local configuration, not proof that the provider implements the OAuth runtime contract.",
    "",
    `The exact provider issuer is \`${mcpApp.providerOrigin}\`; the exact Tama resource is \`${mcpApp.resource}\`. Browser/MCP clients are limited to: ${mcpApp.allowedOrigins.map((origin) => `\`${origin}\``).join(", ")}.`,
    "",
    ...(mcpApp.localHttps
      ? [
          `Caddy is the public HTTPS entry point at \`${mcpApp.localHttps.providerOrigin}\` and \`${mcpApp.localHttps.tamaOrigin}\`. The private upstreams (${mcpApp.localHttps.providerUpstream} and ${mcpApp.localHttps.tamaUpstream}) are Docker routing details and must not be used as OAuth identities.`,
          `The provider remains host-native in MIX_ENV=dev; Tama runs in the official release image with MIX_ENV=prod and trusts the public mkcert CA through the generated derived image.`,
          `Verify the public runtime with \`curl --cacert tama/tls/rootCA.pem ${mcpApp.localHttps.healthUrl}\` after starting Compose.`,
          "",
        ]
      : []),
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
  // A persisted provider fragment holds the provider's private signing key,
  // so it is a tracked-secret failure on every run, not only --mcp-app runs.
  let persistedMcpApp = readMcpAppProvider(inspection.tamaDirectory);
  if (persistedMcpApp && !persistedMcpApp.tamaImage) {
    persistedMcpApp = {
      ...persistedMcpApp,
      tamaImage: legacyMcpAppTamaImage(inspection.root, persistedMcpApp),
    };
  }
  const tamaImage =
    options.image ??
    persistedMcpApp?.tamaImage ??
    (mcpAppPrepared !== null ? DEFAULTS.mcpAppTamaImage : DEFAULTS.tamaImage);
  const invalidOfficialTag = invalidOfficialTamaImageTag(tamaImage);
  if (invalidOfficialTag) {
    throw usageError(invalidOfficialTag);
  }
  if (
    mcpAppPrepared &&
    resolve(inspection.root, mcpAppPrepared.identity.environmentFile) ===
      resolve(inspection.selectedCompose)
  ) {
    throw usageError(
      `the provider environment fragment collides with the selected Compose file: ${mcpAppPrepared.identity.environmentFile}`,
    );
  }
  const secretFiles = [
    BOOTSTRAP_PATHS.environment,
    BOOTSTRAP_PATHS.postgresEnvironment,
    ...(mcpAppPrepared ? [mcpAppPrepared.identity.environmentFile] : []),
    ...(mcpAppPrepared?.persisted ? [mcpAppPrepared.persisted.identity.environmentFile] : []),
    ...(persistedMcpApp ? [persistedMcpApp.identity.environmentFile] : []),
  ];
  validateSecretFilesUntracked(inspection.root, [...new Set(secretFiles)]);
  const localHttpsTopology =
    mcpAppPrepared &&
    options.mcpApp &&
    usesLocalHttpsTopology(options.mcpApp, persistedMcpApp, mcpAppPrepared.contractDocument)
      ? resolveLocalHttpsTopology({
          localDomain: options.mcpApp.localDomain ?? persistedMcpApp?.localHttps?.localDomain,
          providerPort: options.mcpApp.providerPort ?? persistedMcpApp?.localHttps?.providerPort,
          allowedOrigins: mcpAppPrepared.allowedOrigins ?? persistedMcpApp?.allowedOrigins,
        })
      : persistedMcpApp?.localHttps
        ? resolveLocalHttpsTopology({
            localDomain: persistedMcpApp.localHttps.localDomain,
            providerPort: persistedMcpApp.localHttps.providerPort,
            allowedOrigins: persistedMcpApp.allowedOrigins,
          })
        : null;
  if (localHttpsTopology) {
    const tlsPaths = localHttpsPaths(inspection.root);
    validateSecretFilesUntracked(inspection.root, [
      ...new Set([
        ...secretFiles,
        relative(inspection.root, tlsPaths.certificate),
        relative(inspection.root, tlsPaths.privateKey),
        relative(inspection.root, tlsPaths.rootCertificate),
      ]),
    ]);
  }
  const mcpAppState = mcpAppPrepared
    ? {
        ...resolveMcpAppState({
          root: inspection.root,
          identity: mcpAppPrepared.identity,
          contractPath: mcpAppPrepared.contractPath,
          contractDocument: mcpAppPrepared.contractDocument,
          selectedCompose: inspection.selectedCompose,
          topology: localHttpsTopology,
        }),
        tamaImage,
      }
    : null;
  // A fresh MCP App run adopts the Tama port the accepted contract documents
  // so the container and the host-native provider never share a host port.
  const mcpAppFreshPort = mcpAppPrepared
    ? (contractTamaPort(mcpAppPrepared.contractDocument, loadTamaContract()) ?? undefined)
    : undefined;
  const port = localHttpsTopology
    ? localHttpsTopology.tamaPort
    : resolveEnvironmentPort(inspection.root, options.port, mcpAppFreshPort);
  // A persisted MCP App integration binds the resource, the introspection
  // client id, and the provider fragment to the persisted Tama origin.
  // Planning a different port without --mcp-app would leave all of them on
  // the old origin, so the port change is rejected instead.
  const persistedTamaOriginValue =
    persistedMcpApp?.tamaOrigin ?? persistedTamaOrigin(inspection.root);
  if (persistedTamaOriginValue !== null && !localHttpsTopology) {
    let persistedPort;
    try {
      const persistedUrl = new URL(persistedTamaOriginValue);
      persistedPort =
        persistedUrl.port === ""
          ? persistedUrl.protocol === "https:"
            ? 443
            : 80
          : Number(persistedUrl.port);
    } catch {
      throw ownershipError(
        `the persisted MCP App Tama origin ${persistedTamaOriginValue} is not a valid origin`,
        { path: join(inspection.root, BOOTSTRAP_PATHS.manifest) },
      );
    }
    if (persistedPort !== port && mcpAppPrepared === null) {
      throw usageError(
        `the persisted MCP App integration advertises Tama at ${persistedTamaOriginValue}; ` +
          `planning port ${port} would leave the MCP resource, introspection client id, and provider fragment ` +
          `on the old port. Rerun with --mcp-app and the provider integration options so both owners' ` +
          `environment files are updated atomically, or rerun without changing the Tama port`,
      );
    }
  }
  // The persisted integration was created with a pinned, contract-compatible
  // Tama image. An ordinary rerun without --image would fall back to the
  // floating default tag and silently replace that runtime with a release
  // Tama Kit cannot hold to the contract, so the image gate applies to
  // ordinary reruns as well.
  if (persistedMcpApp !== null) {
    const persistedTamaContract = loadTamaContract();
    const persistedProviderContract =
      persistedMcpApp.contractSource === "contract" && persistedMcpApp.contractPath !== null
        ? discoverProviderContract(inspection.root, persistedMcpApp.contractPath).document
        : null;
    const plannedImage = tamaImage;
    const unpinnedTag = unpinnedTamaImageTag(plannedImage);
    if (unpinnedTag !== null) {
      throw usageError(
        `the persisted MCP App integration requires a pinned Tama image, but the planned image ` +
          `${plannedImage} uses the unresolvable tag ${unpinnedTag}; pass --image with an official ` +
          `<version>-server tag inside the supported Tama range ${persistedTamaContract.supported_tama_versions}`,
      );
    }
    const unsupported = unsupportedTamaImage(
      plannedImage,
      persistedTamaContract.supported_tama_versions,
    );
    if (unsupported) {
      throw usageError(
        `${unsupported}; the persisted MCP App integration requires a supported Tama image; ` +
          `pass --image to keep the pinned runtime`,
      );
    }
    const providerUnsupported = unsupportedTamaImage(
      plannedImage,
      persistedProviderContract?.supported_tama_versions,
    );
    if (providerUnsupported) {
      throw usageError(
        `${providerUnsupported}; the persisted provider contract requires a supported Tama image; ` +
          `pass --image to keep the provider-compatible runtime`,
      );
    }
  }
  const managedFiles = createManagedFilePlanner(
    inspection.root,
    inspection.tamaDirectory,
    skillMode,
    mcpAppState ?? (persistedMcpApp ? { ...persistedMcpApp, tamaImage } : null),
  );
  const localContractOperation = mcpAppState
    ? managedFiles.plan(
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
      persisted: mcpAppPrepared.persisted,
      contractDocument: mcpAppPrepared.contractDocument,
      port,
      tamaImage,
      manageFile: managedFiles.plan,
      removeManagedFile: managedFiles.remove,
      materializeKeys: options.materializeSecrets ?? true,
      localContractOperation: /** @type {FileOperation} */ (localContractOperation),
    });
    mcpApp = result.plan;
    mcpAppEnvironment = result.environmentInput;
    if (localHttpsTopology) {
      const updatedContractOperation = managedFiles.plan(
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
  // Ordinary reruns keep the persisted integration alive, so the managed
  // public documentation renders from the persisted state when this run does
  // not plan a new MCP App topology.
  const mcpAppDoc = mcpApp ?? persistedMcpDocView(persistedMcpApp, inspection.root);
  const environmentMcpApp =
    mcpAppEnvironment ??
    (mcpAppDoc
      ? {
          variables: {},
          validation: {
            mode: mcpAppDoc.lifecycle,
            resource: mcpAppDoc.resource,
            authorizationServerOrigin: mcpAppDoc.providerOrigin,
            serviceOrigin: mcpAppDoc.providerOrigin,
            allowedOrigins: mcpAppDoc.allowedOrigins,
            introspectionClientId: mcpAppDoc.introspectionClientId,
            localHttps: mcpAppDoc.localHttps ?? null,
          },
        }
      : undefined);
  const environment = planEnvironment(
    inspection.root,
    localHttpsTopology ? undefined : options.port,
    environmentMcpApp,
    options.materializeSecrets ?? true,
    localHttpsTopology ? localHttpsTopology.tamaPort : mcpAppFreshPort,
  );
  // The host-gateway mapping must survive ordinary reruns without --mcp-app:
  // the persisted integration (and tama/.tama.env) outlives the current plan, so
  // the mapping is derived from the persisted provider origin as well.
  const providerUsesHostGateway =
    Boolean(localHttpsTopology) ||
    [
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
    TAMA_IMAGE: tamaImage,
    POSTGRES_IMAGE: DEFAULTS.postgresImage,
    TAMA_EXTRA_HOSTS: providerUsesHostGateway ? TAMA_EXTRA_HOSTS_BLOCK : "",
    CADDY_IMAGE: localHttpsTopology?.caddyImage ?? "",
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
      current:
        mcpApp?.provider.environmentFile ?? persistedMcpApp?.identity.environmentFile ?? null,
      persisted: persistedMcpApp?.identity.environmentFile ?? null,
      localHttps: Boolean(localHttpsTopology),
    }),
    environment.operation,
    environment.postgresOperation,
  ];
  operations.push(
    managedTemplate(
      managedFiles.plan,
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
      managedTemplate(managedFiles.plan, join(inspection.tamaDirectory, "Caddyfile"), "Caddyfile", {
        PROVIDER_HOST: localHttpsTopology.providerHost,
        TAMA_HOST: localHttpsTopology.tamaHost,
        PROVIDER_UPSTREAM: localHttpsTopology.providerUpstream,
        TAMA_UPSTREAM: localHttpsTopology.tamaUpstream,
      }),
    );
    operations.push(
      managedFiles.plan(
        join(inspection.tamaDirectory, "tama-local-ca.Dockerfile"),
        renderLocalCaDockerfile(tamaImage),
      ),
    );
  }
  operations.push(
    managedTemplate(
      managedFiles.plan,
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
      TAMA_PUBLIC_URL: mcpAppDoc?.localHttps?.healthUrl ?? `http://localhost:${environment.port}/`,
      COMPOSE_UP_COMMAND: formatComposeUpCommand(
        projectComposePath,
        mcpAppDoc?.localHttps ? "caddy" : "tama",
        Boolean(mcpAppDoc?.localHttps),
      ),
      COMPOSE_PS_COMMAND: formatComposePsCommand(projectComposePath),
      MCP_APP_GUIDANCE: mcpAppReadmeGuidance(mcpAppDoc),
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
            path: MCP_APP_LOCAL_CONTRACT_PATH,
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
