// @ts-check

import { readFile } from "node:fs/promises";
import { readEnvironmentValues } from "./environment.mjs";

/** @typedef {import("../types.mjs").McpAppPlan} McpAppPlan */
/** @typedef {import("../types.mjs").McpAppVerification} McpAppVerification */
/** @typedef {(input: URL, init?: RequestInit) => Promise<Response>} VerifyFetch */
/** @typedef {() => Promise<"wide" | "loopback-only" | "unknown">} ProviderListenerInspector */

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const INACTIVE_PROBE_TOKEN = "tama-kit-bootstrap-inactive-probe";
const NEGATIVE_CONTROL_CLIENT_ASSERTION = "tama-kit-bootstrap-negative-control-invalid-assertion";
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

/**
 * Verification probes are issued from the host, where the Compose
 * host-gateway name does not resolve. Maps it to the loopback transport the
 * host-native provider listens on. The advertised issuer is still validated
 * against the plan, so a transport serving a different origin cannot pass.
 *
 * @param {string} origin
 * @returns {string}
 */
function hostTransportOrigin(origin) {
  const url = new URL(origin);
  if (url.hostname === "host.docker.internal") {
    url.hostname = "127.0.0.1";
  }
  return `${url.protocol}//${url.host}`;
}

/** @param {string} origin @returns {boolean} */
function isHostGatewayOrigin(origin) {
  try {
    return new URL(origin).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Classifies one /proc/net/tcp{,6} local address as a wildcard bind (reachable
 * from the Docker bridge), a loopback bind (never reachable from the
 * container), or a specific interface bind (ambiguous without knowing the
 * bridge IP).
 *
 * @param {string} addressHex
 * @param {"v4" | "v6"} family
 * @returns {"wide" | "loopback" | "specific"}
 */
function classifyListenerAddress(addressHex, family) {
  if (family === "v4") {
    // Little-endian byte order: 127.0.0.1 is 0100007F, 0.0.0.0 is 00000000.
    if (addressHex === "00000000") {
      return "wide";
    }
    return Number.parseInt(addressHex.slice(6, 8), 16) === 127 ? "loopback" : "specific";
  }
  // Four little-endian 32-bit groups: :: is all zeros, ::1 ends in 01000000.
  if (/^0{32}$/u.test(addressHex)) {
    return "wide";
  }
  return addressHex.slice(24, 32) === "01000000" ? "loopback" : "specific";
}

/**
 * Inspects the host's listening sockets for one port through /proc/net/tcp
 * and /proc/net/tcp6 (Linux). Reports "wide" when a wildcard bind can answer
 * the Docker bridge, "loopback-only" when only loopback listeners exist, and
 * "unknown" when the answer cannot be determined (other platforms, missing
 * or unreadable sockets, no listener on the port, or only specific-interface
 * binds).
 *
 * @param {number} port
 * @returns {Promise<"wide" | "loopback-only" | "unknown">}
 */
async function defaultProviderListenerInspector(port) {
  if (process.platform !== "linux") {
    return "unknown";
  }
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  /** @type {Array<"wide" | "loopback" | "specific">} */
  const listeners = [];
  /** @type {Array<[string, "v4" | "v6"]>} */
  const socketTables = [
    ["/proc/net/tcp", "v4"],
    ["/proc/net/tcp6", "v6"],
  ];
  for (const [path, family] of socketTables) {
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return "unknown";
    }
    for (const line of content.split(/\r?\n/u)) {
      const columns = line.trim().split(/\s+/u);
      if (columns.length < 4 || columns[3] !== "0A") {
        continue;
      }
      const [addressHex, portHex] = columns[1].split(":");
      if (portHex === hexPort) {
        listeners.push(classifyListenerAddress(addressHex, family));
      }
    }
  }
  if (listeners.length === 0) {
    return "unknown";
  }
  if (listeners.includes("wide")) {
    return "wide";
  }
  if (!listeners.includes("specific")) {
    return "loopback-only";
  }
  return "unknown";
}

/** @param {unknown} value @returns {bigint | null} */
function base64urlUnsigned(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0) {
    return null;
  }
  const integer = BigInt(`0x${bytes.toString("hex")}`);
  return integer > 0n ? integer : null;
}

