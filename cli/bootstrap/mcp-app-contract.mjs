// @ts-check

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { usageError } from "../errors.mjs";
import { isPlainObject, MAX_CONTRACT_BYTES, safeRead } from "./contracts/files.mjs";
import { validateSupportedVersionRange } from "./contracts/images.mjs";
import { PENDING_SECRET_VALUE } from "./environment.mjs";

/** @typedef {import("../types.mjs").ProviderBindings} ProviderBindings */
/** @typedef {import("../domain/contracts.mjs").McpAppContract} McpAppContract */

export const MCP_APP_COMPATIBILITY_IDENTIFIER = "tama-mcp-app-bootstrap-v1";
export const MCP_APP_PROVIDER_CONTRACT_FILENAME = "tama-mcp-app-bootstrap-v1.json";
export const MCP_APP_TAMA_CONTRACT_FILENAME = "mcp-app-bootstrap-v1.json";
export const MCP_APP_LIFECYCLE_MODES = Object.freeze(["disabled", "prepared", "enabled"]);

/**
 * The semantic roles every MCP App bootstrap must bind to a provider-owned
 * environment variable. Tama Kit never infers meaning from a variable name;
 * a contract supplies the mapping, or the conventional table is used as a
 * fallback for providers without a committed contract.
 */
export const MCP_APP_ROLES = Object.freeze([
  "mode",
  "issuer",
  "resource",
  "access_token_signing_algorithm",
  "access_token_signing_key_id",
  "access_token_private_signing_key",
  "access_token_public_overlap_keys",
  "introspection_client_id",
  "introspection_jwks_uri",
]);

/** @type {Record<(typeof MCP_APP_ROLES)[number], string>} */
const CONVENTIONAL_ROLE_SUFFIX = Object.freeze({
  mode: "TAMA_MCP_APP_MODE",
  issuer: "OAUTH_ISSUER",
  resource: "TAMA_MCP_APP_RESOURCE",
  access_token_signing_algorithm: "OAUTH_SIGNING_ALGORITHM",
  access_token_signing_key_id: "OAUTH_SIGNING_KEY_ID",
  access_token_private_signing_key: "OAUTH_PRIVATE_SIGNING_KEY",
  access_token_public_overlap_keys: "OAUTH_PUBLIC_SIGNING_KEYS",
  introspection_client_id: "TAMA_INTROSPECTION_CLIENT_ID",
  introspection_jwks_uri: "TAMA_INTROSPECTION_JWKS_URI",
});

const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ENDPOINT_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;
const LOCAL_KEY_PATTERN = /^[a-z][a-z0-9_.-]*$/u;
export const MCP_APP_PROVIDER_PUBLIC_ENDPOINTS = Object.freeze({
  authorization_server_metadata: "/.well-known/oauth-authorization-server",
  jwks: "/.well-known/jwks.json",
  introspection: "/auth/introspections",
});
const VARIABLE_FORMATS = Object.freeze([
  "absolute-uri",
  "absolute-origin",
  "comma-separated-absolute-origins",
  "comma-separated-list",
  "bounded-identifier",
  "private-json-jwk",
  "public-json-jwk-array",
  "hostname",
]);
const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "compatibility_identifier",
  "lifecycle",
  "provider",
  "bindings",
  "environment_loading",
  "variables",
  "public_endpoints",
  "cache_policy",
  "availability",
  "mode_gate_responses",
  "local_development",
  "local_loopback",
]);
const VARIABLE_KEYS = Object.freeze([
  "required",
  "required_in",
  "format",
  "exact_path",
  "same_origin_as",
  "derived_from",
  "derived_template",
  "migration_assertion",
  "max_bytes",
  "max_items",
  "initial_value",
  "allowed_values",
  "values",
  "default",
  "x-sensitive",
]);

