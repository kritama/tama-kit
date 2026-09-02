// @ts-check

import { readEnvironmentValues } from "./environment.mjs";

/** @typedef {import("../types.mjs").McpAppPlan} McpAppPlan */
/** @typedef {import("../types.mjs").McpAppVerification} McpAppVerification */
/** @typedef {(input: URL, init?: RequestInit) => Promise<Response>} VerifyFetch */

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const INACTIVE_PROBE_TOKEN = "tama-kit-bootstrap-inactive-probe";
const PROBE_TIMEOUT_MS = 10_000;
const TAMA_INTROSPECTION_KEY_VARIABLE = "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @typedef {import("../types.mjs").McpAppProbe} McpAppProbe */

/** @param {string} name @param {boolean} ok @param {string} [reason] @returns {McpAppProbe} */
function probe(name, ok, reason) {
  return { name, ok, reason: ok ? null : (reason ?? "verification failed") };
}

/**
 * @param {VerifyFetch} fetch
 * @param {string} url
 * @returns {Promise<{response: Response | null, body: Record<string, unknown> | null}>}
 */
async function fetchJson(fetch, url) {
  try {
    const response = await fetch(new URL(url), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { response, body: null };
    }
    const body = /** @type {unknown} */ (await response.json());
    return { response, body: isPlainObject(body) ? body : null };
  } catch {
    return { response: null, body: null };
  }
}

/** @param {Record<string, unknown> | null} jwks @param {string} kid */
function jwksContainsKid(jwks, kid) {
  if (jwks === null || !Array.isArray(jwks.keys)) {
    return false;
  }
  return jwks.keys.some(
    (key) =>
      isPlainObject(key) &&
      key.kid === kid &&
      key.kty === "RSA" &&
      key.alg === "RS256" &&
      typeof key.n === "string" &&
      typeof key.e === "string" &&
      key.d === undefined,
  );
}

/**
 * @param {{
 *   privateJwk: string,
 *   kid: string,
 *   clientId: string,
 *   audience: string,
 * }} input
 * @returns {Promise<string | null>}
 */
async function signClientAssertion({ privateJwk, kid, clientId, audience }) {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(privateJwk);
    if (!isPlainObject(parsed)) {
      return null;
    }
    const key = await globalThis.crypto.subtle.importKey(
      "jwk",
      /** @type {Record<string, unknown>} */ (parsed),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const encoder = new TextEncoder();
    const b64url = (/** @type {ArrayBuffer | Uint8Array} */ input) =>
      Buffer.from(new Uint8Array(input)).toString("base64url");
    const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      encoder.encode(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: audience,
          iat: now,
          exp: now + 300,
          jti: globalThis.crypto.randomUUID(),
        }),
      ),
    );
    const signingInput = `${header}.${payload}`;
    const signature = await globalThis.crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      encoder.encode(signingInput),
    );
    return `${signingInput}.${b64url(signature)}`;
  } catch {
    return null;
  }
}

/**
 * @param {{root: string, plan: McpAppPlan, fetch: VerifyFetch}} input
 * @returns {Promise<McpAppProbe>}
 */
async function introspectInactiveToken({ root, plan, fetch }) {
  const endpoint = `${plan.providerOrigin}/auth/introspections`;
  const assertion = await signClientAssertion({
    privateJwk: readEnvironmentValues(root, ".tama.env").get(TAMA_INTROSPECTION_KEY_VARIABLE) ?? "",
    kid: plan.introspectionSigningKeyId,
    clientId: plan.introspectionClientId,
    audience: endpoint,
  });
  if (assertion === null) {
    return probe("inactive_introspection", false, "could not sign the client assertion");
  }
  try {
    const response = await fetch(new URL(endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        token: INACTIVE_PROBE_TOKEN,
        client_assertion: assertion,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
      }).toString(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return probe("inactive_introspection", false, `provider returned HTTP ${response.status}`);
    }
    const body = /** @type {unknown} */ (await response.json());
    return probe(
      "inactive_introspection",
      isPlainObject(body) && body.active === false,
      "provider did not return an inactive token response",
    );
  } catch {
    return probe("inactive_introspection", false, "provider introspection was unreachable");
  }
}

