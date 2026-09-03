// @ts-check

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { ownershipError } from "../errors.mjs";
import { DEFAULTS } from "./constants.mjs";
import { hasManagedMarker, operationForContent } from "./files.mjs";
import {
  generateOAuthPrivateJwk,
  validateOAuthPrivateJwk,
  validatePublicJwkSet,
} from "./oauth-key.mjs";

const RETIRED_OAUTH_VARIABLES = ["TAMA_OAUTH_SIGNING_KEY", "TAMA_OAUTH_SIGNING_KEY_ID"];
export const PENDING_SECRET_VALUE = "__tama-kit-pending-secret-material__";

/** @typedef {import("../types.mjs").EnvironmentPlan} EnvironmentPlan */
/** @typedef {import("../types.mjs").McpAppEnvironmentInput} McpAppEnvironmentInput */
/** @typedef {import("../types.mjs").McpAppMode} McpAppMode */

const REQUIRED_ENVIRONMENT_VARIABLES = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "DATABASE_URL",
  "PHX_HOST",
  "PORT",
  "TAMA_PORT",
  "SECRET_KEY_BASE",
  "TAMA_VAULT_KEY",
  "TAMA_JWT_SECRET",
  "TAMA_OAUTH_PRIVATE_JWK",
  "TAMA_OAUTH_PRIVATE_JWK_ID",
  "TAMA_SETUP_TOKEN",
  "TAMA_DISABLE_CLUSTERING",
  "TAMA_OAUTH_ISSUER",
  "TAMA_MCP_RESOURCE",
  "TAMA_MCP_ALLOWED_ORIGINS",
  "TAMA_BASE_URL",
];

/** @param {number} [bytes] */
function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** @param {string} content @param {string} filename @returns {Map<string, string>} */
function parseEnvironment(content, filename) {
  const values = new Map();
  const duplicates = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match) {
      if (values.has(match[1])) {
        duplicates.add(match[1]);
      }
      let value;
      try {
        value = parseEnv(`${line}\n`)[match[1]];
      } catch {
        throw ownershipError(`${filename} contains invalid dotenv syntax for ${match[1]}`, {
          path: filename,
          variable: match[1],
        });
      }
      values.set(match[1], value ?? "");
    }
  }
  if (duplicates.size > 0) {
    const names = [...duplicates].sort();
    throw ownershipError(
      `${filename} contains duplicate environment variables: ${names.join(", ")}`,
      {
        path: filename,
        variables: names,
      },
    );
  }
  return values;
}

/**
 * Reads the variable values from an environment file without planning or
 * validating them. A missing file yields an empty map; malformed or
 * duplicate variables fail closed with an ownership error.
 *
 * @param {string} root
 * @param {string} filename
 * @returns {Map<string, string>}
 */
export function readEnvironmentValues(root, filename) {
  const path = join(root, filename);
  if (!existsSync(path)) {
    return new Map();
  }
  return parseEnvironment(readFileSync(path, "utf8"), filename);
}

/**
 * Reads the raw line for a variable from an environment file so managed
 * content can re-emit it byte-for-byte, preserving quoting and whitespace.
 * A missing file or variable yields null.
 *
 * @param {string} root
 * @param {string} filename
 * @param {string} variable
 * @returns {string | null}
 */
export function readRawEnvironmentLine(root, filename, variable) {
  const path = join(root, filename);
  if (!existsSync(path)) {
    return null;
  }
  const prefix = `${variable}=`;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (line.startsWith(prefix)) {
      return line;
    }
  }
  return null;
}

/**
 * Reads the configured public Tama port from an existing `.tama.env`.
 * Returns null when the file is absent or the port is not a valid TCP port;
 * the caller falls back to the default or an explicit flag.
 *
 * @param {string} root
 * @returns {number | null}
 */