/** @param {string} value @returns {boolean} */
function safeString(value) {
  return (
    value.length > 0 &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

/** @param {unknown} value @param {string} label @returns {string} */
function requiredSafeString(value, label) {
  if (typeof value !== "string" || !safeString(value)) {
    throw usageError(`${label} must be a non-empty control-free string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string[]} */
function uniqueStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !safeString(entry))
  ) {
    throw usageError(`MCP App contract ${label} must be a non-empty string array`);
  }
  const strings = /** @type {string[]} */ (value);
  if (new Set(strings).size !== strings.length) {
    throw usageError(`MCP App contract ${label} must not contain duplicates`);
  }
  return strings;
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} label */
function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(
    (key) => !allowed.includes(key) && !(label === "variable" && key.startsWith("x-")),
  );
  if (unknown.length > 0) {
    throw usageError(`MCP App contract ${label} contains unsupported keys: ${unknown.join(", ")}`);
  }
}

/** @param {unknown} value @param {string} label @returns {string} */
export function safeRelativePath(value, label) {
  const path = requiredSafeString(value, label);
  if (isAbsolute(path) || path.includes("\\") || Buffer.byteLength(path, "utf8") > 256) {
    throw usageError(`${label} must be a safe project-relative path`);
  }
  const segments = path.split("/");
  if (
    segments.length > 3 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !SAFE_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw usageError(`${label} must be a safe project-relative path`);
  }
  return path;
}

/**
 * Paths a provider fragment must never occupy inside `tama/`: bootstrap owns
 * runtime, manifest, Compose, contract, and Terraform files there. A fragment
 * planned onto any of them would overwrite that content with only the provider
 * bindings.
 */
const RESERVED_FRAGMENT_PATHS = new Set([
  "tama/.tama.env",
  "tama/.tama.env.example",
  "tama/.tama.postgres.env",
  "tama/.gitignore",
  "tama/.tama-kit.json",
  "tama/AGENTS.md",
  "tama/README.md",
  "tama/compose.yaml",
]);

/** @param {string} path @param {string} label */
export function assertUnreservedFragmentPath(path, label) {
  if (!path.startsWith("tama/")) {
    throw usageError(
      `${label} must be inside the Tama directory: ${path}; choose a dedicated provider ` +
        `fragment filename such as tama/.<provider>.integration.env`,
    );
  }
  if (
    RESERVED_FRAGMENT_PATHS.has(path) ||
    path.startsWith("tama/contracts/") ||
    path.startsWith("tama/.terraform/") ||
    path === "tama/.terraform.lock.hcl" ||
    /^tama\/[^/]+\.tf(?:\.json)?$/u.test(path) ||
    /^tama\/[^/]+\.tfvars(?:\.json)?$/u.test(path) ||
    /^tama\/[^/]+\.tfstate(?:\..+)?$/u.test(path)
  ) {
    throw usageError(
      `${label} collides with a bootstrap-managed or application-owned path: ` +
        `${path}; choose a dedicated provider fragment filename such as tama/.<provider>.integration.env`,
    );
  }
}

/** @param {unknown} value @param {string} label @returns {string} */
function absoluteHttpOrigin(value, label) {
  const origin = requiredSafeString(value, label);
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw usageError(`MCP App contract ${label} must be an absolute http(s) origin`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    `${url.protocol}//${url.host}` !== origin
  ) {
    throw usageError(`MCP App contract ${label} must be an absolute http(s) origin`);
  }
  return origin;
}

/** @param {unknown} value @param {string} label */
function validateStringOrArray(value, label) {
  if (typeof value === "string") {
    requiredSafeString(value, label);
    return;
  }
  uniqueStringArray(value, label);
}

/** @param {Record<string, unknown>} lifecycle @returns {string[]} */
function validateLifecycle(lifecycle) {
  const modes = lifecycle.modes;
  if (
    !Array.isArray(modes) ||
    !MCP_APP_LIFECYCLE_MODES.every((mode) => /** @type {unknown[]} */ (modes).includes(mode))
  ) {
    throw usageError(
      "MCP App contract lifecycle.modes must include disabled, prepared, and enabled",
    );
  }
  rejectUnknownKeys(
    lifecycle,
    ["modes", "default_production_mode", "configured_modes", "enabled_modes"],
    "lifecycle",
  );
  const normalized = uniqueStringArray(modes, "lifecycle.modes");
  if (normalized.some((mode) => !MCP_APP_LIFECYCLE_MODES.includes(mode))) {
    throw usageError("MCP App contract lifecycle.modes contains an unsupported mode");
  }
  const defaultMode = requiredSafeString(
    lifecycle.default_production_mode,
    "lifecycle.default_production_mode",
  );
  if (!normalized.includes(defaultMode)) {
    throw usageError("MCP App contract lifecycle.default_production_mode must be a declared mode");
  }
  const configuredModes = uniqueStringArray(
    lifecycle.configured_modes,
    "lifecycle.configured_modes",
  );
  if (configuredModes.some((mode) => !normalized.includes(mode))) {
    throw usageError("MCP App contract lifecycle.configured_modes must contain declared modes");
  }
  if (!["prepared", "enabled"].every((mode) => configuredModes.includes(mode))) {
    throw usageError(
      "MCP App contract lifecycle.configured_modes must include prepared and enabled",
    );
  }
  const enabledModes = uniqueStringArray(lifecycle.enabled_modes, "lifecycle.enabled_modes");
  if (enabledModes.some((mode) => !normalized.includes(mode))) {
    throw usageError("MCP App contract lifecycle.enabled_modes must contain declared modes");
  }
  if (enabledModes.length !== 1 || enabledModes[0] !== "enabled") {
    throw usageError("MCP App contract lifecycle.enabled_modes must contain only enabled");
  }
  return normalized;
}

/** @param {unknown} value @param {string[]} modes */
function validateVariables(value, modes) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw usageError("MCP App contract variables must be a non-empty object");
  }
  for (const [name, rawSpec] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || !isPlainObject(rawSpec)) {
      throw usageError(`MCP App contract variables has an invalid ${name} definition`);
    }
    rejectUnknownKeys(rawSpec, VARIABLE_KEYS, "variable");
    const hasRequired = Object.hasOwn(rawSpec, "required");
    const hasRequiredIn = Object.hasOwn(rawSpec, "required_in");
    if (hasRequired === hasRequiredIn) {
      throw usageError(
        `MCP App contract variable ${name} must declare exactly one of required or required_in`,
      );
    }
    if (hasRequired && typeof rawSpec.required !== "boolean") {
      throw usageError(`MCP App contract variable ${name}.required must be a boolean`);
    }
    if (hasRequiredIn) {
      const requiredIn = uniqueStringArray(rawSpec.required_in, `variable ${name}.required_in`);
      if (requiredIn.some((mode) => !modes.includes(mode))) {
        throw usageError(`MCP App contract variable ${name}.required_in contains an unknown mode`);
      }
    }
    if (rawSpec.format !== undefined && !VARIABLE_FORMATS.includes(String(rawSpec.format))) {
      throw usageError(`MCP App contract variable ${name}.format is unsupported`);
    }
    if (
      rawSpec.exact_path !== undefined &&
      (typeof rawSpec.exact_path !== "string" || !ENDPOINT_PATH_PATTERN.test(rawSpec.exact_path))
    ) {
      throw usageError(`MCP App contract variable ${name}.exact_path is invalid`);
    }
    if (
      rawSpec.same_origin_as !== undefined &&
      (typeof rawSpec.same_origin_as !== "string" || !Object.hasOwn(value, rawSpec.same_origin_as))
    ) {
      throw usageError(`MCP App contract variable ${name}.same_origin_as is not declared`);
    }
    if (
      rawSpec.derived_from !== undefined &&
      (typeof rawSpec.derived_from !== "string" || !Object.hasOwn(value, rawSpec.derived_from))
    ) {
      throw usageError(`MCP App contract variable ${name}.derived_from is not declared`);
    }
    if (
      rawSpec.derived_template !== undefined &&
      (typeof rawSpec.derived_template !== "string" ||
        !safeString(rawSpec.derived_template) ||
        typeof rawSpec.derived_from !== "string" ||
        !rawSpec.derived_template.includes(`{${rawSpec.derived_from}}`))
    ) {
      throw usageError(
        `MCP App contract variable ${name}.derived_template must reference its declared source`,
      );
    }
    if (
      rawSpec.migration_assertion !== undefined &&
      typeof rawSpec.migration_assertion !== "boolean"
    ) {
      throw usageError(`MCP App contract variable ${name}.migration_assertion must be a boolean`);
    }
    const derived = rawSpec.derived_from !== undefined || rawSpec.derived_template !== undefined;
    if (derived && (rawSpec.derived_from === undefined || rawSpec.derived_template === undefined)) {
      throw usageError(
        `MCP App contract derived variable ${name} must declare both derived_from and derived_template`,
      );
    }
    if (derived && (rawSpec.required !== false || rawSpec.migration_assertion !== true)) {
      throw usageError(
        `MCP App contract derived variable ${name} must be optional and marked as a migration assertion`,
      );
    }
    if (!derived && rawSpec.migration_assertion !== undefined) {
      throw usageError(
        `MCP App contract variable ${name}.migration_assertion requires a derived source and template`,
      );
    }
    for (const field of ["max_bytes", "max_items"]) {
      if (
        rawSpec[field] !== undefined &&
        (!Number.isInteger(rawSpec[field]) || Number(rawSpec[field]) <= 0)
      ) {
        throw usageError(`MCP App contract variable ${name}.${field} must be a positive integer`);
      }
    }
    for (const field of ["initial_value", "allowed_values", "values", "default"]) {
      if (rawSpec[field] !== undefined) {
        validateStringOrArray(rawSpec[field], `variable ${name}.${field}`);
      }
    }
    if (rawSpec["x-sensitive"] !== undefined && typeof rawSpec["x-sensitive"] !== "boolean") {
      throw usageError(`MCP App contract variable ${name}.x-sensitive must be a boolean`);
    }
  }
}