/** @param {VerifyFetch} fetch @param {string} url @returns {Promise<McpAppProbe>} */
async function routeProbe(fetch, url) {
  try {
    const response = await fetch(new URL(url), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const available = response.status !== 404 && response.status !== 503 && response.status < 500;
    return probe("tama_resource_route", available, `Tama returned HTTP ${response.status}`);
  } catch {
    return probe("tama_resource_route", false, "Tama MCP App route was unreachable");
  }
}

/**
 * Verifies a running MCP App integration: the provider publishes its access
 * token key, Tama publishes the introspection key, and Tama's authenticated
 * inactive-token introspection is rejected by the provider exactly as an
 * inactive token must be. All probes are read-only; nothing is activated or
 * mutated here.
 *
 * @param {{root: string, plan: McpAppPlan, fetch: VerifyFetch}} input
 * @returns {Promise<McpAppVerification>}
 */
export async function verifyMcpApp({ root, plan, fetch }) {
  /** @type {McpAppProbe[]} */
  const probes = [];
  const metadataUrl = `${plan.providerOrigin}/.well-known/oauth-authorization-server`;
  const providerMetadata = await fetchJson(fetch, metadataUrl);
  const metadataValid =
    providerMetadata.body?.issuer === plan.providerOrigin &&
    providerMetadata.body?.jwks_uri === `${plan.providerOrigin}/.well-known/jwks.json`;
  probes.push(
    probe(
      "provider_metadata",
      metadataValid,
      providerMetadata.response
        ? `provider metadata did not match the exact issuer and JWKS URI (HTTP ${providerMetadata.response.status})`
        : "provider metadata was unreachable",
    ),
  );

  const providerJwksResult = await fetchJson(fetch, `${plan.providerOrigin}/.well-known/jwks.json`);
  const providerReachable = jwksContainsKid(providerJwksResult.body, plan.providerSigningKeyId);
  probes.push(
    probe(
      "provider_jwks",
      providerReachable,
      "provider JWKS did not contain the expected public RS256 key",
    ),
  );

  const tamaJwksResult = await fetchJson(fetch, `${plan.tamaOrigin}/.well-known/jwks.json`);
  const tamaReachable = jwksContainsKid(tamaJwksResult.body, plan.introspectionSigningKeyId);
  probes.push(
    probe(
      "tama_jwks",
      tamaReachable,
      "Tama JWKS did not contain the expected public RS256 introspection key",
    ),
  );

  if (providerReachable && tamaReachable) {
    probes.push(await introspectInactiveToken({ root, plan, fetch }));
  } else {
    probes.push(
      probe("inactive_introspection", false, "required provider and Tama keys were not verified"),
    );
  }

  if (plan.lifecycle === "enabled") {
    const protectedMetadata = await fetchJson(
      fetch,
      `${plan.tamaOrigin}/.well-known/oauth-protected-resource/mcp/app`,
    );
    const authorizationServers = protectedMetadata.body?.authorization_servers;
    const protectedMetadataValid =
      protectedMetadata.body?.resource === plan.resource &&
      Array.isArray(authorizationServers) &&
      authorizationServers.length === 1 &&
      authorizationServers[0] === plan.providerOrigin;
    probes.push(
      probe(
        "tama_protected_resource_metadata",
        protectedMetadataValid,
        "Tama protected-resource metadata did not advertise the exact resource and provider",
      ),
    );
    probes.push(await routeProbe(fetch, plan.resource));
    if (plan.providerLifecycle === "enabled") {
      const protectedResources = providerMetadata.body?.protected_resources;
      probes.push(
        probe(
          "provider_resource_advertisement",
          Array.isArray(protectedResources) &&
            protectedResources.length === 1 &&
            protectedResources[0] === plan.resource,
          "provider metadata did not advertise the exact Tama resource",
        ),
      );
    }
  }

  return {
    mode: plan.lifecycle,
    probes,
    providerReachable,
    tamaReachable,
    verified: probes.every((entry) => entry.ok),
  };
}
