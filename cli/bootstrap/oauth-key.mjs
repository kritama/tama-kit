// @ts-check

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

import { ownershipError } from "../errors.mjs";

export const OAUTH_JWK_ALGORITHM = "RS256";
export const OAUTH_JWK_MODULUS_BITS = 3_072;
export const OAUTH_JWK_MIN_MODULUS_BITS = 2_048;
export const OAUTH_JWK_MAX_ENCODED_BYTES = 65_536;
export const OAUTH_JWK_MAX_KID_BYTES = 128;

/**
 * @typedef {object} OAuthPrivateJwk
 * @property {string} jwk
 * @property {string} kid
 */

/**
 * Generates the asymmetric System OAuth signing key pair.
 *
 * The result is a single-line private JWK with normalized RS256 signing
 * metadata and a `kid` derived from the RFC 7638 thumbprint of the public
 * key. This function is side-effect-free outside of cryptographic randomness.
 *
 * @returns {OAuthPrivateJwk}
 */
export function generateOAuthPrivateJwk() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: OAUTH_JWK_MODULUS_BITS,
    publicExponent: 0x10001,
  });
  const privateJwk = /** @type {Record<string, string>} */ (privateKey.export({ format: "jwk" }));
  const publicJwk = /** @type {Record<string, string>} */ (publicKey.export({ format: "jwk" }));
  const canonical = JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n });
  const thumbprint = createHash("sha256").update(canonical, "utf8").digest("base64url");
  const kid = `oauth-${thumbprint}`;
  const jwk = JSON.stringify({
    alg: OAUTH_JWK_ALGORITHM,
    kid,
    kty: "RSA",
    use: "sig",
    n: privateJwk.n,
    e: privateJwk.e,
    d: privateJwk.d,
    p: privateJwk.p,
    q: privateJwk.q,
    dp: privateJwk.dp,
    dq: privateJwk.dq,
    qi: privateJwk.qi,
  });
  return { jwk, kid };
}

/**
 * Validates a persisted System OAuth private JWK against the identifier that
 * Tama will configure for it.
 *
 * Acceptance stays aligned with the Tama OAuth signing-key contract: optional
 * `alg`, `use`, and `kid` metadata may be absent or null, JSON member order is
 * irrelevant, and an externally supplied `kid` need not be a thumbprint. The
 * JWK must carry the complete private RSA parameters (`d`, `p`, `q`, `dp`,
 * `dq`, `qi`), and those parameters must be arithmetically consistent with the
 * advertised `n` and `e` (`n = p*q`, CRT exponents, and `e*d ≡ 1 (mod λ(n))`);
 * supported Node versions can import a JWK whose public and private members
 * come from different keys, so the KeyObject sign/derive check alone is not
 * sufficient. Every failure is bounded and names the variables without
 * quoting their values.
 *
 * @param {string} encodedJwk
 * @param {string} kid
 */