/** @param {unknown} value */
function validatePublicEndpoints(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw usageError("MCP App contract public_endpoints must be a non-empty object");
  }
  for (const [name, path] of Object.entries(value)) {
    if (
      !LOCAL_KEY_PATTERN.test(name) ||
      typeof path !== "string" ||
      !ENDPOINT_PATH_PATTERN.test(path)
    ) {
      throw usageError(`MCP App contract public_endpoints.${name} is invalid`);
    }
  }
}

/** @param {unknown} value */
function validateProviderPublicEndpoints(value) {
  const endpoints = /** @type {Record<string, unknown>} */ (value);
  for (const [name, path] of Object.entries(MCP_APP_PROVIDER_PUBLIC_ENDPOINTS)) {
    if (endpoints[name] !== path) {
      throw usageError(
        `MCP App contract public_endpoints.${name} must be ${path}; Tama Kit cannot plan a different provider endpoint`,
      );
    }
  }
}

/** @param {unknown} value @param {string[]} modes */
function validateAvailability(value, modes) {
  if (!isPlainObject(value)) {
    throw usageError("MCP App contract availability must be an object");
  }
  for (const mode of modes) {
    const probes = value[mode];
    if (
      !isPlainObject(probes) ||
      Object.values(probes).some((probe) => typeof probe !== "boolean")
    ) {
      throw usageError(`MCP App contract availability.${mode} must be a boolean probe map`);
    }
  }
  if (Object.keys(value).some((mode) => !modes.includes(mode))) {
    throw usageError("MCP App contract availability contains an unknown mode");
  }
}

