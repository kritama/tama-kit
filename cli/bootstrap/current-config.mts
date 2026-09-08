import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { InspectOptions, RuntimePlan } from "../domain/runtime.mjs";
import { ambiguityError, ownershipError, prerequisiteError, usageError } from "../errors.mjs";
import { composeArguments } from "../shared/compose.mjs";
import { isValidVaultKey, parseEnvironment } from "../shared/environment.mjs";
import { contentDigest, inspectRegularFile } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import { validateOAuthPrivateJwk, validatePublicJwkSet } from "../shared/oauth-key.mjs";
import type { LocalHttpsTopology, McpAppMode } from "../types.mjs";
import { verifyEnvironmentLoadingEvidence } from "./contracts/environment-loading.mjs";
import { inspectProject } from "./detect-project.mjs";
import { allowedOrigin } from "./mcp-app.mjs";
import { validateMcpAppLocalContract } from "./mcp-app-local-contract.mjs";
import { validateComposePrerequisite } from "./start.mjs";

type Service = {
  image?: string;
  depends_on?: Record<string, unknown>;
  build?: { context?: string };
  environment?: Record<string, string | null>;
  env_file?: { path: string; required?: boolean }[];
  ports?: { target: number; published?: string; host_ip?: string }[];
  volumes?: { type: string; source: string; target: string }[];
};
type Model = { services: Record<string, Service> };