export function validateOAuthPrivateJwk(encodedJwk, kid) {
  if (
    typeof encodedJwk !== "string" ||
    Buffer.byteLength(encodedJwk, "utf8") < 1 ||
    Buffer.byteLength(encodedJwk, "utf8") > OAUTH_JWK_MAX_ENCODED_BYTES
  ) {
    throw invalidJwkError();
  }
  if (!isBoundedKid(kid)) {
    throw invalidKidError();
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(encodedJwk);
  } catch {
    throw invalidJwkError();
  }
  if (!isPlainObject(parsed) || Array.isArray(parsed.keys)) {
    throw invalidJwkError();
  }

  if (parsed.kty !== "RSA") {
    throw invalidJwkError();
  }
  if (typeof parsed.d !== "string" || parsed.d === "") {
    throw invalidJwkError();
  }
  if (!isCompatibleMetadata(parsed.alg, OAUTH_JWK_ALGORITHM)) {
    throw invalidJwkError();
  }
  if (!isCompatibleMetadata(parsed.use, "sig")) {
    throw invalidJwkError();
  }
  if (parsed.kid !== undefined && parsed.kid !== null && parsed.kid !== kid) {
    throw mismatchedKidError();
  }
  if (!isSigningKeyOps(parsed.key_ops)) {
    throw invalidJwkError();
  }

  let keyObject;
  try {
    keyObject = createPrivateKey({ key: parsed, format: "jwk" });
  } catch {
    throw invalidJwkError();
  }
  if (keyObject.asymmetricKeyType !== "rsa") {
    throw invalidJwkError();
  }

  const modulus = base64urlUnsigned(parsed.n);
  const exponent = base64urlUnsigned(parsed.e);
  if (modulus === null || bigintBitLength(modulus) < OAUTH_JWK_MIN_MODULUS_BITS) {
    throw invalidJwkError();
  }
  if (exponent === null || exponent < 3n || exponent % 2n === 0n || exponent >= modulus) {
    throw invalidJwkError();
  }

  // The KeyObject import on supported Node versions can preserve supplied
  // public members instead of deriving them, so consistency between the
  // advertised modulus and the private CRT parameters is proven with
  // independent arithmetic before any key material is trusted.
  const d = base64urlUnsigned(parsed.d);
  const p = base64urlUnsigned(parsed.p);
  const q = base64urlUnsigned(parsed.q);
  const dp = base64urlUnsigned(parsed.dp);
  const dq = base64urlUnsigned(parsed.dq);
  const qi = base64urlUnsigned(parsed.qi);
  if (
    d === null ||
    p === null ||
    q === null ||
    dp === null ||
    dq === null ||
    qi === null ||
    p === 1n ||
    q === 1n ||
    p === q ||
    modulus !== p * q ||
    d % (p - 1n) !== dp ||
    d % (q - 1n) !== dq ||
    (q * qi) % p !== 1n ||
    (exponent * d) % bigIntLeastCommonMultiple(p - 1n, q - 1n) !== 1n
  ) {
    throw invalidJwkError();
  }

  /** @type {Record<string, unknown> | null} */
  let publicJwk = null;
  try {
    publicJwk = /** @type {Record<string, unknown>} */ (
      createPublicKey(keyObject).export({ format: "jwk" })
    );
  } catch {
    publicJwk = null;
  }
  if (publicJwk === null || publicJwk.n !== parsed.n || publicJwk.e !== parsed.e) {
    throw invalidJwkError();
  }
}

/**
 * The configured key identifier must be a bounded, printable, non-blank
 * string, mirroring the signing-key contract's identifier bound.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoundedKid(value) {
  if (typeof value !== "string") {
    return false;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes >= 1 &&
    bytes <= OAUTH_JWK_MAX_KID_BYTES &&
    value.trim() !== "" &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 0x20 || code === 0x7f);
    })
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Optional JWK metadata may be absent or null, in which case Tama normalizes
 * it; when present it must equal the accepted value.
 *
 * @param {unknown} value
 * @param {string} accepted
 * @returns {boolean}
 */
function isCompatibleMetadata(value, accepted) {
  return value === undefined || value === null || value === accepted;
}

/**
 * Key operations may be absent or null; when present they must be a string
 * list that includes the signing operation.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSigningKeyOps(value) {
  if (value === undefined || value === null) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.includes("sign") &&
    value.every((operation) => typeof operation === "string")
  );
}

/**
 * Decodes a strict Base64url unsigned integer the way the signing-key
 * contract validates RSA members.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
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

/**
 * Reports the minimal bit length of a positive bigint without relying on
 * `BigInt.prototype` methods, which are unavailable in some Node builds.
 *
 * @param {bigint} integer
 * @returns {number}
 */
function bigintBitLength(integer) {
  return integer.toString(2).length;
}

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function bigIntGreatestCommonDivisor(a, b) {
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/**
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function bigIntLeastCommonMultiple(a, b) {
  return a / bigIntGreatestCommonDivisor(a, b) * b;
}

/** @returns {import("../errors.mjs").CLIError} */
function invalidJwkError() {
  return ownershipError("TAMA_OAUTH_PRIVATE_JWK is not a valid RSA private JWK for RS256 signing", {
    variables: ["TAMA_OAUTH_PRIVATE_JWK", "TAMA_OAUTH_PRIVATE_JWK_ID"],
  });
}

/** @returns {import("../errors.mjs").CLIError} */
function invalidKidError() {
  return ownershipError("TAMA_OAUTH_PRIVATE_JWK_ID is not a valid key identifier", {
    variables: ["TAMA_OAUTH_PRIVATE_JWK_ID"],
  });
}

/** @returns {import("../errors.mjs").CLIError} */
function mismatchedKidError() {
  return ownershipError(
    "TAMA_OAUTH_PRIVATE_JWK_ID does not match the key identifier in TAMA_OAUTH_PRIVATE_JWK",
    { variables: ["TAMA_OAUTH_PRIVATE_JWK", "TAMA_OAUTH_PRIVATE_JWK_ID"] },
  );
}