/** @param {unknown} value */
function validateProviderAvailability(value) {
  const availability = /** @type {Record<string, Record<string, unknown>>} */ (value);
  for (const mode of ["prepared", "enabled"]) {
    for (const probe of ["metadata", "jwks", "introspection"]) {
      if (availability[mode][probe] !== true) {
        throw usageError(
          `MCP App provider contract availability.${mode}.${probe} must be true; Tama Kit verifies this endpoint in ${mode} mode`,
        );
      }
    }
  }
}

/** @param {unknown} value */
function validateLocalDevelopment(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw usageError("MCP App contract local_development must be a non-empty object");
  }
  for (const [name, raw] of Object.entries(value)) {
    if (!LOCAL_KEY_PATTERN.test(name)) {
      throw usageError(`MCP App contract local_development has an invalid key: ${name}`);
    }
    if (name.endsWith("_origin")) {
      absoluteHttpOrigin(raw, `local_development.${name}`);
    } else {
      requiredSafeString(raw, `local_development.${name}`);
    }
  }
}

/** @param {unknown} value */
function validateLocalLoopback(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw usageError("MCP App contract local_loopback must be a non-empty object");
  }
  for (const [name, raw] of Object.entries(value)) {
    if (!LOCAL_KEY_PATTERN.test(name)) {
      throw usageError(`MCP App contract local_loopback has an invalid key: ${name}`);
    }
    validateStringOrArray(raw, `local_loopback.${name}`);
  }
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function validateProvider(value) {
  if (value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw usageError("MCP App contract provider must be an object");
  }
  rejectUnknownKeys(value, ["name", "environment_prefix", "environment_file"], "provider");
  const name = requiredSafeString(value.name, "provider.name");
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw usageError("MCP App contract provider.name must be a lowercase kebab-case name");
  }
  const prefix = requiredSafeString(value.environment_prefix, "provider.environment_prefix");
  if (!ENVIRONMENT_NAME_PATTERN.test(prefix)) {
    throw usageError("MCP App contract provider.environment_prefix is invalid");
  }
  const environmentFile = safeRelativePath(
    value.environment_file,
    "MCP App contract provider.environment_file",
  );
  assertUnreservedFragmentPath(environmentFile, "MCP App contract provider.environment_file");
  return value;
}

/** @param {unknown} value @param {Record<string, unknown> | null} provider */
function validateEnvironmentLoading(value, provider) {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    throw usageError("MCP App contract environment_loading must be an object");
  }
  rejectUnknownKeys(value, ["mechanism", "loader", "loads"], "environment_loading");
  requiredSafeString(value.mechanism, "environment_loading.mechanism");
  safeRelativePath(value.loader, "MCP App contract environment_loading.loader");
  const loads = safeRelativePath(value.loads, "MCP App contract environment_loading.loads");
  assertUnreservedFragmentPath(loads, "MCP App contract environment_loading.loads");
  if (provider && loads !== provider.environment_file) {
    throw usageError(
      "MCP App contract environment_loading.loads must match provider.environment_file",
    );
  }
}

