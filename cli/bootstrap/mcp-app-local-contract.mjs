// @ts-check

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { usageError } from "../errors.mjs";
import { contentDigest } from "./files.mjs";
import {
  assertUnreservedFragmentPath,
  MCP_APP_COMPATIBILITY_IDENTIFIER,
  MCP_APP_LIFECYCLE_MODES,
  MCP_APP_PROVIDER_PUBLIC_ENDPOINTS,
  MCP_APP_ROLES,
  safeRelativePath,
  validateMcpAppContract,
} from "./mcp-app-contract.mjs";

export const MCP_APP_LOCAL_CONTRACT_KIND = "tama-kit-mcp-app-local-provider-contract";
export const MCP_APP_LOCAL_CONTRACT_PATH = "tama/contracts/mcp-app-provider-v1.json";

const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "compatibility_identifier",
  "scope",
  "source",
  "provider",
  "lifecycle",
  "bindings",
  "public_endpoints",
  "environment_loading",
]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ENDPOINT_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_PROVIDER_CONTRACT_BYTES = 256 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  const missing = keys.filter((key) => !(key in value));
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw usageError(
      `local MCP App contract ${label} has invalid keys` +
        `${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}` +
        `${unexpected.length > 0 ? `; unsupported ${unexpected.join(", ")}` : ""}`,
    );
  }
}

/** @param {unknown} value @param {string} label @returns {string} */
function nonEmptyString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw usageError(`local MCP App contract ${label} must be a non-empty control-free string`);
  }
  return value;
}

/** @param {string} root @param {string} path */
function portableSourcePath(root, path) {
  const local = relative(root, path);
  if (local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) {
    return local.split(sep).join("/");
  }
  return path;
}

/** @param {string | null} path @param {Record<string, unknown> | null} expectedDocument */
function providerContractDigest(path, expectedDocument) {
  if (path === null || !existsSync(path)) {
    return null;
  }
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_PROVIDER_CONTRACT_BYTES
  ) {
    return null;
  }
  const content = readFileSync(path, "utf8");
  let currentDocument;
  try {
    currentDocument = validateMcpAppContract(JSON.parse(content));
  } catch {
    throw usageError(`provider MCP App contract changed while planning: ${path}`);
  }
  if (JSON.stringify(currentDocument) !== JSON.stringify(expectedDocument)) {
    throw usageError(`provider MCP App contract changed while planning: ${path}`);
  }
  return contentDigest(content);
}

/**
 * Validates Tama Kit's normalized, non-secret local provider contract.
 *
 * @param {unknown} document
 * @returns {import("../types.mjs").McpAppLocalContract}
 */