/** @type {readonly string[]} */
const JWK_PRIVATE_MEMBERS = Object.freeze(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

/** @typedef {{n: string | null, e: string | null}} ExpectedPublicMembers */

/**
 * Reads the persisted private JWK for one side of the integration and
 * extracts the public members the live JWKS must publish under the expected
 * identifier. A missing or invalid value yields null members so the JWKS
 * probe fails with an actionable reason instead of accepting unchecked key
 * material.
 *
 * @param {string} root
 * @param {string} filename
 * @param {string} variable
 * @returns {ExpectedPublicMembers}
 */
function expectedPublicMembers(root, filename, variable) {
  const encoded = readEnvironmentValues(root, filename).get(variable);
  if (typeof encoded !== "string" || encoded.length === 0) {
    return { n: null, e: null };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return { n: null, e: null };
  }
  if (!isPlainObject(parsed) || typeof parsed.n !== "string" || typeof parsed.e !== "string") {
    return { n: null, e: null };
  }
  return { n: parsed.n, e: parsed.e };
}

/** @param {Record<string, unknown> | null} jwks @param {string} kid */
function jwksHasKid(jwks, kid) {
  if (jwks === null || !Array.isArray(jwks.keys)) {
    return false;
  }
  return jwks.keys.some((key) => isPlainObject(key) && key.kid === kid);
}

/**
 * Reports whether a JWKS publishes the exact public key the integration
 * plans from the persisted private JWK: an RSA signing member with the
 * expected identifier whose modulus and exponent match the expected key
 * material, whose compatible RS256 metadata is not contradicted, and that
 * carries no private members. Key material is compared, not only metadata,
 * so a stale or misloaded key published under the expected identifier cannot
 * pass verification.
 *
 * @param {Record<string, unknown> | null} jwks
 * @param {string} kid
 * @param {ExpectedPublicMembers} expected
 * @returns {boolean}
 */
function jwksPublishesExpectedKey(jwks, kid, expected) {
  const expectedModulus = base64urlUnsigned(expected.n);
  const expectedExponent = base64urlUnsigned(expected.e);
  if (jwks === null || !Array.isArray(jwks.keys)) {
    return false;
  }
  if (expectedModulus === null || expectedExponent === null) {
    return false;
  }
  return jwks.keys.some((key) => {
    if (!isPlainObject(key) || key.kid !== kid) {
      return false;
    }
    if (JWK_PRIVATE_MEMBERS.some((name) => key[name] !== undefined)) {
      return false;
    }
    if (key.kty !== "RSA") {
      return false;
    }
    if (key.alg !== undefined && key.alg !== "RS256") {
      return false;
    }
    if (key.use !== undefined && key.use !== "sig") {
      return false;
    }
    const modulus = typeof key.n === "string" ? base64urlUnsigned(key.n) : null;
    const exponent = typeof key.e === "string" ? base64urlUnsigned(key.e) : null;
    return modulus === expectedModulus && exponent === expectedExponent;
  });
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
  // The request travels over the host-resolvable transport, but the client
  // assertion names the advertised endpoint the provider validates.
  const endpoint = `${hostTransportOrigin(plan.providerOrigin)}/auth/introspections`;
  const assertion = await signClientAssertion({
    privateJwk: readEnvironmentValues(root, ".tama.env").get(TAMA_INTROSPECTION_KEY_VARIABLE) ?? "",
    kid: plan.introspectionSigningKeyId,
    clientId: plan.introspectionClientId,
    audience: `${plan.providerOrigin}/auth/introspections`,
  });
  if (assertion === null) {
    return probe("inactive_introspection", false, "could not sign the client assertion");
  }
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  try {
    // Negative control: a deliberately invalid client assertion must be
    // rejected. An endpoint that answers it anyway is not enforcing client
    // authentication, so the authenticated result below could prove nothing.
    const control = await fetch(new URL(endpoint), {
      method: "POST",
      headers,
      body: new URLSearchParams({
        token: INACTIVE_PROBE_TOKEN,
        client_assertion: NEGATIVE_CONTROL_CLIENT_ASSERTION,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
      }).toString(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (control.ok) {
      return probe(
        "inactive_introspection",
        false,
        `provider accepted an invalid client assertion (HTTP ${control.status}); the ` +
          `introspection endpoint does not enforce client authentication`,
      );
    }
    const response = await fetch(new URL(endpoint), {
      method: "POST",
      headers,
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

/**
 * The protected route must reject this deliberately anonymous request: a 200
 * means /mcp/app is publicly accessible and its OAuth enforcement is missing.
 *
 * @param {VerifyFetch} fetch
 * @param {string} url
 * @returns {Promise<McpAppProbe>}
 */
async function routeProbe(fetch, url) {
  try {
    const response = await fetch(new URL(url), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const rejectsAnonymous = response.status === 401 || response.status === 403;
    return probe(
      "tama_resource_route",
      rejectsAnonymous,
      `Tama returned HTTP ${response.status}; the protected route must reject anonymous requests with 401 or 403`,
    );
  } catch {
    return probe("tama_resource_route", false, "Tama MCP App route was unreachable");
  }
}

/**
 * Verifies a running MCP App integration: the provider publishes the exact
 * access-token key the bootstrap planned from the persisted private JWK,
 * Tama publishes the exact introspection key, the provider rejects a
 * deliberately invalid client assertion (negative control) and then answers
 * Tama's authenticated inactive-token introspection exactly as an inactive
 * token must be, and (in enabled mode) the protected route rejects anonymous
 * requests. In the host-gateway topology, the host's listening sockets are
 * additionally inspected so a loopback-only provider bind — invisible to the
 * host-resolvable probes but unreachable from the Tama container — fails
 * verification. Provider probes travel over a host-resolvable transport while
 * the advertised issuer is still validated. All probes are read-only; nothing
 * is activated or mutated here.
 *
 * @param {{root: string, plan: McpAppPlan, fetch: VerifyFetch, inspectProviderListener?: ProviderListenerInspector}} input
 * @returns {Promise<McpAppVerification>}
 */
export async function verifyMcpApp({ root, plan, fetch, inspectProviderListener }) {
  /** @type {McpAppProbe[]} */
  const probes = [];
  // Provider probes travel over the host-resolvable transport; the metadata
  // check still requires the advertised issuer to match the plan exactly.
  const providerTransport = hostTransportOrigin(plan.providerOrigin);
  const metadataUrl = `${providerTransport}/.well-known/oauth-authorization-server`;
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

  const providerKey = expectedPublicMembers(
    root,
    plan.provider.environmentFile,
    plan.bindings.roles.access_token_private_signing_key,
  );
  const providerJwksResult = await fetchJson(fetch, `${providerTransport}/.well-known/jwks.json`);
  const providerReachable = jwksPublishesExpectedKey(
    providerJwksResult.body,
    plan.providerSigningKeyId,
    providerKey,
  );
  probes.push(
    probe(
      "provider_jwks",
      providerReachable,
      providerJwksResult.response === null
        ? "provider JWKS was unreachable"
        : !providerJwksResult.response.ok
          ? `provider JWKS returned HTTP ${providerJwksResult.response.status}`
          : providerKey.n === null || providerKey.e === null
            ? `could not read the expected provider public key from ${plan.provider.environmentFile}`
            : jwksHasKid(providerJwksResult.body, plan.providerSigningKeyId)
              ? "provider JWKS publishes a different key under the expected identifier"
              : "provider JWKS did not contain the expected key identifier",
    ),
  );

  const tamaKey = expectedPublicMembers(root, ".tama.env", TAMA_INTROSPECTION_KEY_VARIABLE);
  const tamaJwksResult = await fetchJson(fetch, `${plan.tamaOrigin}/.well-known/jwks.json`);
  const tamaReachable = jwksPublishesExpectedKey(
    tamaJwksResult.body,
    plan.introspectionSigningKeyId,
    tamaKey,
  );
  probes.push(
    probe(
      "tama_jwks",
      tamaReachable,
      tamaJwksResult.response === null
        ? "Tama JWKS was unreachable"
        : !tamaJwksResult.response.ok
          ? `Tama JWKS returned HTTP ${tamaJwksResult.response.status}`
          : tamaKey.n === null || tamaKey.e === null
            ? `could not read the expected Tama public key from .tama.env`
            : jwksHasKid(tamaJwksResult.body, plan.introspectionSigningKeyId)
              ? "Tama JWKS publishes a different introspection key under the expected identifier"
              : "Tama JWKS did not contain the expected key identifier",
    ),
  );

  if (providerReachable && tamaReachable) {
    probes.push(await introspectInactiveToken({ root, plan, fetch }));
  } else {
    probes.push(
      probe("inactive_introspection", false, "required provider and Tama keys were not verified"),
    );
  }

  // The host-resolvable probes cannot see the container's view of the
  // provider: a bind that is loopback-only on the host passes every host
  // probe yet is unreachable from the Tama container through the
  // host-gateway address.
  if (providerReachable && tamaReachable && isHostGatewayOrigin(plan.providerOrigin)) {
    const providerPort = new URL(plan.providerOrigin).port;
    const inspection = await (
      inspectProviderListener ?? (() => defaultProviderListenerInspector(Number(providerPort)))
    )();
    if (inspection !== "unknown") {
      probes.push(
        probe(
          "provider_container_reachability",
          inspection === "wide",
          "the provider listens only on loopback, so the Tama container cannot reach it " +
            "through the host.docker.internal gateway; bind the provider to 0.0.0.0 (or the " +
            "Docker bridge interface) and rerun",
        ),
      );
    }
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