/** @param {unknown} value @param {string[]} modes */
function validateModeGateResponses(value, modes) {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    throw usageError("MCP App contract mode_gate_responses must be an object");
  }
  for (const [mode, rawProbes] of Object.entries(value)) {
    if (!modes.includes(mode) || !isPlainObject(rawProbes)) {
      throw usageError(`MCP App contract mode_gate_responses.${mode} is invalid`);
    }
    for (const [probe, rawResponse] of Object.entries(rawProbes)) {
      if (!LOCAL_KEY_PATTERN.test(probe) || !isPlainObject(rawResponse)) {
        throw usageError(`MCP App contract mode_gate_responses.${mode}.${probe} is invalid`);
      }
      const availableOnly =
        Object.keys(rawResponse).length === 1 && typeof rawResponse.available === "boolean";
      const statusError =
        Object.keys(rawResponse).every((key) => key === "status" || key === "error") &&
        Number.isInteger(rawResponse.status) &&
        Number(rawResponse.status) >= 100 &&
        Number(rawResponse.status) <= 599 &&
        (rawResponse.error === undefined ||
          (typeof rawResponse.error === "string" && safeString(rawResponse.error)));
      if (!availableOnly && !statusError) {
        throw usageError(`MCP App contract mode_gate_responses.${mode}.${probe} is invalid`);
      }
    }
  }
}

/** @param {unknown} value @param {string} label */
function validateStringMap(value, label) {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw usageError(`MCP App contract ${label} must be a non-empty object`);
  }
  for (const [name, raw] of Object.entries(value)) {
    if (!LOCAL_KEY_PATTERN.test(name)) {
      throw usageError(`MCP App contract ${label} has an invalid key: ${name}`);
    }
    requiredSafeString(raw, `${label}.${name}`);
  }
}

/** @returns {string} */
export function bundledTamaContractPath() {
  return fileURLToPath(new URL("./contracts/mcp-app-bootstrap-v1.json", import.meta.url));
}

/**
 * Loads the Tama-side runtime contract bundled with Tama Kit. The contract
 * describes the Tama environment variables, lifecycle modes, public
 * endpoints, and local development topology that Tama Kit provisions.
 *
 * @returns {McpAppContract}
 */
export function loadTamaContract() {
  const path = bundledTamaContractPath();
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`cannot read the bundled Tama MCP App contract ${path}: ${message}`);
  }
  return validateMcpAppContract(document);
}

/**
 * Structurally validates a contract document against the versioned MCP App
 * bootstrap schema: the schema version, compatibility identifier, and
 * lifecycle modes must be present and supported.
 *
 * @param {unknown} document
 * @returns {McpAppContract}
 */
export function validateMcpAppContract(document) {
  if (!isPlainObject(document)) {
    throw usageError("MCP App contract must be a JSON object");
  }
  if (document.schema_version !== "1") {
    throw usageError(
      `unsupported MCP App contract schema_version: ${String(document.schema_version)}`,
    );
  }
  if (document.compatibility_identifier !== MCP_APP_COMPATIBILITY_IDENTIFIER) {
    throw usageError(
      `unsupported MCP App contract compatibility_identifier: ${String(
        document.compatibility_identifier,
      )}`,
    );
  }
  const lifecycle = isPlainObject(document.lifecycle) ? document.lifecycle : null;
  if (!lifecycle) {
    throw usageError(
      "MCP App contract lifecycle.modes must include disabled, prepared, and enabled",
    );
  }
  const modes = validateLifecycle(lifecycle);
  const unknownTopLevel = Object.keys(document).filter(
    (key) => !TOP_LEVEL_KEYS.includes(key) && !key.startsWith("supported_"),
  );
  if (unknownTopLevel.length > 0) {
    throw usageError(
      `MCP App contract contains unsupported top-level keys: ${unknownTopLevel.join(", ")}`,
    );
  }
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith("supported_")) {
      const supported = requiredSafeString(value, key);
      if (key.endsWith("_versions")) {
        validateSupportedVersionRange(supported, key);
      }
    }
  }
  validateVariables(document.variables, modes);
  validatePublicEndpoints(document.public_endpoints);
  validateAvailability(document.availability, modes);
  if (document.local_development !== undefined) {
    validateLocalDevelopment(document.local_development);
  }
  validateLocalLoopback(document.local_loopback);
  const provider = validateProvider(document.provider);
  if (provider !== null) {
    validateProviderPublicEndpoints(document.public_endpoints);
    validateProviderAvailability(document.availability);
  }
  validateEnvironmentLoading(document.environment_loading, provider);
  validateStringMap(document.cache_policy, "cache_policy");
  validateModeGateResponses(document.mode_gate_responses, modes);
  // Any contract that declares a provider identity names the variables the
  // planner will write — explicitly through bindings or conventionally from
  // the declared prefix — so every such contract is cross-checked. Contracts
  // without a provider identity (such as the Tama runtime contract) declare
  // only their own variables and are not role-bound.
  if (provider !== null) {
    validateBindingsAgainstVariables(document, provider);
  }
  return /** @type {McpAppContract} */ (document);
}