export function configuredPort(root) {
  try {
    const values = readEnvironmentValues(root, ".tama.env");
    const raw = values.get("TAMA_PORT");
    if (raw === undefined || !/^\d+$/u.test(raw)) {
      return null;
    }
    const port = Number.parseInt(raw, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the public Tama port the way the environment file will reflect it:
 * an explicit request wins, otherwise an existing `TAMA_PORT` is preserved
 * (failing closed when it is invalid), otherwise a fresh-run default (when
 * supplied), otherwise the default. Exposed so the MCP App planner can derive
 * origins for the same port the environment file will carry.
 *
 * @param {string} root
 * @param {number | undefined} [requestedPort]
 * @param {number | undefined} [freshDefaultPort] Default for a project
 *   without `.tama.env`, derived from the accepted MCP App contract.
 * @returns {number}
 */
export function resolveEnvironmentPort(root, requestedPort, freshDefaultPort) {
  const filename = join(root, ".tama.env");
  if (!existsSync(filename)) {
    return requestedPort ?? freshDefaultPort ?? DEFAULTS.port;
  }
  const raw =
    parseEnvironment(readFileSync(filename, "utf8"), filename).get("TAMA_PORT") ??
    String(DEFAULTS.port);
  const existingPort = /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(existingPort) || existingPort < 1 || existingPort > 65_535) {
    throw ownershipError(`.tama.env has an invalid TAMA_PORT: ${raw}`);
  }
  return requestedPort ?? existingPort;
}

/** @param {string} root */
export function readSetupUrl(root) {
  const filename = join(root, ".tama.env");
  const values = parseEnvironment(readFileSync(filename, "utf8"), filename);
  const port = values.get("TAMA_PORT");
  const setupToken = values.get("TAMA_SETUP_TOKEN");
  if (!port || !setupToken) {
    throw ownershipError(`${filename} must define TAMA_PORT and TAMA_SETUP_TOKEN`, {
      path: filename,
    });
  }
  return `http://localhost:${port}/setup/root?token=${encodeURIComponent(setupToken)}`;
}

/** @param {string} content @param {Record<string, string | number>} updates */
function updateEnvironment(content, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = content.split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/u);
    if (!match || !remaining.has(match[1])) {
      return line;
    }
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  if (remaining.size > 0) {
    lines.push("", ...[...remaining].map(([name, value]) => `${name}=${value}`));
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string | undefined} value @param {number} existingPort @param {number} port */
function updateAllowedOrigins(value, existingPort, port) {
  const previousOrigin = `http://localhost:${existingPort}`;
  const nextOrigin = `http://localhost:${port}`;
  if (!value) {
    return nextOrigin;
  }
  return value
    .split(",")
    .map((origin) =>
      origin.trim() === previousOrigin ? origin.replace(previousOrigin, nextOrigin) : origin,
    )
    .join(",");
}

/** @param {string} value @returns {string | null} */
function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** @param {Map<string, string>} values @param {string} filename */
function validateDatabaseUrl(values, filename) {
  let databaseUrl;
  try {
    databaseUrl = new URL(values.get("DATABASE_URL") ?? "");
  } catch {
    databaseUrl = null;
  }

  const valid =
    databaseUrl?.protocol === "ecto:" &&
    databaseUrl.hostname === "tama-postgres" &&
    (databaseUrl.port === "" || databaseUrl.port === "5432") &&
    decodeUrlComponent(databaseUrl.username) === values.get("POSTGRES_USER") &&
    decodeUrlComponent(databaseUrl.password) === values.get("POSTGRES_PASSWORD") &&
    decodeUrlComponent(databaseUrl.pathname.replace(/^\//u, "")) === values.get("POSTGRES_DB");
  if (!valid) {
    throw ownershipError(
      `${filename} has a DATABASE_URL that does not match the generated PostgreSQL credentials`,
      { path: filename, variable: "DATABASE_URL" },
    );
  }
}

/**
 * Replace the retired TAMA_OAUTH_SIGNING_KEY/TAMA_OAUTH_SIGNING_KEY_ID lines
 * in place with a fresh private JWK pair, preserving every other line.
 * @param {string} content
 */
function migrateOAuthKeyPair(content) {
  const oauth = generateOAuthPrivateJwk();
  let replaced = 0;
  const lines = content.split(/\r?\n/u).map((line) => {
    if (line.startsWith("TAMA_OAUTH_SIGNING_KEY=")) {
      replaced += 1;
      return `TAMA_OAUTH_PRIVATE_JWK='${oauth.jwk}'`;
    }
    if (line.startsWith("TAMA_OAUTH_SIGNING_KEY_ID=")) {
      replaced += 1;
      return `TAMA_OAUTH_PRIVATE_JWK_ID=${oauth.kid}`;
    }
    return line;
  });
  if (replaced !== 2) {
    throw new Error("internal error: retired OAuth signing key lines are missing");
  }
  return lines.join("\n");
}

/** @param {string} value */
export function isValidVaultKey(value) {
  if (Buffer.byteLength(value, "utf8") === 32) {
    return true;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

/** @param {Map<string, string>} values @param {string} filename */
function validateRuntimeSecrets(values, filename) {
  const invalid = [];
  if (Buffer.byteLength(values.get("SECRET_KEY_BASE") ?? "", "utf8") < 64) {
    invalid.push("SECRET_KEY_BASE");
  }
  if (!isValidVaultKey(values.get("TAMA_VAULT_KEY") ?? "")) {
    invalid.push("TAMA_VAULT_KEY");
  }
  if (invalid.length > 0) {
    throw ownershipError(
      `${filename} contains runtime secrets with invalid formats: ${invalid.join(", ")}`,
      { path: filename, variables: invalid },
    );
  }
}

/** @param {Map<string, string>} values @param {string} filename @param {number} port */
function validateEnvironment(values, filename, port) {
  if (
    Boolean(values.get("TAMA_OAUTH_PRIVATE_JWK")) !==
    Boolean(values.get("TAMA_OAUTH_PRIVATE_JWK_ID"))
  ) {
    throw ownershipError(
      `${filename} must define TAMA_OAUTH_PRIVATE_JWK and TAMA_OAUTH_PRIVATE_JWK_ID together`,
      { path: filename, variables: ["TAMA_OAUTH_PRIVATE_JWK", "TAMA_OAUTH_PRIVATE_JWK_ID"] },
    );
  }
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !values.get(name));
  if (missing.length > 0) {
    throw ownershipError(
      `${filename} must define non-empty runtime variables: ${missing.join(", ")}`,
      { path: filename, variables: missing },
    );
  }
  const pending = values.get("TAMA_OAUTH_PRIVATE_JWK") === PENDING_SECRET_VALUE;
  if (!pending) {
    validateRuntimeSecrets(values, filename);
    validateOAuthPrivateJwk(
      values.get("TAMA_OAUTH_PRIVATE_JWK") ?? "",
      values.get("TAMA_OAUTH_PRIVATE_JWK_ID") ?? "",
    );
  }
  validateDatabaseUrl(values, filename);
  const internalPort = values.get("PORT");
  if (internalPort !== String(DEFAULTS.containerPort)) {
    throw ownershipError(
      `${filename} has an unsupported PORT: ${internalPort}; Tama must listen on ${DEFAULTS.containerPort} inside the generated container`,
      {
        path: filename,
        variable: "PORT",
        expected: String(DEFAULTS.containerPort),
        actual: internalPort,
      },
    );
  }

  const baseUrl = `http://localhost:${port}`;
  const expectedUrls = {
    TAMA_OAUTH_ISSUER: baseUrl,
    TAMA_MCP_RESOURCE: `${baseUrl}/mcp`,
    TAMA_BASE_URL: baseUrl,
  };
  const mismatches = Object.entries(expectedUrls)
    .filter(([name, expected]) => values.get(name) !== expected)
    .map(([name]) => name);
  const allowedOrigins = values
    .get("TAMA_MCP_ALLOWED_ORIGINS")
    ?.split(",")
    .map((origin) => origin.trim());
  if (!allowedOrigins?.includes(baseUrl)) {
    mismatches.push("TAMA_MCP_ALLOWED_ORIGINS");
  }
  if (mismatches.length > 0) {
    throw ownershipError(
      `${filename} has public URLs that do not match TAMA_PORT ${port}: ${mismatches.join(", ")}`,
      { path: filename, variables: mismatches, port },
    );
  }
}

/** @param {number} port @param {boolean} materializeSecrets */
function newEnvironment(port, materializeSecrets) {
  const postgresPassword = materializeSecrets ? token(24) : PENDING_SECRET_VALUE;
  const oauth = materializeSecrets
    ? generateOAuthPrivateJwk()
    : { jwk: PENDING_SECRET_VALUE, kid: "tama-oauth-pending" };
  return [
    "# Generated by Tama Kit. Keep this file private and do not commit it.",
    "",
    "POSTGRES_USER=tama",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "POSTGRES_DB=tama",
    `DATABASE_URL=ecto://tama:${postgresPassword}@tama-postgres/tama`,
    "",
    "PHX_HOST=localhost",
    `PORT=${DEFAULTS.containerPort}`,
    `TAMA_PORT=${port}`,
    `SECRET_KEY_BASE=${materializeSecrets ? token(48) : PENDING_SECRET_VALUE}`,
    `TAMA_VAULT_KEY=${materializeSecrets ? randomBytes(32).toString("base64") : PENDING_SECRET_VALUE}`,
    `TAMA_JWT_SECRET=${materializeSecrets ? token(32) : PENDING_SECRET_VALUE}`,
    `TAMA_OAUTH_PRIVATE_JWK='${oauth.jwk}'`,
    `TAMA_OAUTH_PRIVATE_JWK_ID=${oauth.kid}`,
    `TAMA_SETUP_TOKEN=${materializeSecrets ? token(24) : PENDING_SECRET_VALUE}`,
    "",
    "TAMA_DISABLE_CLUSTERING=true",
    `TAMA_OAUTH_ISSUER=http://localhost:${port}`,
    `TAMA_MCP_RESOURCE=http://localhost:${port}/mcp`,
    `TAMA_MCP_ALLOWED_ORIGINS=http://localhost:${port}`,
    `TAMA_BASE_URL=http://localhost:${port}`,
    "TAMA_CLIENT_ID=",
    "TAMA_CLIENT_SECRET=",
    "",
  ].join("\n");
}

/** @param {McpAppMode} mode @returns {string} */
function mcpAppHeader(mode) {
  return `# MCP App integration (${mode}). Managed by Tama Kit for local development.`;
}

/** @param {Record<string, string>} variables @returns {string[]} */
function mcpAppLines(variables) {
  return Object.entries(variables).map(([name, value]) => `${name}=${value}`);
}

/**
 * @param {Map<string, string>} values
 * @param {string} filename
 * @param {McpAppEnvironmentInput["validation"]} validation
 */
function validateMcpAppVariables(values, filename, validation) {
  const mode = values.get("TAMA_MCP_APP_MODE");
  if (mode !== "prepared" && mode !== "enabled") {
    throw ownershipError(`${filename} must set TAMA_MCP_APP_MODE to prepared or enabled`, {
      path: filename,
      variable: "TAMA_MCP_APP_MODE",
    });
  }

  if (values.get("TAMA_MCP_APP_RESOURCE") !== validation.resource) {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_RESOURCE must be exactly ${validation.resource}`,
      { path: filename, variable: "TAMA_MCP_APP_RESOURCE" },
    );
  }

  const authServer = values.get("TAMA_MCP_APP_AUTHORIZATION_SERVER");
  if (authServer !== validation.authorizationServerOrigin) {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_AUTHORIZATION_SERVER must be the provider origin ${validation.authorizationServerOrigin}`,
      { path: filename, variable: "TAMA_MCP_APP_AUTHORIZATION_SERVER" },
    );
  }

  // The JWKS and introspection endpoints follow the transport origin when a
  // container runtime rewrite is configured; issuer validation always uses
  // the public authorization server origin above.
  const expectedJwks = `${validation.serviceOrigin}/.well-known/jwks.json`;
  if (values.get("TAMA_MCP_APP_JWKS_URI") !== expectedJwks) {
    throw ownershipError(`${filename} TAMA_MCP_APP_JWKS_URI must be exactly ${expectedJwks}`, {
      path: filename,
      variable: "TAMA_MCP_APP_JWKS_URI",
    });
  }

  const expectedIntrospection = `${validation.serviceOrigin}/auth/introspections`;
  if (values.get("TAMA_MCP_APP_INTROSPECTION_ENDPOINT") !== expectedIntrospection) {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_INTROSPECTION_ENDPOINT must be exactly ${expectedIntrospection}`,
      { path: filename, variable: "TAMA_MCP_APP_INTROSPECTION_ENDPOINT" },
    );
  }

  if (values.get("TAMA_MCP_APP_SIGNING_ALGORITHMS") !== "RS256") {
    throw ownershipError(`${filename} TAMA_MCP_APP_SIGNING_ALGORITHMS must be exactly RS256`, {
      path: filename,
      variable: "TAMA_MCP_APP_SIGNING_ALGORITHMS",
    });
  }

  const allowed = (values.get("TAMA_MCP_APP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    allowed.length !== validation.allowedOrigins.length ||
    allowed.some((entry, index) => entry !== validation.allowedOrigins[index])
  ) {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_ALLOWED_ORIGINS must exactly match the persisted integration`,
      { path: filename, variable: "TAMA_MCP_APP_ALLOWED_ORIGINS" },
    );
  }

  if (values.get("TAMA_MCP_APP_INTROSPECTION_CLIENT_ID") !== validation.introspectionClientId) {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_INTROSPECTION_CLIENT_ID must be ${validation.introspectionClientId}`,
      { path: filename, variable: "TAMA_MCP_APP_INTROSPECTION_CLIENT_ID" },
    );
  }

  if (values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM") !== "RS256") {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM must be exactly RS256`,
      { path: filename, variable: "TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM" },
    );
  }

  const publicKeys = values.get("TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS");
  if (publicKeys === undefined) {
    throw ownershipError(
      `${filename} must define TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS for overlap rotation state`,
      { path: filename, variable: "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS" },
    );
  }
  validatePublicJwkSet(
    publicKeys,
    "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS",
    values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID"),
  );

  const privateJwk = values.get("TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY");
  const kid = values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID");
  if (!privateJwk || !kid) {
    throw ownershipError(
      `${filename} must define TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY and TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID`,
      {
        path: filename,
        variables: [
          "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
          "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
        ],
      },
    );
  }
  try {
    if (privateJwk !== PENDING_SECRET_VALUE) {
      validateOAuthPrivateJwk(privateJwk, kid);
    }
  } catch {
    throw ownershipError(
      `${filename} TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY is not a valid RSA private JWK for RS256 signing`,
      {
        path: filename,
        variables: [
          "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
          "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
        ],
      },
    );
  }
}

/**
 * Serialize a value for Docker Compose's env_file parser. Double quotes keep
 * hashes and whitespace inside the value, JSON escapes preserve supported
 * control characters, and doubled dollar signs prevent host interpolation.
 *
 * @param {string} value
 * @param {string} name
 * @param {string} filename
 */
function composeEnvironmentValue(value, name, filename) {
  const unsupportedCharacter = Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 0x07 ||
      code === 0x0b ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f ||
      (code >= 0xd800 && code <= 0xdfff)
    );
  });
  if (unsupportedCharacter) {
    throw ownershipError(
      `${filename} contains a ${name} value that cannot be represented safely in a Compose environment file`,
      { path: filename, variable: name },
    );
  }
  return JSON.stringify(value).replaceAll("$", () => "$$");
}

