import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { readMcpAppProvider } from "../../cli/bootstrap/manifest.mjs";
import { prepareMcpApp } from "../../cli/bootstrap/mcp-app.mjs";
import { validateMcpAppContract } from "../../cli/bootstrap/mcp-app-contract.mjs";
import { verifyMcpApp as verifyMcpAppImplementation } from "../../cli/bootstrap/mcp-app-verify.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { run } from "../../cli/index.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import { temporaryDirectory } from "./temporary.mjs";

/** @param {Parameters<typeof verifyMcpAppImplementation>[0]} input */
export function verifyMcpApp(input) {
  return verifyMcpAppImplementation({
    probeProviderFromContainer: async () => true,
    ...input,
  });
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function command(root, args) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(args, {
    cwd: root,
    interactive: false,
    color: false,
    columns: 100,
    write: () => {},
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

export function project(prefix = "tama-kit-mcp-app-") {
  return temporaryDirectory(prefix);
}

export function memoveeContract(overrides = {}) {
  const bindings = {
    mode: "MEMOVEE_TAMA_MCP_APP_MODE",
    issuer: "MEMOVEE_OAUTH_ISSUER",
    resource: "MEMOVEE_TAMA_MCP_APP_RESOURCE",
    access_token_signing_algorithm: "MEMOVEE_OAUTH_SIGNING_ALGORITHM",
    access_token_signing_key_id: "MEMOVEE_OAUTH_SIGNING_KEY_ID",
    access_token_private_signing_key: "MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY",
    access_token_public_overlap_keys: "MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS",
    introspection_client_id: "MEMOVEE_TAMA_INTROSPECTION_CLIENT_ID",
    introspection_jwks_uri: "MEMOVEE_TAMA_INTROSPECTION_JWKS_URI",
  };
  return {
    schema_version: "1",
    compatibility_identifier: "tama-mcp-app-bootstrap-v1",
    supported_memovee_versions: ">= 0.1.1 and < 0.2.0",
    lifecycle: {
      default_production_mode: "disabled",
      modes: ["disabled", "prepared", "enabled"],
      configured_modes: ["prepared", "enabled"],
      enabled_modes: ["enabled"],
    },
    provider: {
      name: "memovee",
      environment_prefix: "MEMOVEE",
      environment_file: "tama/.memovee.integration.env",
    },
    bindings,
    environment_loading: {
      mechanism: "direnv",
      loader: ".envrc",
      loads: "tama/.memovee.integration.env",
    },
    variables: {
      [bindings.mode]: {
        required: false,
        values: ["disabled", "prepared", "enabled"],
        "x-sensitive": false,
      },
      [bindings.issuer]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-origin",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.resource]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-uri",
        exact_path: "/mcp/app",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.access_token_signing_algorithm]: {
        required_in: ["prepared", "enabled"],
        initial_value: "RS256",
        allowed_values: ["RS256", "PS256", "ES256"],
        "x-sensitive": false,
      },
      [bindings.access_token_signing_key_id]: {
        required_in: ["prepared", "enabled"],
        format: "bounded-identifier",
        max_bytes: 128,
        "x-sensitive": false,
      },
      [bindings.access_token_private_signing_key]: {
        required_in: ["prepared", "enabled"],
        format: "private-json-jwk",
        max_bytes: 65536,
        "x-sensitive": true,
      },
      [bindings.access_token_public_overlap_keys]: {
        required: false,
        default: "[]",
        format: "public-json-jwk-array",
        max_bytes: 2097152,
        max_items: 30,
        "x-sensitive": false,
      },
      [bindings.introspection_client_id]: {
        required_in: ["prepared", "enabled"],
        format: "bounded-identifier",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.introspection_jwks_uri]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-uri",
        exact_path: "/.well-known/jwks.json",
        same_origin_as: bindings.resource,
        max_bytes: 2048,
        "x-sensitive": false,
      },
    },
    public_endpoints: {
      authorization_server_metadata: "/.well-known/oauth-authorization-server",
      jwks: "/.well-known/jwks.json",
      introspection: "/auth/introspections",
    },
    availability: {
      disabled: { metadata: false, jwks: false, introspection: false },
      prepared: { metadata: true, jwks: true, introspection: true },
      enabled: { metadata: true, jwks: true, introspection: true },
    },
    local_development: {
      memovee_origin: "http://host.docker.internal:4000",
      tama_origin: "http://127.0.0.1:4001",
      resource: "http://127.0.0.1:4001/mcp/app",
    },
    local_loopback: {
      allowed_environments: ["dev", "test"],
      hosts: ["127.0.0.1", "localhost", "::1"],
    },
    ...overrides,
  };
}

/** @returns {Record<string, unknown>} */
export function validContract() {
  return validateMcpAppContract(memoveeContract());
}

export function writeContract(root, document = memoveeContract()) {
  const directory = join(root, "priv", "contracts");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "tama-mcp-app-bootstrap-v1.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

export const MEMOVEE = {
  name: "memovee",
  environmentPrefix: "MEMOVEE",
  environmentFile: "tama/.memovee.integration.env",
};

/**
 * @param {string} root
 * @param {{
 *   contractPath?: string | null,
 *   contractDocument?: Record<string, unknown> | null,
 *   identity?: {
 *     name: string,
 *     environmentPrefix: string,
 *     environmentFile: string,
 *     source: "manifest" | "contract" | "flags" | "framework" | "git" | "directory",
 *   },
 * }} [extra]
 */
export function preparedFor(root, extra = {}) {
  return {
    identity: extra.identity ?? { ...MEMOVEE, source: "flags" },
    persisted: readMcpAppProvider(join(root, "tama")),
    contractPath: extra.contractPath ?? null,
    contractDocument: extra.contractDocument ?? null,
    allowedOrigins: ["http://127.0.0.1:3000"],
  };
}

// The MCP App integration requires a pinned Tama image, so every planned
// integration in the suite uses one inside the bundled supported range.
export const PINNED_TAMA_IMAGE = "ghcr.io/upmaru/tama:0.13.2-server";

/**
 * @param {string} root
 * @param {ReturnType<typeof preparedFor>} prepared
 * @param {Record<string, unknown>} [mcpApp]
 */
export function planWithMcp(root, prepared, mcpApp = {}) {
  return createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: PINNED_TAMA_IMAGE,
    port: existsSync(join(root, "tama", ".tama.env")) ? undefined : 4001,
    mcpApp: {
      requested: true,
      activate: false,
      allowedOrigins: prepared.allowedOrigins,
      ...mcpApp,
    },
    mcpAppPrepared: prepared,
  });
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} [options]
 * @param {{nonInteractive?: boolean, prompt?: (question: string) => Promise<string>}} [io]
 */