function readPrivateEnvironment(path: string) {
  const stat = inspectRegularFile(path);
  if (!stat) throw ownershipError("declared private environment file is missing", { path });
  if (stat.mode & 0o077)
    throw ownershipError("private environment file must have owner-only permissions", { path });
  validateSecretFilesUntracked(dirname(path), [path]);
  validateSecretFilesIgnored(dirname(path), [path]);
  const content = readFileSync(path, "utf8");
  // parseEnv handles exports and whitespace; the strict reader diagnoses duplicate simple assignments.
  parseEnvironment(content, path);
  const names = [...content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gmu)].map(
    (m) => m[1],
  );
  if (new Set(names).size !== names.length)
    throw ownershipError("duplicate variables in private environment file", { path });
  return new Map(
    Object.entries(parseEnv(content)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function environment(service: Service) {
  return new Map(
    Object.entries(service.environment ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
function mode(value: string | undefined): McpAppMode {
  if (value === "disabled" || value === "prepared" || value === "enabled") return value;
  throw ownershipError(
    "missing or invalid MCP App mode; inspect the effective service configuration",
  );
}
function origin(value: string | undefined, label: string) {
  try {
    const url = new URL(value ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== value
    )
      throw new Error();
    return url.origin;
  } catch {
    throw ownershipError(`invalid ${label} public origin`);
  }
}
function requireEqual(actual: string | undefined, expected: string, name: string) {
  if (actual !== expected)
    throw ownershipError(
      `effective ${name} disagrees with the current public integration identity`,
    );
}
function selectService(
  services: Record<string, Service>,
  candidates: string[],
  explicit: string | undefined,
  flag: string,
) {
  if (explicit && services[explicit]) return explicit;
  if (explicit)
    throw usageError(`selected ${flag} does not exist in the effective Compose configuration`);
  if (candidates.length !== 1)
    throw ambiguityError(`cannot identify one ${flag}; select it explicitly`, { candidates });
  return candidates[0];
}

/** Native Compose parsing is read-only, daemon-independent and never emits environment values. */
export function inspectCurrentConfiguration(
  options: InspectOptions,
  execute = execFileSync,
): RuntimePlan {
  const inspection = inspectProject({
    cwd: options.cwd,
    targetPath: options.targetPath,
    composePath: options.composeFiles?.[0],
  });
  const root = inspection.root;
  const composeFiles = (options.composeFiles ?? [inspection.selectedCompose]).map((path) =>
    resolve(root, path),
  );
  for (const path of composeFiles)
    if (!inspectRegularFile(path)) throw usageError("selected Compose file is missing");
  const selection = { composeFile: composeFiles[0], runtime: { composeFiles } };
  validateComposePrerequisite();
  function load(noEnvironment: boolean, noInterpolation = false): Model {
    try {
      const output = execute(
        "docker",
        [
          ...composeArguments(selection),
          "config",
          "--format",
          "json",
          ...(noEnvironment ? ["--no-env-resolution"] : []),
          ...(noInterpolation ? ["--no-interpolate"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const model = JSON.parse(output);
      if (!model.services || typeof model.services !== "object" || Array.isArray(model.services))
        throw new Error();
      return model;
    } catch {
      throw ownershipError(
        "Docker Compose configuration could not be resolved; check selected files, required variables and env_file paths. Raw output is suppressed because it may contain secrets.",
      );
    }
  }
  let declarations = load(true);
  if (!Object.values(declarations.services).some((service) => service.env_file?.length)) {
    // Compose 2.x can discard env_file even with --no-env-resolution. Its
    // model-rendering path preserves declarations; effective values still come
    // from the separate, fully resolved native configuration below.
    declarations = load(true, true);
    for (const service of Object.values(declarations.services)) {
      if (service.env_file?.some(({ path }) => path.includes("$"))) {
        throw prerequisiteError(
          "this Docker Compose version cannot preserve interpolated env_file paths during inspection; upgrade Compose to a version that supports --no-env-resolution without discarding declarations",
        );
      }
    }
  }
  const model = load(false);
  const services = model.services;
  const serviceName = selectService(
    services,
    Object.keys(services).filter((name) => Boolean(services[name].environment?.TAMA_OAUTH_ISSUER)),
    options.service,
    "--service",
  );
  const service = services[serviceName];
  const values = environment(service);
  if (
    Buffer.byteLength(values.get("SECRET_KEY_BASE") ?? "") < 64 ||
    !isValidVaultKey(values.get("TAMA_VAULT_KEY") ?? "")
  ) {
    throw ownershipError(
      "effective Tama runtime secrets are missing or invalid (SECRET_KEY_BASE, TAMA_VAULT_KEY)",
    );
  }
  validateOAuthPrivateJwk(
    values.get("TAMA_OAUTH_PRIVATE_JWK") ?? "",
    values.get("TAMA_OAUTH_PRIVATE_JWK_ID") ?? "",
    "TAMA_OAUTH_PRIVATE_JWK",
  );
  const systemOrigin = origin(values.get("TAMA_OAUTH_ISSUER"), "System OAuth");
  const healthUrl = values.get("TAMA_BASE_URL") ?? systemOrigin;
  requireEqual(healthUrl.replace(/\/$/u, ""), systemOrigin, "TAMA_BASE_URL");
  let tamaOrigin = systemOrigin;
  if (values.has("TAMA_MCP_APP_RESOURCE")) {
    try {
      tamaOrigin = origin(new URL(values.get("TAMA_MCP_APP_RESOURCE") ?? "").origin, "MCP App");
    } catch {
      throw ownershipError("invalid effective MCP App resource URL");
    }
  }
  const files = (declarations.services[serviceName]?.env_file ?? []).flatMap(
    ({ path, required }) => {
      const filename = resolve(root, path);
      // Compose skips missing optional declarations. Existing files still pass
      // the regular-file, permissions, ignore and content checks below.
      if (required === false && inspectRegularFile(filename) === null) return [];
      return [filename];
    },
  );
  const envFiles = new Map(files.map((path) => [path, readPrivateEnvironment(path)]));
  const selectedEnvironment = options.environmentFile
    ? resolve(root, options.environmentFile)
    : undefined;
  if (selectedEnvironment && !files.includes(selectedEnvironment))
    throw ownershipError("--env-file is not loaded by the selected Tama service");
  const provisionerFiles = [...envFiles].filter(
    ([, env]) => env.has("TAMA_CLIENT_ID") || env.has("TAMA_CLIENT_SECRET"),
  );
  const provisionerEnvironment =
    provisionerFiles.length === 1 &&
    provisionerFiles[0][1].has("TAMA_CLIENT_ID") &&
    provisionerFiles[0][1].has("TAMA_CLIENT_SECRET")
      ? provisionerFiles[0][0]
      : undefined;
  const modeFiles = [...envFiles].filter(([, env]) => env.has("TAMA_MCP_APP_MODE"));
  const inline = declarations.services[serviceName]?.environment ?? {};
  // Private-environment selection does not select the activation assignment.
  const modeFile = modeFiles.length === 1 ? modeFiles[0][0] : undefined;
  // Only an unshadowed, single declared source is eligible for automatic activation edits.
  const modeSource =
    modeFile &&
    modeFiles.length === 1 &&
    !("TAMA_MCP_APP_MODE" in inline) &&
    envFiles.get(modeFile)?.get("TAMA_MCP_APP_MODE") === values.get("TAMA_MCP_APP_MODE")
      ? { path: modeFile, value: values.get("TAMA_MCP_APP_MODE") ?? "" }
      : undefined;
  const contractPath = resolve(
    root,
    options.contractPath ?? "tama/contracts/mcp-app-provider-v1.json",
  );
  const hasMcp =
    values.has("TAMA_MCP_APP_MODE") ||
    options.contractPath !== undefined ||
    (options.discoverMcpContract !== false && existsSync(contractPath));
  const plan: RuntimePlan = {
    schemaVersion: 1,
    root,
    framework: inspection.framework,
    frameworkEvidence: inspection.frameworkEvidence,
    composeFile: composeFiles[0],
    port: Number(new URL(tamaOrigin).port || (tamaOrigin.startsWith("https:") ? 443 : 80)),
    tamaImage: service.image ?? "",
    postgresImage: "",
    skillMode: "manual",
    terraform: { foundation: "preserved", providerVersion: null, globalModuleVersion: null },
    operations: [],
    mcpApp: null,
    mcpAppVerification: null,
    localHttps: null,
    runtime: {
      composeFiles,
      service: serviceName,
      environmentFile:
        selectedEnvironment ??
        provisionerEnvironment ??
        (files.length === 1 ? (modeFile ?? files[0]) : undefined),
      environment: values,
      healthUrl: `${systemOrigin}/`,
      modeSource,
    },
  };
  if (values.has("TAMA_MCP_APP_MODE")) mode(values.get("TAMA_MCP_APP_MODE"));
  if (!hasMcp) return plan;
  if (!inspectRegularFile(contractPath))
    throw ownershipError(
      "MCP App configuration requires its current local contract; select it with --contract",
      { path: contractPath },
    );
  let contract: ReturnType<typeof validateMcpAppLocalContract>;
  try {
    contract = validateMcpAppLocalContract(JSON.parse(readFileSync(contractPath, "utf8")), {
      currentConfiguration: true,
    });
  } catch {
    throw ownershipError("the selected local MCP App contract is invalid", { path: contractPath });
  }
  const providerPath = resolve(root, contract.provider.environment_file);
  const providerValues = readPrivateEnvironment(providerPath);
  const roles = contract.bindings;
  const candidates = Object.keys(declarations.services).filter((name) =>
    (declarations.services[name].env_file ?? []).some(
      ({ path }) => resolve(root, path) === providerPath,
    ),
  );
  const providerService = options.providerService
    ? selectService(services, candidates, options.providerService, "--provider-service")
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (candidates.length > 1 && !providerService)
    throw ambiguityError("multiple services load the provider fragment; use --provider-service");
  if (providerService && !candidates.includes(providerService))
    throw ownershipError("selected provider service does not load the contract's environment file");
  if (providerService === serviceName)
    throw ownershipError(
      "the Tama service cannot also load the provider fragment; select a separate provider service",
    );
  const effectiveProvider = providerService
    ? environment(services[providerService])
    : providerValues;
  // Declared bindings must agree with the service's actual effective configuration.
  if (providerService)
    for (const variable of Object.values(roles))
      requireEqual(effectiveProvider.get(variable), providerValues.get(variable) ?? "", variable);
  const providerOrigin = origin(effectiveProvider.get(roles.issuer), "provider");
  const resource = `${tamaOrigin}/mcp/app`;
  requireEqual(effectiveProvider.get(roles.resource), resource, roles.resource);
  requireEqual(
    values.get("TAMA_MCP_APP_AUTHORIZATION_SERVER"),
    providerOrigin,
    "TAMA_MCP_APP_AUTHORIZATION_SERVER",
  );
  requireEqual(
    values.get("TAMA_MCP_APP_JWKS_URI"),
    `${providerOrigin}${contract.public_endpoints.jwks}`,
    "TAMA_MCP_APP_JWKS_URI",
  );
  requireEqual(
    values.get("TAMA_MCP_APP_INTROSPECTION_ENDPOINT"),
    `${providerOrigin}${contract.public_endpoints.introspection}`,
    "TAMA_MCP_APP_INTROSPECTION_ENDPOINT",
  );
  for (const [name, expected] of [
    ["TAMA_MCP_APP_RESOURCE", resource],
    ["TAMA_MCP_APP_INTROSPECTION_CLIENT_ID", `${resource}/introspection`],
  ]) {
    if (values.has(name)) requireEqual(values.get(name), expected, name);
  }
  requireEqual(
    effectiveProvider.get(roles.introspection_client_id),
    `${resource}/introspection`,
    roles.introspection_client_id,
  );
  requireEqual(
    effectiveProvider.get(roles.introspection_jwks_uri),
    `${tamaOrigin}/.well-known/jwks.json`,
    roles.introspection_jwks_uri,
  );
  const providerKid = effectiveProvider.get(roles.access_token_signing_key_id) ?? "";
  const tamaKid = values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID") ?? "";
  validateOAuthPrivateJwk(
    effectiveProvider.get(roles.access_token_private_signing_key) ?? "",
    providerKid,
    roles.access_token_private_signing_key,
    roles.access_token_signing_key_id,
  );
  validateOAuthPrivateJwk(
    values.get("TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY") ?? "",
    tamaKid,
    "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
    "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
  );
  requireEqual(
    effectiveProvider.get(roles.access_token_signing_algorithm),
    "RS256",
    roles.access_token_signing_algorithm,
  );
  requireEqual(
    values.get("TAMA_MCP_APP_SIGNING_ALGORITHMS"),
    "RS256",
    "TAMA_MCP_APP_SIGNING_ALGORITHMS",
  );
  requireEqual(
    values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM"),
    "RS256",
    "TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM",
  );
  for (const [environment, variable, kid] of [
    [effectiveProvider, roles.access_token_public_overlap_keys, providerKid],
    [values, "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS", tamaKid],
  ] as const) {
    const encoded = environment.get(variable);
    if (encoded !== undefined) validatePublicJwkSet(encoded, variable, kid);
  }
  const allowedOrigins = (values.get("TAMA_MCP_APP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    if (!allowedOrigins.length || allowedOrigins.length > 32) throw new Error();
    for (const value of allowedOrigins) allowedOrigin(value);
  } catch {
    throw ownershipError(
      "MCP App allowed origins are invalid; use at most 32 HTTPS or HTTP loopback origins",
    );
  }
  const topology = contract.topology;
  if (topology) {
    requireEqual(topology.provider_origin, providerOrigin, "contract provider origin");
    requireEqual(topology.tama_origin, tamaOrigin, "contract Tama origin");
    requireEqual(topology.resource, resource, "contract resource");
    if (
      JSON.stringify([...topology.allowed_origins].sort()) !==
      JSON.stringify([...allowedOrigins].sort())
    )
      throw ownershipError("contract and Tama allowed origins disagree");
    const proxy = selectService(
      services,
      Object.keys(services).filter((name) =>
        services[name].ports?.some((port) => Number(port.published) === topology.https_port),
      ),
      options.proxyService,
      "--proxy-service",
    );
    const proxyTargetPort = Number(
      services[proxy].ports?.find((port) => Number(port.published) === topology.https_port)?.target,
    );
    if (!Number.isInteger(proxyTargetPort) || proxyTargetPort < 1 || proxyTargetPort > 65_535)
      throw ownershipError("the selected HTTPS proxy has no valid container target port");
    const tlsMount = services[proxy].volumes?.find(
      (volume) => volume.type === "bind" && volume.target === "/etc/tama-kit/tls",
    );
    const caFile = options.caFile
      ? resolve(root, options.caFile)
      : tlsMount
        ? join(tlsMount.source, "rootCA.pem")
        : undefined;
    if (!caFile || !inspectRegularFile(caFile))
      throw ownershipError(
        "cannot locate the local HTTPS CA; select its current path with --ca-file",
      );
    plan.runtime.caFile = caFile;
    plan.runtime.proxyService = proxy;
    const localHttps: LocalHttpsTopology = {
      profile: "mcp-app-local-https",
      localDomain: topology.local_domain,
      providerHost: new URL(providerOrigin).hostname,
      tamaHost: new URL(tamaOrigin).hostname,
      providerOrigin,
      tamaOrigin,
      resource,
      introspectionClientId: `${resource}/introspection`,
      providerJwksUri: `${providerOrigin}${contract.public_endpoints.jwks}`,
      providerIntrospectionEndpoint: `${providerOrigin}${contract.public_endpoints.introspection}`,
      tamaJwksUri: `${tamaOrigin}/.well-known/jwks.json`,
      healthUrl: `${tamaOrigin}/`,
      providerPort: topology.provider_port,
      tamaPort: Number(values.get("PORT") ?? 4000),
      httpsPort: topology.https_port,
      proxyTargetPort,
      providerUpstream: `${providerService ?? "host.docker.internal"}:${topology.provider_port}`,
      tamaUpstream: `${serviceName}:${values.get("PORT") ?? 4000}`,
      certificateNames: topology.certificate_names,
      caddyImage: services[proxy].image ?? "",
      trustMechanism: topology.trust_mechanism,
      allowedOrigins,
      providerService,
    };
    plan.localHttps = localHttps;
    // Match generation output: local HTTPS exposes the service port here,
    // while the public endpoint and proxy port remain in their own fields.
    plan.port = localHttps.tamaPort;
  }
  if (providerService) {
    const selected = new Set<string>();
    function selectDependencies(name: string) {
      if (name === providerService || selected.has(name)) return;
      selected.add(name);
      for (const dependency of Object.keys(services[name]?.depends_on ?? {}))
        selectDependencies(dependency);
    }
    selectDependencies(serviceName);
    if (plan.runtime.proxyService) selectDependencies(plan.runtime.proxyService);
    plan.runtime.startServices = [...selected];
  }
  const loading = providerService
    ? {
        status: "verified" as const,
        mechanism: "compose-env-file" as const,
        evidencePath: relative(root, composeFiles[0]),
      }
    : verifyEnvironmentLoadingEvidence(
        root,
        contract.provider.environment_file,
        null,
        composeFiles[0],
      );
  const contractContent = readFileSync(contractPath, "utf8");
  plan.mcpApp = {
    provider: {
      name: contract.provider.name,
      environmentPrefix: contract.provider.environment_prefix,
      environmentFile: contract.provider.environment_file,
      source: "contract",
    },
    contractSource: contract.source.type === "provider-contract" ? "contract" : "conventional",
    contractPath: contract.source.provider_contract_path,
    bindings: {
      roles,
      source: contract.source.type === "provider-contract" ? "contract" : "conventional",
    },
    lifecycle: mode(values.get("TAMA_MCP_APP_MODE")),
    providerLifecycle: mode(effectiveProvider.get(roles.mode)),
    environmentLoading: loading.status,
    environmentLoadingMechanism: loading.mechanism,
    environmentLoadingEvidencePath: loading.evidencePath,
    localContract: contract,
    localContractOperation: {
      action: "unchanged",
      path: contractPath,
      owner: "user",
      sensitive: false,
      beforeDigest: contentDigest(contractContent),
      afterDigest: contentDigest(contractContent),
      reason: "current project-owned contract",
    },
    providerOrigin,
    tamaOrigin,
    resource,
    allowedOrigins,
    introspectionClientId: `${resource}/introspection`,
    providerSigningKeyId: providerKid,
    introspectionSigningKeyId: tamaKid,
    operations: [],
    localHttps: plan.localHttps,
    tamaEnvironment: values,
    providerEnvironment: effectiveProvider,
  };
  return plan;
}

/** Terraform diagnostics never initialize providers or write lock/state files. */
export function inspectTerraform(root: string, execute = execFileSync, selectedRoot = "tama") {
  const directory = resolve(root, selectedRoot);
  if (!existsSync(directory)) return { status: "missing" };
  if (!statSync(directory).isDirectory())
    return {
      status: "invalid",
      nextAction: "Select a Terraform directory as the selected root.",
    };
  try {
    execute("terraform", ["version", "-json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return { status: "tool-missing" };
  }
  if (!existsSync(join(directory, ".terraform")))
    return {
      status: "uninitialized",
      nextAction: "Run terraform init in the selected Terraform root when ready.",
    };
  try {
    const result = JSON.parse(
      execute("terraform", [`-chdir=${directory}`, "validate", "-json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return { status: result.valid ? "valid" : "invalid" };
  } catch {
    return {
      status: "invalid",
      nextAction:
        "Run terraform validate locally to inspect diagnostics; source excerpts are suppressed.",
    };
  }
}
