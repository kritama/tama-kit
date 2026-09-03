// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ownershipError, usageError } from "../errors.mjs";
import { MANAGED_MARKER } from "./constants.mjs";
import {
  PENDING_SECRET_VALUE,
  readEnvironmentValues,
  readRawEnvironmentLine,
} from "./environment.mjs";
import { readMcpAppProvider } from "./manifest.mjs";
import {
  contractLocalOrigin,
  discoverProviderContract,
  loadTamaContract,
  resolveBindings,
  unpinnedTamaImageTag,
  unsupportedTamaImage,
  validateEmittedMcpAppValues,
  verifyEnvironmentLoading,
} from "./mcp-app-contract.mjs";
import {
  generateOAuthKeyPair,
  validateOAuthPrivateJwk,
  validatePublicJwkSet,
} from "./oauth-key.mjs";
import {
  environmentFileForName,
  normalizeProviderName,
  prefixFromName,
  resolveProviderIdentity,
} from "./provider-identity.mjs";

/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").FileOperationOptions} FileOperationOptions */
/** @typedef {import("../types.mjs").Framework} Framework */
/** @typedef {import("../types.mjs").McpAppBootstrapOptions} McpAppBootstrapOptions */
/** @typedef {import("../types.mjs").McpAppEnvironmentInput} McpAppEnvironmentInput */
/** @typedef {import("../types.mjs").McpAppMode} McpAppMode */
/** @typedef {import("../types.mjs").McpAppPlan} McpAppPlan */
/** @typedef {import("../types.mjs").McpAppPrepared} McpAppPrepared */
/** @typedef {import("../types.mjs").PersistedMcpAppProvider} PersistedMcpAppProvider */
/** @typedef {import("../types.mjs").ProviderIdentity} ProviderIdentity */
/** @typedef {import("./oauth-key.mjs").OAuthKeyPair} OAuthKeyPair */

const TAMA_MCP_APP_JWKS_PATH = "/.well-known/jwks.json";
const TAMA_MCP_APP_INTROSPECTION_PATH = "/auth/introspections";
const TAMA_MCP_APP_RESOURCE_PATH = "/mcp/app";
const TAMA_INTROSPECTION_KEY_VARIABLE = "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY";
const TAMA_INTROSPECTION_KID_VARIABLE = "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID";
const TAMA_INTROSPECTION_PUBLIC_KEYS_VARIABLE = "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS";

/**
 * Normalizes a required provider origin: an http(s) URL without a path,
 * query, or fragment.
 *
 * @param {string | null | undefined} value
 * @param {string} flag
 * @returns {string}
 */
export function normalizeMcpAppOrigin(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(
      `a provider origin is required: pass ${flag} or declare it in the provider contract`,
    );
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`invalid provider origin ${flag}: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usageError(`provider origin ${flag} must be an http(s) URL: ${value}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw usageError(
      `provider origin ${flag} must not include a path, query, or fragment: ${value}`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Reports whether a URL hostname names a loopback address: localhost, the
 * full IPv4 127.0.0.0/8 range, the IPv6 loopback, and IPv4-mapped loopback
 * forms. Loopback is valid for client and Tama origins (both are reached from
 * the host) but never for the provider origin, which the Tama container must
 * also reach: from inside the container 127/8 is the container itself.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare === "localhost") {
    return true;
  }
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((part) => Number(part));
    return octets.every((octet) => octet <= 255) && octets[0] === 127;
  }
  const ipv6 = bare.toLowerCase();
  if (ipv6 === "::1") {
    return true;
  }
  const dottedMapped = ipv6.match(/^::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u);
  if (dottedMapped !== null) {
    return Number(dottedMapped[1]) === 127;
  }
  // WHATWG URLs render IPv4-mapped loopback addresses with hex groups
  // (127.0.0.1 becomes ::ffff:7f00:1), so the 32-bit suffix is decoded
  // instead of pattern-matched against a dotted form.
  const hexMapped = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hexMapped !== null) {
    const mappedAddress =
      (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
    return mappedAddress >>> 24 === 127;
  }
  return false;
}