export async function prepareFor(root, options = {}, io = {}) {
  return prepareMcpApp({
    root,
    tamaDirectory: join(root, "tama"),
    framework: "generic",
    options: {
      requested: true,
      activate: false,
      allowedOrigins: ["http://127.0.0.1:3000"],
      ...options,
    },
    nonInteractive: io.nonInteractive ?? false,
    io: { prompt: io.prompt ?? (async () => ""), stderr: () => {} },
  });
}

/**
 * Builds a JWKS document publishing the public members of a private JWK
 * under `kid`, or a placeholder key when no JWK is supplied.
 *
 * @param {string} kid
 * @param {string} [privateJwk]
 * @returns {Record<string, unknown>}
 */
export function jwksDocument(kid, privateJwk) {
  const key = privateJwk === undefined ? { n: "AQAB", e: "AQAB" } : JSON.parse(privateJwk);
  return { keys: [{ kid, kty: "RSA", alg: "RS256", n: key.n, e: key.e }] };
}

/** @param {NonNullable<ReturnType<typeof planWithMcp>["mcpApp"]>} plan */
export function providerMetadata(plan) {
  return {
    issuer: plan.providerOrigin,
    jwks_uri: `${plan.providerOrigin}/.well-known/jwks.json`,
  };
}

export const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

