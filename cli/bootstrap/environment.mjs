// @ts-check

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";
import { DEFAULTS } from "./constants.mjs";

/** @typedef {import("../types.mjs").EnvironmentPlan} EnvironmentPlan */

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
  "TAMA_OAUTH_SIGNING_KEY",
  "TAMA_OAUTH_SIGNING_KEY_ID",
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
      values.set(match[1], match[2]);
    }
  }
  if (duplicates.size > 0) {
    const names = [...duplicates].sort();
    throw ownershipError(`${filename} contains duplicate environment variables: ${names.join(", ")}`, {
      path: filename,
      variables: names,
    });
  }
  return values;
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

/** @param {Map<string, string>} values @param {string} filename @param {number} port */
function validateEnvironment(values, filename, port) {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !values.get(name));
  if (missing.length > 0) {
    throw ownershipError(
      `${filename} must define non-empty runtime variables: ${missing.join(", ")}`,
      { path: filename, variables: missing },
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

/** @param {number} port */
function newEnvironment(port) {
  const postgresPassword = token(24);
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
    `SECRET_KEY_BASE=${token(48)}`,
    `TAMA_VAULT_KEY=${randomBytes(32).toString("base64")}`,
    `TAMA_JWT_SECRET=${token(32)}`,
    `TAMA_OAUTH_SIGNING_KEY=${token(32)}`,
    "TAMA_OAUTH_SIGNING_KEY_ID=oauth-local-1",
    `TAMA_SETUP_TOKEN=${token(24)}`,
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

/** @param {Map<string, string>} values */
function postgresEnvironment(values) {
  const required = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"];
  for (const name of required) {
    if (!values.get(name)) {
      throw new Error(`.tama.env must define a non-empty ${name}`);
    }
  }
  return [
    "# Generated by Tama Kit from .tama.env. Keep this file private.",
    ...required.map((name) => `${name}=${values.get(name)}`),
    "",
  ].join("\n");
}

/** @param {string} root @param {number} [requestedPort] @returns {EnvironmentPlan} */
export function planEnvironment(root, requestedPort) {
  const filename = join(root, ".tama.env");
  if (!existsSync(filename)) {
    const port = requestedPort ?? DEFAULTS.port;
    const content = newEnvironment(port);
    const values = parseEnvironment(content, filename);
    validateEnvironment(values, filename, port);
    return {
      port,
      operation: operationForContent(filename, content, {
        sensitive: true,
        mode: 0o600,
      }),
      postgresOperation: operationForContent(
        join(root, ".tama.postgres.env"),
        postgresEnvironment(values),
        { sensitive: true, mode: 0o600 },
      ),
    };
  }

  const original = readFileSync(filename, "utf8");
  const values = parseEnvironment(original, filename);
  const rawExistingPort = values.get("TAMA_PORT") ?? String(DEFAULTS.port);
  const existingPort = /^\d+$/u.test(rawExistingPort)
    ? Number.parseInt(rawExistingPort, 10)
    : Number.NaN;
  if (!Number.isInteger(existingPort) || existingPort < 1 || existingPort > 65_535) {
    throw ownershipError(`.tama.env has an invalid TAMA_PORT: ${rawExistingPort}`);
  }
  const port = requestedPort ?? existingPort;
  const content =
    requestedPort === undefined
      ? original
      : updateEnvironment(original, {
          TAMA_PORT: port,
          TAMA_OAUTH_ISSUER: `http://localhost:${port}`,
          TAMA_MCP_RESOURCE: `http://localhost:${port}/mcp`,
          TAMA_MCP_ALLOWED_ORIGINS: `http://localhost:${port}`,
          TAMA_BASE_URL: `http://localhost:${port}`,
        });
  const updatedValues = parseEnvironment(content, filename);
  validateEnvironment(updatedValues, filename, port);
  return {
    port,
    operation: operationForContent(filename, content, {
      sensitive: true,
      mode: 0o600,
    }),
    postgresOperation: operationForContent(
      join(root, ".tama.postgres.env"),
      postgresEnvironment(updatedValues),
      { sensitive: true, mode: 0o600 },
    ),
  };
}