/**
 * Cross-checks the resolved role bindings against the declared variables:
 * every variable the planner writes must be declared, and the declared
 * constraints must be compatible with the fixed values the planner emits —
 * the lifecycle modes it writes and the hard-coded RS256 signing algorithm.
 * A contract that binds a role to an undeclared variable, or declares
 * constraints the planner cannot satisfy, would be written over only after
 * secrets already exist. Both the explicit bindings map and the conventional
 * fallback derived from the declared prefix are checked.
 *
 * @param {Record<string, unknown>} document
 * @param {Record<string, unknown>} provider Validated provider section.
 */
function validateBindingsAgainstVariables(document, provider) {
  const prefix =
    typeof provider.environment_prefix === "string" ? provider.environment_prefix : null;
  if (prefix === null) {
    throw usageError("MCP App contract provider.environment_prefix is invalid");
  }
  const roles = resolveBindings(document, prefix).roles;
  const variables = isPlainObject(document.variables) ? document.variables : null;
  for (const [role, name] of Object.entries(roles)) {
    const variable = variables === null ? null : variables[name];
    if (!isPlainObject(variable)) {
      throw usageError(`MCP App contract binding "${role}" references undeclared variable ${name}`);
    }
    const enumerations = declaredEnumerations(variable);
    if (enumerations.length === 0) {
      continue;
    }
    if (role === "mode") {
      if (
        enumerations.some((declared) =>
          ["prepared", "enabled"].some((mode) => !declared.includes(mode)),
        )
      ) {
        throw usageError(
          `MCP App contract variable ${name} must include the lifecycle modes the planner writes: prepared and enabled`,
        );
      }
    }
    if (
      role === "access_token_signing_algorithm" &&
      enumerations.some((declared) => !declared.includes("RS256"))
    ) {
      throw usageError(
        `MCP App contract variable ${name} must accept RS256, the algorithm the planner emits`,
      );
    }
  }
}