/**
 * Keeps the container-reachability probe out of the deterministic
 * verification tests: "unknown" skips the probe exactly like a non-Linux
 * host would.
 */
export const noContainerInspection = async () => "unknown";

/**
 * Wraps a fake fetch so the provider's introspection endpoint enforces client
 * authentication the way a real provider must: a client assertion that is not
 * a signed JWT is rejected with HTTP 400.
 *
/**
 * @param {{root: string, plan: import("../../cli/types.mjs").McpAppPlan}} context
 * @param {string | null} assertion
 * @returns {Promise<boolean>}
 */
export async function clientAssertionIsValid({ root, plan }, assertion) {
  if (typeof assertion !== "string" || !JWT_PATTERN.test(assertion)) {
    return false;
  }
  const [header, payload, signature] = assertion.split(".");
  /** @type {Record<string, unknown> | null} */
  let headerJson = null;
  /** @type {Record<string, unknown> | null} */
  let payloadJson = null;
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const parsedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsedHeader !== "object" || parsedHeader === null) {
      return false;
    }
    if (typeof parsedPayload !== "object" || parsedPayload === null) {
      return false;
    }
    headerJson = parsedHeader;
    payloadJson = parsedPayload;
  } catch {
    return false;
  }
  if (headerJson.alg !== "RS256" || headerJson.kid !== plan.introspectionSigningKeyId) {
    return false;
  }
  if (payloadJson.aud !== `${plan.providerOrigin}/auth/introspections`) {
    return false;
  }
  const tamaJwk = parseEnv(
    readFileSync(join(root, "tama", ".tama.env"), "utf8"),
  ).TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY;
  if (typeof tamaJwk !== "string") {
    return false;
  }
  try {
    const jwk = /** @type {Record<string, string>} */ (JSON.parse(tamaJwk));
    const key = await globalThis.crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array(Buffer.from(signature, "base64url")),
      new TextEncoder().encode(`${header}.${payload}`),
    );
  } catch {
    return false;
  }
}

/**
 * Wraps a fake provider fetch so its introspection endpoint enforces real
 * client authentication the way a compliant provider must: the assertion must
 * be a valid RS256 JWT for the expected key and audience.
 *
 * @param {(input: URL, init?: RequestInit) => Promise<Response>} fetch
 * @param {string} root
 * @param {import("../../cli/types.mjs").McpAppPlan} plan
 */
export function enforcingIntrospection(fetch, root, plan) {
  return async (input, init) => {
    if (/** @type {URL} */ (input).href.endsWith("/auth/introspections")) {
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("client_assertion");
      if (!(await clientAssertionIsValid({ root, plan }, assertion))) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return fetch(input, init);
  };
}

/** @returns {Promise<{root: string, plan: NonNullable<ReturnType<typeof planWithMcp>["mcpApp"]>, providerJwk: string, tamaJwk: string}>} */
export async function buildVerifiedRoot() {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const plan = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  applyOperations(plan.operations);
  const mcp = plan.mcpApp;
  assert.ok(mcp);
  const fragment = parseEnv(readFileSync(join(root, mcp.provider.environmentFile), "utf8"));
  const tamaValues = parseEnv(readFileSync(join(root, "tama", ".tama.env"), "utf8"));
  const providerJwk = fragment[mcp.bindings.roles.access_token_private_signing_key];
  const tamaJwk = tamaValues.TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY;
  assert.equal(typeof providerJwk, "string");
  assert.equal(typeof tamaJwk, "string");
  return {
    root,
    plan: mcp,
    providerJwk: /** @type {string} */ (providerJwk),
    tamaJwk: /** @type {string} */ (tamaJwk),
  };
}