export function validateMcpAppLocalContract(document) {
  if (!isPlainObject(document)) {
    throw usageError("local MCP App contract must be a JSON object");
  }
  exactKeys(document, TOP_LEVEL_KEYS, "document");
  if (document.schema_version !== "1") {
    throw usageError(
      `unsupported local MCP App contract schema_version: ${String(document.schema_version)}`,
    );
  }
  if (document.kind !== MCP_APP_LOCAL_CONTRACT_KIND) {
    throw usageError(`unsupported local MCP App contract kind: ${String(document.kind)}`);
  }
  if (document.compatibility_identifier !== MCP_APP_COMPATIBILITY_IDENTIFIER) {
    throw usageError(
      `unsupported local MCP App contract compatibility_identifier: ${String(document.compatibility_identifier)}`,
    );
  }
  if (document.scope !== "local-development") {
    throw usageError("local MCP App contract scope must be local-development");
  }

  if (!isPlainObject(document.source)) {
    throw usageError("local MCP App contract source must be an object");
  }
  exactKeys(
    document.source,
    ["type", "provider_contract_path", "provider_contract_digest"],
    "source",
  );
  const sourceType = document.source.type;
  const sourcePath = document.source.provider_contract_path;
  const sourceDigest = document.source.provider_contract_digest;
  if (sourceType === "generated") {
    if (sourcePath !== null || sourceDigest !== null) {
      throw usageError("generated local MCP App contract source path and digest must be null");
    }
  } else if (sourceType === "provider-contract") {
    nonEmptyString(sourcePath, "source.provider_contract_path");
    if (typeof sourceDigest !== "string" || !DIGEST_PATTERN.test(sourceDigest)) {
      throw usageError("local MCP App contract source.provider_contract_digest is invalid");
    }
  } else {
    throw usageError("local MCP App contract source.type must be generated or provider-contract");
  }

  if (!isPlainObject(document.provider)) {
    throw usageError("local MCP App contract provider must be an object");
  }
  exactKeys(document.provider, ["name", "environment_prefix", "environment_file"], "provider");
  if (
    typeof document.provider.name !== "string" ||
    !PROVIDER_NAME_PATTERN.test(document.provider.name)
  ) {
    throw usageError("local MCP App contract provider.name is invalid");
  }
  if (
    typeof document.provider.environment_prefix !== "string" ||
    !ENVIRONMENT_NAME_PATTERN.test(document.provider.environment_prefix)
  ) {
    throw usageError("local MCP App contract provider.environment_prefix is invalid");
  }
  const environmentFile = safeRelativePath(
    document.provider.environment_file,
    "local MCP App contract provider.environment_file",
  );
  assertUnreservedFragmentPath(environmentFile, "local MCP App contract provider.environment_file");

  if (!isPlainObject(document.lifecycle)) {
    throw usageError("local MCP App contract lifecycle must be an object");
  }
  const lifecycle = document.lifecycle;
  exactKeys(lifecycle, ["modes"], "lifecycle");
  const modes = lifecycle.modes;
  if (
    !Array.isArray(modes) ||
    modes.length !== MCP_APP_LIFECYCLE_MODES.length ||
    MCP_APP_LIFECYCLE_MODES.some((mode, index) => modes[index] !== mode)
  ) {
    throw usageError("local MCP App contract lifecycle.modes must be disabled, prepared, enabled");
  }

  if (!isPlainObject(document.bindings)) {
    throw usageError("local MCP App contract bindings must be an object");
  }
  exactKeys(document.bindings, MCP_APP_ROLES, "bindings");
  const variables = new Set();
  for (const role of MCP_APP_ROLES) {
    const variable = document.bindings[role];
    if (typeof variable !== "string" || !ENVIRONMENT_NAME_PATTERN.test(variable)) {
      throw usageError(`local MCP App contract bindings.${role} is invalid`);
    }
    if (variables.has(variable)) {
      throw usageError(`local MCP App contract bindings.${role} duplicates ${variable}`);
    }
    variables.add(variable);
  }

  if (!isPlainObject(document.public_endpoints)) {
    throw usageError("local MCP App contract public_endpoints must be an object");
  }
  exactKeys(
    document.public_endpoints,
    Object.keys(MCP_APP_PROVIDER_PUBLIC_ENDPOINTS),
    "public_endpoints",
  );
  const supportedEndpoints = /** @type {Record<string, string>} */ (
    MCP_APP_PROVIDER_PUBLIC_ENDPOINTS
  );
  for (const [name, value] of Object.entries(document.public_endpoints)) {
    if (typeof value !== "string" || !ENDPOINT_PATH_PATTERN.test(value)) {
      throw usageError(`local MCP App contract public_endpoints.${name} is invalid`);
    }
    if (supportedEndpoints[name] !== value) {
      throw usageError(
        `local MCP App contract public_endpoints.${name} must be ${supportedEndpoints[name]}`,
      );
    }
  }

  if (!isPlainObject(document.environment_loading)) {
    throw usageError("local MCP App contract environment_loading must be an object");
  }
  exactKeys(
    document.environment_loading,
    ["status", "mechanism", "evidence_path"],
    "environment_loading",
  );
  const loading = document.environment_loading;
  if (loading.status === "unverified") {
    if (loading.mechanism !== null || loading.evidence_path !== null) {
      throw usageError("unverified local MCP App environment loading cannot claim evidence");
    }
  } else if (loading.status === "verified") {
    if (loading.mechanism !== "direnv" && loading.mechanism !== "compose-env-file") {
      throw usageError("verified local MCP App environment loading mechanism is invalid");
    }
    nonEmptyString(loading.evidence_path, "environment_loading.evidence_path");
  } else {
    throw usageError("local MCP App contract environment_loading.status is invalid");
  }

  return /** @type {import("../types.mjs").McpAppLocalContract} */ (document);
}

/**
 * @param {{
 *   root: string,
 *   identity: import("../types.mjs").ProviderIdentity,
 *   bindings: Record<string, string>,
 *   providerContractPath: string | null,
 *   providerContractDocument: Record<string, unknown> | null,
 *   environmentLoading: import("../types.mjs").EnvironmentLoadingEvidence,
 * }} input
 */
export function renderMcpAppLocalContract(input) {
  const declaredEndpoints = input.providerContractDocument?.public_endpoints;
  const publicEndpoints = isPlainObject(declaredEndpoints)
    ? declaredEndpoints
    : MCP_APP_PROVIDER_PUBLIC_ENDPOINTS;
  const digest = providerContractDigest(input.providerContractPath, input.providerContractDocument);
  if (input.providerContractPath !== null && digest === null) {
    throw usageError(
      `provider MCP App contract changed or became unsafe while planning: ${input.providerContractPath}`,
    );
  }
  return validateMcpAppLocalContract({
    schema_version: "1",
    kind: MCP_APP_LOCAL_CONTRACT_KIND,
    compatibility_identifier: MCP_APP_COMPATIBILITY_IDENTIFIER,
    scope: "local-development",
    source: {
      type: input.providerContractPath === null ? "generated" : "provider-contract",
      provider_contract_path:
        input.providerContractPath === null
          ? null
          : portableSourcePath(input.root, input.providerContractPath),
      provider_contract_digest: digest,
    },
    provider: {
      name: input.identity.name,
      environment_prefix: input.identity.environmentPrefix,
      environment_file: input.identity.environmentFile,
    },
    lifecycle: { modes: [...MCP_APP_LIFECYCLE_MODES] },
    bindings: { ...input.bindings },
    public_endpoints: { ...publicEndpoints },
    environment_loading: {
      status: input.environmentLoading.status,
      mechanism: input.environmentLoading.mechanism,
      evidence_path: input.environmentLoading.evidencePath,
    },
  });
}

/** @param {import("../types.mjs").McpAppLocalContract} document */
export function serializeMcpAppLocalContract(document) {
  return `${JSON.stringify(validateMcpAppLocalContract(document), null, 2)}\n`;
}

/** @param {string} root */
export function mcpAppLocalContractFilename(root) {
  return join(root, MCP_APP_LOCAL_CONTRACT_PATH);
}