/**
 * Reports whether a URL hostname names an unspecified address: 0.0.0.0 or ::
 * (including the dotted IPv4-mapped spelling). Like loopback, the host can
 * reach a locally bound provider through these names, but from inside the
 * Tama container they name the container's own interface, so the same origin
 * is never a working provider address.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isUnspecifiedHostname(hostname) {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare === "0.0.0.0" || bare === "::") {
    return true;
  }
  // WHATWG URLs canonicalize the dotted mapped form to hex groups
  // (::ffff:0.0.0.0 becomes ::ffff:0:0), so the 32-bit suffix is decoded
  // instead of pattern-matched against the dotted spelling.
  const hexMapped = bare.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hexMapped === null) {
    return false;
  }
  const mappedAddress =
    (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
  return mappedAddress === 0;
}

/**
 * Normalizes an optional allowed origin the same way required origins are,
 * reporting the repeating flag in diagnostics.
 *
 * @param {string} value
 * @returns {string}
 */
function allowedOrigin(value) {
  const origin = normalizeMcpAppOrigin(value, "--allowed-origin");
  const url = new URL(origin);
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw usageError(`--allowed-origin must use https unless it is loopback: ${value}`);
  }
  return origin;
}

/** @param {Record<string, unknown> | null} document @param {string} name */
function namedLocalOrigin(document, name) {
  const local = document?.local_development;
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (local)[name];
  return typeof value === "string" ? value : null;
}

/** @param {string} origin @param {number} port @param {string} flag */
function originForPort(origin, port, flag) {
  const normalized = normalizeMcpAppOrigin(origin, flag);
  const url = new URL(normalized);
  const effectivePort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (effectivePort !== port) {
    throw usageError(`${flag} must use the selected Tama port ${port}: ${origin}`);
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw usageError(`${flag} must use https unless it is loopback: ${origin}`);
  }
  return normalized;
}

/**
 * Reads the Tama origin the persisted `.tama.env` MCP App resource advertises,
 * or null when no MCP App state is persisted there.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function persistedTamaOrigin(root) {
  const resource = readEnvironmentValues(root, ".tama.env").get("TAMA_MCP_APP_RESOURCE");
  if (!resource) {
    return null;
  }
  let url;
  try {
    url = new URL(resource);
  } catch {
    throw ownershipError(".tama.env has an invalid TAMA_MCP_APP_RESOURCE", {
      path: join(root, ".tama.env"),
      variable: "TAMA_MCP_APP_RESOURCE",
    });
  }
  if (url.pathname !== TAMA_MCP_APP_RESOURCE_PATH || url.search !== "" || url.hash !== "") {
    throw ownershipError(".tama.env has an invalid TAMA_MCP_APP_RESOURCE", {
      path: join(root, ".tama.env"),
      variable: "TAMA_MCP_APP_RESOURCE",
    });
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Updates only Tama Kit's semantic provider bindings while preserving
 * application-owned comments and unrelated environment entries.
 *
 * @param {string | null} original
 * @param {Map<string, string>} updates Complete rendered dotenv lines keyed by variable name.
 */
function providerFragmentContent(original, updates) {
  if (original === null) {
    return [
      `# ${MANAGED_MARKER}. Keep this file private and do not commit it.`,
      "",
      "# MCP App provider integration. Managed by Tama Kit for local development.",
      ...updates.values(),
      "",
    ].join("\n");
  }
  const remaining = new Map(updates);
  const lines = original.split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/u);
    if (!match || !remaining.has(match[1])) {
      return line;
    }
    const replacement = remaining.get(match[1]);
    remaining.delete(match[1]);
    return replacement ?? line;
  });
  while (lines.at(-1) === "") {
    lines.pop();
  }
  if (remaining.size > 0) {
    lines.push("", ...remaining.values());
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string} content @param {Iterable<string>} variables */
function withoutEnvironmentVariables(content, variables) {
  const removed = new Set(variables);
  return content
    .split(/\r?\n/u)
    .filter((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=/u);
      return !match || !removed.has(match[1]);
    })
    .join("\n");
}

/**
 * @typedef {object} PrepareMcpAppInput
 * @property {string} root
 * @property {string} tamaDirectory
 * @property {Framework} framework
 * @property {McpAppBootstrapOptions} options
 * @property {boolean} nonInteractive
 * @property {CommandIO} io
 */