/** @param {Map<string, string>} values @param {string} filename */
function postgresEnvironment(values, filename) {
  const required = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"];
  for (const name of required) {
    if (!values.get(name)) {
      throw new Error(`.tama.env must define a non-empty ${name}`);
    }
  }
  return [
    "# Generated by Tama Kit from .tama.env. Keep this file private.",
    ...required.map(
      (name) => `${name}=${composeEnvironmentValue(values.get(name) ?? "", name, filename)}`,
    ),
    "",
  ].join("\n");
}

/**
 * @param {string} root
 * @param {number} [requestedPort]
 * @param {McpAppEnvironmentInput | undefined} [mcpApp]
 * @param {boolean} [materializeSecrets]
 * @param {number} [freshDefaultPort]
 * @returns {EnvironmentPlan}
 */
export function planEnvironment(
  root,
  requestedPort,
  mcpApp,
  materializeSecrets = true,
  freshDefaultPort,
) {
  const filename = join(root, ".tama.env");
  if (!existsSync(filename)) {
    const port = requestedPort ?? freshDefaultPort ?? DEFAULTS.port;
    let content = newEnvironment(port, materializeSecrets);
    if (mcpApp) {
      content =
        content +
        `\n${mcpAppHeader(mcpApp.validation.mode)}\n${mcpAppLines(mcpApp.variables).join("\n")}\n`;
    }
    const values = parseEnvironment(content, filename);
    validateEnvironment(values, filename, port);
    if (mcpApp) {
      validateMcpAppVariables(values, filename, mcpApp.validation);
    }
    return {
      port,
      operation: operationForContent(filename, content, {
        sensitive: true,
        mode: 0o600,
      }),
      postgresOperation: operationForContent(
        join(root, ".tama.postgres.env"),
        postgresEnvironment(values, filename),
        { sensitive: true, mode: 0o600 },
      ),
    };
  }

  const original = readFileSync(filename, "utf8");
  const values = parseEnvironment(original, filename);
  const port = resolveEnvironmentPort(root, requestedPort, freshDefaultPort);
  const rawExistingPort = values.get("TAMA_PORT") ?? String(DEFAULTS.port);
  const existingPort = /^\d+$/u.test(rawExistingPort)
    ? Number.parseInt(rawExistingPort, 10)
    : Number.NaN;
  let content = original;
  if (!values.get("TAMA_OAUTH_PRIVATE_JWK") && !values.get("TAMA_OAUTH_PRIVATE_JWK_ID")) {
    const retiredKey = values.get("TAMA_OAUTH_SIGNING_KEY");
    const retiredKeyId = values.get("TAMA_OAUTH_SIGNING_KEY_ID");
    if (Boolean(retiredKey) !== Boolean(retiredKeyId)) {
      throw ownershipError(
        `${filename} has an incomplete retired OAuth signing key pair: ${RETIRED_OAUTH_VARIABLES.join(
          " and ",
        )} must be present together or replaced by TAMA_OAUTH_PRIVATE_JWK and TAMA_OAUTH_PRIVATE_JWK_ID`,
        { path: filename, variables: RETIRED_OAUTH_VARIABLES },
      );
    }
    if (retiredKey) {
      if (!hasManagedMarker(original)) {
        throw ownershipError(
          `${filename} still uses the retired ${RETIRED_OAUTH_VARIABLES.join(
            " and ",
          )} variables but is not a Tama Kit managed file; replace them manually with a valid TAMA_OAUTH_PRIVATE_JWK and TAMA_OAUTH_PRIVATE_JWK_ID pair`,
          { path: filename, variables: RETIRED_OAUTH_VARIABLES },
        );
      }
      content = migrateOAuthKeyPair(original);
    }
  }
  if (requestedPort !== undefined) {
    content = updateEnvironment(content, {
      TAMA_PORT: port,
      TAMA_OAUTH_ISSUER: `http://localhost:${port}`,
      TAMA_MCP_RESOURCE: `http://localhost:${port}/mcp`,
      TAMA_MCP_ALLOWED_ORIGINS: updateAllowedOrigins(
        values.get("TAMA_MCP_ALLOWED_ORIGINS"),
        existingPort,
        port,
      ),
      TAMA_BASE_URL: `http://localhost:${port}`,
    });
  }
  if (mcpApp) {
    content = updateEnvironment(content, mcpApp.variables);
  }
  const updatedValues = parseEnvironment(content, filename);
  validateEnvironment(updatedValues, filename, port);
  if (mcpApp) {
    validateMcpAppVariables(updatedValues, filename, mcpApp.validation);
  }
  return {
    port,
    operation: operationForContent(filename, content, {
      sensitive: true,
      mode: 0o600,
    }),
    postgresOperation: operationForContent(
      join(root, ".tama.postgres.env"),
      postgresEnvironment(updatedValues, filename),
      { sensitive: true, mode: 0o600 },
    ),
  };
}