/** @param {unknown} value @returns {string[] | null} */
function stringList(value) {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** @param {Record<string, unknown>} variable @returns {string[][]} */
function declaredEnumerations(variable) {
  return [variable.values, variable.allowed_values]
    .map((value) => stringList(value))
    .filter((value) => value !== null);
}

/**
 * Validates the concrete values the planner will write into the provider
 * fragment against the constraints the accepted contract declares for the
 * variables those values are bound to. The declaration-time cross-check
 * already guarantees the variables exist and their enumeration constraints are
 * satisfiable; this checks the value-specific constraints — enumerations,
 * `format`, `exact_path`, `same_origin_as`, `max_bytes`, and `max_items` — that only
 * become checkable once the planned origins, paths, and identifiers are known.
 * A contract that declared, say, `exact_path: "/different"` for the resource
 * or `max_bytes: 1` for the issuer would otherwise be violated by the
 * planner's `/mcp/app` resource and real origins only after secrets exist.
 * Dry-run placeholder values are exempt: the real material is validated when
 * it is generated or preserved.
 *
 * @param {McpAppContract | null} contractDocument Provider contract, or null for conventional bindings.
 * @param {Record<string, string>} roles Role to bound variable name.
 * @param {Record<string, string>} emitted Variable name to planned value.
 */
export function validateEmittedMcpAppValues(contractDocument, roles, emitted) {
  if (contractDocument === null) {
    return;
  }
  const variables = isPlainObject(contractDocument.variables) ? contractDocument.variables : null;
  for (const [role, name] of Object.entries(roles)) {
    const spec = variables === null || !isPlainObject(variables[name]) ? null : variables[name];
    if (spec === null) {
      throw usageError(`MCP App contract binding "${role}" references undeclared variable ${name}`);
    }
    const value = emitted[name];
    if (typeof value !== "string") {
      throw usageError(`MCP App contract variable ${name} has no planned value`);
    }
    if (value === PENDING_SECRET_VALUE) {
      continue;
    }
    /** @param {string} reason */
    const reject = (reason) =>
      usageError(`MCP App contract variable ${name} rejects the planned value: ${reason}`);
    if (declaredEnumerations(spec).some((declared) => !declared.includes(value))) {
      throw reject("it is not one of the declared values");
    }
    if (spec.max_bytes !== undefined && Buffer.byteLength(value, "utf8") > Number(spec.max_bytes)) {
      throw reject(
        `it is ${Buffer.byteLength(value, "utf8")} bytes, exceeding max_bytes ${spec.max_bytes}`,
      );
    }
    const format = typeof spec.format === "string" ? spec.format : null;
    /** @type {URL | null} */
    let url = null;
    /** @type {string[] | null} */
    let listItems = null;
    if (format === "absolute-uri" || format === "absolute-origin") {
      url =
        parseUrl(value) ??
        (() => {
          throw reject(`it is not a ${format}`);
        })();
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw reject(`${format} must use http or https, not ${url.protocol}`);
      }
      if (
        format === "absolute-origin" &&
        (url.pathname !== "/" || url.search !== "" || url.hash !== "")
      ) {
        throw reject("an absolute origin must not include a path, query, or fragment");
      }
    } else if (format === "comma-separated-absolute-origins") {
      listItems = value.split(",");
      for (const item of listItems) {
        const itemUrl = parseUrl(item);
        if (
          itemUrl === null ||
          (itemUrl.protocol !== "http:" && itemUrl.protocol !== "https:") ||
          itemUrl.pathname !== "/" ||
          itemUrl.search !== "" ||
          itemUrl.hash !== ""
        ) {
          throw reject("each comma-separated entry must be an absolute http(s) origin");
        }
      }
    } else if (format === "comma-separated-list") {
      listItems = value.split(",");
      if (listItems.some((item) => item.trim() === "")) {
        throw reject("comma-separated entries must be non-empty");
      }
    } else if (format === "bounded-identifier") {
      if (value.trim() === "" || /\s/u.test(value)) {
        throw reject("a bounded identifier must be non-empty and contain no whitespace");
      }
    } else if (format === "private-json-jwk") {
      const parsed = parseJson(value, reject);
      if (!isPlainObject(parsed) || parsed.kty !== "RSA" || typeof parsed.d !== "string") {
        throw reject("a private JSON JWK must be an RSA member with a private exponent");
      }
    } else if (format === "public-json-jwk-array") {
      const parsed = parseJson(value, reject);
      if (!Array.isArray(parsed)) {
        throw reject("a public JSON JWK set must be a JSON array");
      }
      listItems = parsed.map((entry) => String(entry));
    }
    if (
      spec.max_items !== undefined &&
      listItems !== null &&
      listItems.length > Number(spec.max_items)
    ) {
      throw reject(`it has ${listItems.length} items, exceeding max_items ${spec.max_items}`);
    }
    if (url !== null) {
      if (spec.exact_path !== undefined && url.pathname !== String(spec.exact_path)) {
        throw reject(`its path is ${url.pathname}, which must be ${spec.exact_path}`);
      }
      if (spec.same_origin_as !== undefined) {
        const other = emitted[String(spec.same_origin_as)];
        const otherUrl = typeof other === "string" ? parseUrl(other) : null;
        if (otherUrl === null || otherUrl.origin !== url.origin) {
          throw reject(`it must share the origin of ${spec.same_origin_as}`);
        }
      }
    }
  }
}

/** @param {string} value @returns {URL | null} */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 * @param {(reason: string) => Error} reject
 * @returns {unknown}
 */
function parseJson(value, reject) {
  try {
    return JSON.parse(value);
  } catch {
    throw reject("it is not valid JSON");
  }
}