/**
 * Resolves the persisted provider state, the provider contract, and the
 * accepted provider identity before any plan exists. Detected identities
 * (framework metadata, Git remote, or directory name) are interactively
 * confirmed; a non-interactive run fails on ambiguity instead of guessing.
 *
 * @param {PrepareMcpAppInput} input
 * @returns {Promise<McpAppPrepared>}
 */
export async function prepareMcpApp({
  root,
  tamaDirectory,
  framework,
  options,
  nonInteractive,
  io,
}) {
  const persisted = readMcpAppProvider(tamaDirectory);
  const contract = discoverProviderContract(root, options.contractPath);
  let identity = resolveProviderIdentity({
    root,
    framework,
    manifestProvider: options.migrateProviderIdentity ? null : (persisted?.identity ?? null),
    contractDocument: contract.document,
    name: options.providerName,
    prefix: options.providerPrefix,
    environmentFile: options.providerEnvironmentFile,
    identitySource: options.identitySource,
  });

  if (options.migrateProviderIdentity) {
    if (!persisted) {
      throw usageError("--migrate-provider-identity requires an existing managed MCP App provider");
    }
    const requestedName = normalizeProviderName(options.providerName);
    if (identity.name !== requestedName) {
      throw usageError(
        `the provider contract resolves identity ${identity.name}, which conflicts with the requested migration to ${requestedName}; update the contract identity first`,
      );
    }
    if (
      identity.name === persisted.identity.name &&
      identity.environmentPrefix === persisted.identity.environmentPrefix &&
      identity.environmentFile === persisted.identity.environmentFile
    ) {
      throw usageError("the requested provider identity is already persisted; nothing to migrate");
    }
  }

  if (
    identity.source === "framework" ||
    identity.source === "git" ||
    identity.source === "directory"
  ) {
    if (nonInteractive || typeof io.prompt !== "function") {
      throw usageError(
        `the provider name was detected as "${identity.name}" but is not explicit; ` +
          `pass --provider-name ${identity.name} to confirm it ` +
          `(add --provider-prefix and --provider-env-file to override the derived values)`,
      );
    }
    while (true) {
      const answer = (
        await io.prompt(
          `Use detected provider name "${identity.name}"? ` +
            `(environment prefix ${identity.environmentPrefix}, file ${identity.environmentFile}) [Y/n] `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        break;
      }
      if (answer === "n" || answer === "no") {
        const custom = normalizeProviderName((await io.prompt("Enter the provider name: ")).trim());
        identity = {
          name: custom,
          environmentPrefix: prefixFromName(custom),
          environmentFile: environmentFileForName(custom),
          source: "flags",
        };
        break;
      }
      io.stderr("Please answer yes or no.");
    }
  }

  /** @type {string[]} */
  const allowedOrigins = [];
  for (const value of options.allowedOrigins ?? persisted?.allowedOrigins ?? []) {
    const origin = allowedOrigin(value);
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  }
  if (allowedOrigins.length > 32) {
    throw usageError("--allowed-origin may be supplied at most 32 unique times");
  }
  if (allowedOrigins.length === 0) {
    if (nonInteractive || typeof io.prompt !== "function") {
      throw usageError(
        "at least one explicit --allowed-origin is required for MCP App preparation",
      );
    }
    const entered = (await io.prompt("Enter an allowed browser/MCP client origin: ")).trim();
    if (entered === "") {
      throw usageError("an allowed browser/MCP client origin is required");
    }
    allowedOrigins.push(allowedOrigin(entered));
  }

  return {
    identity,
    persisted,
    contractPath: contract.path,
    contractDocument: contract.document,
    allowedOrigins,
  };
}

/**
 * @typedef {object} ResolveMcpAppStateInput
 * @property {string} root
 * @property {ProviderIdentity} identity
 * @property {string | null} contractPath
 * @property {Record<string, unknown> | null} contractDocument
 */

/**
 * Resolves the provider state Tama Kit will manage: the role bindings, the
 * contract source, and whether the application-owned loader can be verified.
 *
 * @param {ResolveMcpAppStateInput} input
 * @returns {PersistedMcpAppProvider}
 */
export function resolveMcpAppState({ root, identity, contractPath, contractDocument }) {
  return {
    identity,
    contractSource: contractPath === null ? "conventional" : "contract",
    contractPath,
    bindings: resolveBindings(contractDocument, identity.environmentPrefix).roles,
    environmentLoading: verifyEnvironmentLoading(root, identity.environmentFile, contractDocument),
  };
}

/**
 * @typedef {object} PlanMcpAppInput
 * @property {string} root
 * @property {McpAppBootstrapOptions} options
 * @property {ProviderIdentity} identity
 * @property {PersistedMcpAppProvider} state Resolved state to persist and plan from.
 * @property {PersistedMcpAppProvider | null} persisted Previously persisted manifest state.
 * @property {Record<string, unknown> | null} contractDocument Provider contract document,
 *   or null when conventional bindings are used.
 * @property {number} port Public Tama port the environment file will carry.
 * @property {string} tamaImage Tama image reference planned for Compose.
 * @property {(filename: string, content: string, options?: FileOperationOptions) => FileOperation} manageFile
 * @property {(filename: string, options?: FileOperationOptions) => FileOperation} [removeManagedFile]
 * @property {(kidPrefix: string) => OAuthKeyPair} [generateKeyPair] Injectable key
 *   generation for deterministic tests.
 * @property {boolean} [materializeKeys]
 */

/**
 * @typedef {object} PlanMcpAppResult
 * @property {McpAppPlan} plan
 * @property {McpAppEnvironmentInput} environmentInput
 */

/**
 * Plans the MCP App provider integration: the provider-owned fragment with
 * its preserved or generated access-token key pair, the Tama-side variables
 * for `.tama.env` with its preserved or generated introspection key pair, and
 * the origins every side needs to reach the other.
 *
 * @param {PlanMcpAppInput} input
 * @returns {PlanMcpAppResult}
 */
export function planMcpApp(input) {
  const { root, options, identity, state, persisted, port, tamaImage, manageFile } = input;
  const migratingIdentity = options.migrateProviderIdentity === true;
  const generate = input.generateKeyPair ?? generateOAuthKeyPair;
  const materializeKeys = input.materializeKeys ?? true;
  const roles = state.bindings;

  if (migratingIdentity && !persisted) {
    throw usageError("provider identity migration requires persisted MCP App state");
  }

  const tamaContract = loadTamaContract();
  const unsupported = unsupportedTamaImage(tamaImage, tamaContract.supported_tama_versions);
  if (unsupported) {
    throw usageError(`${unsupported}; the MCP App integration requires a supported Tama image`);
  }
  const providerSupportedTamaVersions = input.contractDocument?.supported_tama_versions;
  const providerUnsupported = unsupportedTamaImage(tamaImage, providerSupportedTamaVersions);
  if (providerUnsupported) {
    throw usageError(
      `${providerUnsupported}; the accepted provider contract requires a supported Tama image`,
    );
  }
  // A floating tag such as :latest can move outside the supported range at
  // any time, and the integration writes secrets before the runtime starts,
  // so the Tama image must be pinned to a checkable version.
  const unpinnedTag = unpinnedTamaImageTag(tamaImage);
  if (unpinnedTag !== null) {
    throw usageError(
      `the MCP App integration requires a pinned Tama image, but ${tamaImage} uses the ` +
        `unresolvable tag ${unpinnedTag}; pass --image with a version inside the supported ` +
        `Tama range ${tamaContract.supported_tama_versions}`,
    );
  }

  if (persisted) {
    const identityFields = /** @type {(keyof ProviderIdentity)[]} */ ([
      "name",
      "environmentPrefix",
      "environmentFile",
    ]);
    const mismatched = identityFields.filter(
      (field) => persisted.identity[field] !== identity[field],
    );
    if (mismatched.length > 0 && !migratingIdentity) {
      throw ownershipError(
        `the Tama Kit manifest MCP App provider identity (${persisted.identity.name}) ` +
          `does not match the resolved identity (${identity.name}) for ${identity.environmentFile}; ` +
          `pass --provider-* flags matching the manifest or restore .tama/.tama-kit.json`,
        { variables: mismatched },
      );
    }
    const drifted = Object.entries(roles)
      .filter(([role, variable]) => persisted.bindings[role] !== variable)
      .map(([role]) => role);
    const unexpected = Object.keys(persisted.bindings).filter((role) => roles[role] === undefined);
    if (!migratingIdentity && (drifted.length > 0 || unexpected.length > 0)) {
      throw usageError(
        `the provider MCP App contract bindings changed since the last bootstrap ` +
          `(${[...drifted, ...unexpected].join(", ")}); the fragment variable names on disk ` +
          `no longer match the contract. Restore the previous contract or reset the MCP App ` +
          `provider state in .tama/.tama-kit.json and remove ${identity.environmentFile}`,
      );
    }
    if (migratingIdentity && state.environmentLoading !== "verified") {
      throw usageError(
        `the provider loader must load ${identity.environmentFile} before identity migration`,
      );
    }
  }

  const providerOrigin = normalizeMcpAppOrigin(
    options.providerOrigin ??
      contractLocalOrigin(input.contractDocument, identity.name) ??
      contractLocalOrigin(tamaContract, identity.name) ??
      null,
    "--provider-origin",
  );
  // Every verification probe is issued from the host, so a loopback or
  // unspecified provider origin would pass them while the Tama container can
  // never reach the host-native provider: from the inside, both address
  // spaces name the container itself. Reject before any state is persisted.
  const providerUrl = new URL(providerOrigin);
  const unreachableKind = isLoopbackHostname(providerUrl.hostname)
    ? "loopback"
    : isUnspecifiedHostname(providerUrl.hostname)
      ? "an unspecified address (0.0.0.0 or ::)"
      : null;
  if (unreachableKind !== null) {
    throw usageError(
      `the provider origin ${providerOrigin} is ${unreachableKind} and cannot be reached from ` +
        `the Tama container; pass --provider-origin with a container-reachable origin such as ` +
        `http://host.docker.internal:${providerUrl.port || "80"} ` +
        `(Tama Kit adds the Compose host-gateway mapping for host.docker.internal)`,
    );
  }
  const providerHostPort =
    providerUrl.port === ""
      ? providerUrl.protocol === "https:"
        ? 443
        : 80
      : Number(providerUrl.port);
  // An https container-gateway origin cannot be verified from the host: the
  // name resolves only inside the Tama container, and the host-side TLS
  // probes would validate the certificate against the loopback transport
  // instead of the name it was issued for.
  if (providerUrl.protocol === "https:" && providerUrl.hostname === "host.docker.internal") {
    throw usageError(
      `the provider origin ${providerOrigin} cannot be verified from the host: host.docker.internal ` +
        `resolves only inside the Tama container, so the host-side TLS probes would validate the ` +
        `certificate against a loopback transport instead of that name. Pass --provider-origin with ` +
        `http://host.docker.internal:${providerUrl.port || "80"} (the documented container-gateway ` +
        `topology) or with a host-resolvable https origin`,
    );
  }
  if (providerUrl.hostname === "host.docker.internal" && providerHostPort === port) {
    throw usageError(
      `the selected Tama port ${port} collides with the provider origin ${providerOrigin}; ` +
        `the host-native provider already listens on host port ${providerHostPort}. ` +
        `Pass --port to select a different Tama port`,
    );
  }
  const existingTamaOrigin = persistedTamaOrigin(root);
  const defaultTamaOrigin =
    namedLocalOrigin(input.contractDocument, "tama_origin") ??
    namedLocalOrigin(tamaContract, "tama_origin") ??
    `http://127.0.0.1:${port}`;
  const requestedTamaOrigin = options.tamaOrigin ?? existingTamaOrigin;
  let tamaOrigin;
  if (requestedTamaOrigin) {
    tamaOrigin = originForPort(requestedTamaOrigin, port, "--tama-origin");
  } else {
    const defaultUrl = new URL(normalizeMcpAppOrigin(defaultTamaOrigin, "Tama contract origin"));
    defaultUrl.port = String(port);
    tamaOrigin = originForPort(
      `${defaultUrl.protocol}//${defaultUrl.host}`,
      port,
      "Tama contract origin",
    );
  }
  if (existingTamaOrigin && options.tamaOrigin && tamaOrigin !== existingTamaOrigin) {
    throw ownershipError(
      `.tama.env already persists the MCP App Tama origin ${existingTamaOrigin}; explicit origin migration is required before changing it to ${tamaOrigin}`,
      { path: join(root, ".tama.env"), variable: "TAMA_MCP_APP_RESOURCE" },
    );
  }
  const resource = `${tamaOrigin}${TAMA_MCP_APP_RESOURCE_PATH}`;
  const introspectionClientId = `${resource}/introspection`;

  /** @type {string[]} */
  const allowedOrigins = [];
  for (const value of options.allowedOrigins ?? []) {
    const origin = allowedOrigin(value);
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  }
  if (allowedOrigins.length === 0) {
    throw usageError("at least one explicit --allowed-origin is required for MCP App preparation");
  }
  if (allowedOrigins.length > 32) {
    throw usageError("--allowed-origin may be supplied at most 32 unique times");
  }

  if (persisted?.providerOrigin && persisted.providerOrigin !== providerOrigin) {
    throw ownershipError(
      `the persisted MCP App provider origin ${persisted.providerOrigin} does not match ${providerOrigin}; explicit topology migration is required`,
      { providerOrigin: persisted.providerOrigin, requestedProviderOrigin: providerOrigin },
    );
  }
  if (persisted?.tamaOrigin && persisted.tamaOrigin !== tamaOrigin) {
    throw ownershipError(
      `the persisted MCP App Tama origin ${persisted.tamaOrigin} does not match ${tamaOrigin}; explicit topology migration is required`,
      { tamaOrigin: persisted.tamaOrigin, requestedTamaOrigin: tamaOrigin },
    );
  }
  if (
    persisted?.allowedOrigins &&
    (persisted.allowedOrigins.length !== allowedOrigins.length ||
      persisted.allowedOrigins.some((origin, index) => origin !== allowedOrigins[index]))
  ) {
    throw ownershipError(
      "the explicit MCP App allowed origins do not match the persisted topology; explicit topology migration is required",
      { allowedOrigins: persisted.allowedOrigins, requestedAllowedOrigins: allowedOrigins },
    );
  }
  state.providerOrigin = providerOrigin;
  state.tamaOrigin = tamaOrigin;
  state.allowedOrigins = [...allowedOrigins];

  const sourceIdentity = migratingIdentity
    ? /** @type {PersistedMcpAppProvider} */ (persisted).identity
    : identity;
  const sourceRoles = migratingIdentity
    ? /** @type {PersistedMcpAppProvider} */ (persisted).bindings
    : roles;
  const sourceFragmentPath = join(root, sourceIdentity.environmentFile);
  const fragmentPath = join(root, identity.environmentFile);
  const fragmentValues = readEnvironmentValues(root, sourceIdentity.environmentFile);
  const mode = /** @type {McpAppMode} */ (
    options.targetMode ?? (options.activate ? "enabled" : "prepared")
  );
  const existingProviderMode = fragmentValues.get(sourceRoles.mode);
  if (migratingIdentity && existingProviderMode !== "prepared") {
    throw usageError(
      `provider identity migration requires ${sourceRoles.mode}=prepared in ${sourceIdentity.environmentFile}`,
    );
  }
  const providerMode = /** @type {McpAppMode} */ (
    options.providerMode ??
      (options.preserveEnabledProvider && existingProviderMode === "enabled" ? "enabled" : mode)
  );
  const sourceFragmentKeyVariable = sourceRoles.access_token_private_signing_key;
  const sourceFragmentKidVariable = sourceRoles.access_token_signing_key_id;
  const existingFragmentKey = fragmentValues.get(sourceFragmentKeyVariable);
  const existingFragmentKid = fragmentValues.get(sourceFragmentKidVariable);
  let providerSigningKeyId;
  let providerPrivateJwk;
  if (existingFragmentKey || existingFragmentKid) {
    if (!existingFragmentKey || !existingFragmentKid) {
      throw ownershipError(
        `${sourceIdentity.environmentFile} must define ${sourceFragmentKeyVariable} and ${sourceFragmentKidVariable} together`,
        {
          path: sourceFragmentPath,
          variables: [sourceFragmentKeyVariable, sourceFragmentKidVariable],
        },
      );
    }
    validateOAuthPrivateJwk(
      existingFragmentKey,
      existingFragmentKid,
      sourceFragmentKeyVariable,
      sourceFragmentKidVariable,
    );
    providerSigningKeyId = existingFragmentKid;
    providerPrivateJwk = existingFragmentKey;
  } else {
    if (materializeKeys) {
      const generated = generate("mcp-app-provider");
      providerSigningKeyId = generated.kid;
      providerPrivateJwk = generated.privateJwk;
    } else {
      providerSigningKeyId = "mcp-app-provider-pending";
      providerPrivateJwk = PENDING_SECRET_VALUE;
    }
  }

  const tamaValues = readEnvironmentValues(root, ".tama.env");
  const existingTamaKey = tamaValues.get(TAMA_INTROSPECTION_KEY_VARIABLE);
  const existingTamaKid = tamaValues.get(TAMA_INTROSPECTION_KID_VARIABLE);
  let introspectionSigningKeyId;
  let introspectionPrivateJwk;
  if (existingTamaKey || existingTamaKid) {
    if (!existingTamaKey || !existingTamaKid) {
      throw ownershipError(
        `.tama.env must define ${TAMA_INTROSPECTION_KEY_VARIABLE} and ${TAMA_INTROSPECTION_KID_VARIABLE} together`,
        {
          path: join(root, ".tama.env"),
          variables: [TAMA_INTROSPECTION_KEY_VARIABLE, TAMA_INTROSPECTION_KID_VARIABLE],
        },
      );
    }
    validateOAuthPrivateJwk(
      existingTamaKey,
      existingTamaKid,
      TAMA_INTROSPECTION_KEY_VARIABLE,
      TAMA_INTROSPECTION_KID_VARIABLE,
    );
    introspectionSigningKeyId = existingTamaKid;
    introspectionPrivateJwk = existingTamaKey;
  } else {
    if (materializeKeys) {
      const generated = generate("mcp-app-tama");
      introspectionSigningKeyId = generated.kid;
      introspectionPrivateJwk = generated.privateJwk;
    } else {
      introspectionSigningKeyId = "mcp-app-tama-pending";
      introspectionPrivateJwk = PENDING_SECRET_VALUE;
    }
  }

  // The provider overlap set holds rotation keys in addition to the current
  // key, which the runtime publishes on its own. A fresh set starts empty; a
  // persisted set is validated and re-emitted byte-for-byte so rotation state
  // survives bootstrap reruns.
  const fragmentOverlapVariable = roles.access_token_public_overlap_keys;
  const sourceFragmentOverlapVariable = sourceRoles.access_token_public_overlap_keys;
  const existingFragmentOverlap = fragmentValues.get(sourceFragmentOverlapVariable);
  let fragmentOverlapLine;
  let fragmentOverlapValue = "[]";
  if (existingFragmentOverlap === undefined) {
    fragmentOverlapLine = `${fragmentOverlapVariable}='[]'`;
  } else {
    fragmentOverlapValue = existingFragmentOverlap;
    validatePublicJwkSet(existingFragmentOverlap, sourceFragmentOverlapVariable);
    const rawOverlapLine = readRawEnvironmentLine(
      root,
      sourceIdentity.environmentFile,
      sourceFragmentOverlapVariable,
    );
    if (rawOverlapLine === null) {
      throw ownershipError(
        `${sourceIdentity.environmentFile} has an unreadable ${sourceFragmentOverlapVariable} line`,
        { path: sourceFragmentPath, variables: [sourceFragmentOverlapVariable] },
      );
    }
    fragmentOverlapLine =
      sourceFragmentOverlapVariable === fragmentOverlapVariable
        ? rawOverlapLine
        : `${fragmentOverlapVariable}='${existingFragmentOverlap}'`;
  }

  // The accepted contract is the provider's word for what the fragment may
  // contain: hold every planned value to its declared value-specific
  // constraints before any file is written.
  validateEmittedMcpAppValues(input.contractDocument, roles, {
    [roles.mode]: providerMode,
    [roles.issuer]: providerOrigin,
    [roles.resource]: resource,
    [roles.access_token_signing_algorithm]: "RS256",
    [roles.access_token_signing_key_id]: providerSigningKeyId,
    [roles.access_token_private_signing_key]: providerPrivateJwk,
    [fragmentOverlapVariable]: fragmentOverlapValue,
    [roles.introspection_client_id]: introspectionClientId,
    [roles.introspection_jwks_uri]: `${tamaOrigin}${TAMA_MCP_APP_JWKS_PATH}`,
  });

  const sourceContent = existsSync(sourceFragmentPath)
    ? readFileSync(sourceFragmentPath, "utf8")
    : null;
  const fragmentBase =
    migratingIdentity && sourceContent !== null
      ? withoutEnvironmentVariables(sourceContent, Object.values(sourceRoles))
      : sourceContent;
  const fragmentContent = providerFragmentContent(
    fragmentBase,
    new Map([
      [roles.mode, `${roles.mode}=${providerMode}`],
      [roles.issuer, `${roles.issuer}=${providerOrigin}`],
      [roles.resource, `${roles.resource}=${resource}`],
      [roles.access_token_signing_algorithm, `${roles.access_token_signing_algorithm}=RS256`],
      [
        roles.access_token_signing_key_id,
        `${roles.access_token_signing_key_id}=${providerSigningKeyId}`,
      ],
      [
        roles.access_token_private_signing_key,
        `${roles.access_token_private_signing_key}='${providerPrivateJwk}'`,
      ],
      [fragmentOverlapVariable, fragmentOverlapLine],
      [roles.introspection_client_id, `${roles.introspection_client_id}=${introspectionClientId}`],
      [
        roles.introspection_jwks_uri,
        `${roles.introspection_jwks_uri}=${tamaOrigin}${TAMA_MCP_APP_JWKS_PATH}`,
      ],
    ]),
  );
  const fragmentOperation = manageFile(fragmentPath, fragmentContent, {
    sensitive: true,
    mode: 0o600,
  });
  const migratedFragmentOperation =
    migratingIdentity && sourceFragmentPath !== fragmentPath
      ? input.removeManagedFile?.(sourceFragmentPath, { sensitive: true, mode: 0o600 })
      : null;
  if (migratingIdentity && sourceFragmentPath !== fragmentPath && !migratedFragmentOperation) {
    throw usageError("internal error: provider identity migration cannot remove the old fragment");
  }

  // The Tama overlap set is rotation state owned by the persisted file: a
  // fresh file starts empty, a persisted set is validated, and a valid set is
  // left untouched by the environment update so it survives byte-for-byte.
  const existingTamaPublicKeys = tamaValues.get(TAMA_INTROSPECTION_PUBLIC_KEYS_VARIABLE);
  if (existingTamaPublicKeys !== undefined) {
    validatePublicJwkSet(existingTamaPublicKeys, TAMA_INTROSPECTION_PUBLIC_KEYS_VARIABLE);
  }

  /** @type {Record<string, string>} */
  const variables = {
    TAMA_MCP_APP_MODE: mode,
    TAMA_MCP_APP_RESOURCE: resource,
    TAMA_MCP_APP_ALLOWED_ORIGINS: allowedOrigins.join(","),
    TAMA_MCP_APP_AUTHORIZATION_SERVER: providerOrigin,
    TAMA_MCP_APP_JWKS_URI: `${providerOrigin}${TAMA_MCP_APP_JWKS_PATH}`,
    TAMA_MCP_APP_INTROSPECTION_ENDPOINT: `${providerOrigin}${TAMA_MCP_APP_INTROSPECTION_PATH}`,
    TAMA_MCP_APP_SIGNING_ALGORITHMS: "RS256",
    TAMA_MCP_APP_INTROSPECTION_CLIENT_ID: introspectionClientId,
    TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM: "RS256",
    TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID: introspectionSigningKeyId,
    TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY: `'${introspectionPrivateJwk}'`,
    ...(existingTamaPublicKeys === undefined
      ? { [TAMA_INTROSPECTION_PUBLIC_KEYS_VARIABLE]: "[]" }
      : {}),
  };

  /** @type {McpAppPlan} */
  const plan = {
    provider: identity,
    contractSource: state.contractSource,
    contractPath: state.contractPath,
    bindings: { roles, source: state.contractSource },
    lifecycle: mode,
    providerLifecycle: providerMode,
    environmentLoading: state.environmentLoading,
    providerOrigin,
    tamaOrigin,
    resource,
    allowedOrigins,
    introspectionClientId,
    providerSigningKeyId,
    introspectionSigningKeyId,
    operations: [
      fragmentOperation,
      ...(migratedFragmentOperation ? [migratedFragmentOperation] : []),
    ],
  };

  return {
    plan,
    environmentInput: {
      variables,
      validation: {
        mode,
        resource,
        authorizationServerOrigin: providerOrigin,
        serviceOrigin: providerOrigin,
        allowedOrigins,
        introspectionClientId,
      },
    },
  };
}