/** @param {string} path @returns {McpAppContract} */
function parseContract(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw usageError(`provider MCP App contract does not exist: ${path}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw usageError(`provider MCP App contract does not exist: ${path}`);
  }
  if (metadata.size > MAX_CONTRACT_BYTES) {
    throw usageError(`provider MCP App contract is too large: ${path}`);
  }
  const content = safeRead(path);
  if (content === null) {
    throw usageError(`provider MCP App contract does not exist: ${path}`);
  }
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`cannot parse provider MCP App contract ${path}: ${message}`);
  }
  return validateMcpAppContract(document);
}

/**
 * Locates and loads the provider contract. An explicit path wins; otherwise
 * the `priv/contracts/` directory is scanned for JSON documents whose
 * `compatibility_identifier` matches the supported allow-list. Exactly one
 * match is used; zero matches fall back to conventional binding derivation;
 * multiple matches fail with a message requesting the explicit flag.
 *
 * @param {string} root
 * @param {string | undefined} explicitPath
 * @returns {{path: string | null, document: McpAppContract | null}}
 */
export function discoverProviderContract(root, explicitPath) {
  if (explicitPath) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(root, explicitPath);
    return { path, document: parseContract(path) };
  }
  const directory = join(root, "priv", "contracts");
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) {
    return { path: null, document: null };
  }
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return { path: null, document: null };
  }
  const matches = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".json")) {
      continue;
    }
    const path = join(directory, entry);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONTRACT_BYTES) {
      continue;
    }
    const content = safeRead(path);
    if (content === null) {
      continue;
    }
    let document;
    try {
      document = JSON.parse(content);
    } catch {
      continue;
    }
    if (
      isPlainObject(document) &&
      document.compatibility_identifier === MCP_APP_COMPATIBILITY_IDENTIFIER
    ) {
      matches.push({ path, document });
    }
  }
  if (matches.length === 0) {
    return { path: null, document: null };
  }
  if (matches.length > 1) {
    throw usageError(
      `multiple MCP App contracts were found in ${directory}: ${matches
        .map((entry) => entry.path)
        .join(", ")}. Pass --mcp-app-contract to select one`,
    );
  }
  const [selected] = matches;
  return { path: selected.path, document: validateMcpAppContract(selected.document) };
}

/**
 * Resolves the semantic role bindings. A contract with an explicit
 * `bindings` map supplies the variable names; otherwise the conventional
 * `<PREFIX>_<SUFFIX>` table derives them from the environment prefix.
 *
 * @param {{bindings?: unknown} | null} contractDocument
 * @param {string} environmentPrefix
 * @returns {ProviderBindings}
 */
export function resolveBindings(contractDocument, environmentPrefix) {
  const bindings = isPlainObject(contractDocument?.bindings) ? contractDocument.bindings : null;
  if (bindings) {
    const unexpected = Object.keys(bindings).filter((role) => !MCP_APP_ROLES.includes(role));
    if (unexpected.length > 0) {
      throw usageError(
        `provider MCP App contract bindings contains unsupported roles: ${unexpected.join(", ")}`,
      );
    }
    const roles = /** @type {Record<string, string>} */ ({});
    const used = new Map();
    for (const role of MCP_APP_ROLES) {
      const value = bindings[role];
      if (typeof value !== "string" || !ENVIRONMENT_NAME_PATTERN.test(value)) {
        throw usageError(`provider MCP App contract bindings is missing the "${role}" role`);
      }
      const previousRole = used.get(value);
      if (previousRole) {
        throw usageError(
          `provider MCP App contract bindings maps both "${previousRole}" and "${role}" to ${value}`,
        );
      }
      used.set(value, role);
      roles[role] = value;
    }
    return { source: "contract", roles };
  }
  const roles = /** @type {Record<string, string>} */ ({});
  for (const [role, suffix] of Object.entries(CONVENTIONAL_ROLE_SUFFIX)) {
    roles[role] = `${environmentPrefix}_${suffix}`;
  }
  return { source: "conventional", roles };
}

/**
 * Reads an optional local development origin declared by the provider
 * contract, keyed by `<provider>_origin`. This keeps provider-specific
 * defaults inside the provider contract instead of Tama Kit.
 *
 * @param {McpAppContract | null} contractDocument
 * @param {string} providerName
 * @returns {string | null}
 */
export function contractLocalOrigin(contractDocument, providerName) {
  const local = isPlainObject(contractDocument?.local_development)
    ? contractDocument.local_development
    : null;
  const value = local?.[`${providerName}_origin`];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads the local development Tama port from an accepted contract so a fresh
 * MCP App bootstrap selects the topology the contract documents (normally
 * the provider on 4000 and Tama on 4001) instead of the generic default,
 * which would put both host-native services on the same port. The provider
 * contract wins over the bundled Tama contract; an absent or unparsable
 * origin yields null.
 *
 * @param {McpAppContract | null} providerContract
 * @param {McpAppContract | null} tamaContract
 * @returns {number | null}
 */
export function contractTamaPort(providerContract, tamaContract) {
  for (const document of [providerContract, tamaContract]) {
    const local = isPlainObject(document?.local_development) ? document.local_development : null;
    const value = local?.tama_origin;
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const rawPort = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
    const port = Number.parseInt(rawPort, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
      return port;
    }
  }
  return null;
}

export {
  verifyEnvironmentLoading,
  verifyEnvironmentLoadingEvidence,
} from "./contracts/environment-loading.mjs";
export {
  invalidOfficialTamaImageTag,
  unpinnedTamaImageTag,
  unsupportedTamaImage,
} from "./contracts/images.mjs";
