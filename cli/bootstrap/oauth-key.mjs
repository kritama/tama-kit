// @ts-check

import {
  checkPrimeSync,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";

import { ownershipError } from "../errors.mjs";

export const OAUTH_JWK_ALGORITHM = "RS256";
export const OAUTH_JWK_MODULUS_BITS = 3_072;
export const OAUTH_JWK_MIN_MODULUS_BITS = 2_048;
export const OAUTH_JWK_MAX_ENCODED_BYTES = 65_536;
export const OAUTH_JWK_MAX_KID_BYTES = 128;
export const OAUTH_JWK_PUBLIC_SET_MAX_ITEMS = 30;

/**
 * Reports whether a value is an identifier that Tama accepts for a System
 * OAuth private JWK: non-empty, control-character-free, and no larger than
 * the contract maximum.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidOAuthKid(value) {
  return isBoundedKid(value);
}

/**
 * @typedef {object} OAuthPrivateJwk
 * @property {string} jwk
 * @property {string} kid
 */

/**
 * @typedef {object} OAuthKeyPair
 * @property {string} privateJwk
 * @property {string} publicJwk
 * @property {string} kid
 * @property {string} algorithm
 */

/**
 * Generates the asymmetric System OAuth signing key pair.
 *
 * The result is a single-line private JWK with normalized RS256 signing
 * metadata. An explicit identifier is validated against the Tama contract
 * before any key material is generated and embedded in the JWK; when
 * omitted, the `kid` is derived from the RFC 7638 thumbprint of the public
 * key. This function is side-effect-free outside of cryptographic
 * randomness.
 *
 * @param {string} [kid] Explicit public key identifier.
 * @returns {OAuthPrivateJwk}
 */
export function generateOAuthPrivateJwk(kid = undefined) {
  if (kid !== undefined && !isBoundedKid(kid)) {
    throw invalidKidError();
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: OAUTH_JWK_MODULUS_BITS,
    publicExponent: 0x10001,
  });
  const privateJwk = /** @type {Record<string, string>} */ (privateKey.export({ format: "jwk" }));
  const publicJwk = /** @type {Record<string, string>} */ (publicKey.export({ format: "jwk" }));
  const canonical = JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n });
  const thumbprint = createHash("sha256").update(canonical, "utf8").digest("base64url");
  const keyIdentifier = kid ?? `oauth-${thumbprint}`;
  const jwk = JSON.stringify({
    alg: OAUTH_JWK_ALGORITHM,
    kid: keyIdentifier,
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
  return { jwk, kid: keyIdentifier };
}

/**
 * Generates an independent RS256 keypair and returns both the private JWK and
 * the matching public JWK. The `kid` is derived from the RFC 7638 thumbprint
 * of the public key, prefixed to keep the provider access-token key and the
 * Tama introspection key unambiguous even when both are RS256.
 *
 * @param {string} kidPrefix
 * @returns {OAuthKeyPair}
 */
export function generateOAuthKeyPair(kidPrefix) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: OAUTH_JWK_MODULUS_BITS,
    publicExponent: 0x10001,
  });
  const privateJwk = /** @type {Record<string, string>} */ (privateKey.export({ format: "jwk" }));
  const publicJwk = /** @type {Record<string, string>} */ (publicKey.export({ format: "jwk" }));
  const canonical = JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n });
  const thumbprint = createHash("sha256").update(canonical, "utf8").digest("base64url");
  const kid = `${kidPrefix}-${thumbprint}`;
  return {
    privateJwk: JSON.stringify({
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
    }),
    publicJwk: JSON.stringify({
      alg: OAUTH_JWK_ALGORITHM,
      kid,
      kty: "RSA",
      use: "sig",
      n: publicJwk.n,
      e: publicJwk.e,
    }),
    kid,
    algorithm: OAUTH_JWK_ALGORITHM,
  };
}

/**
 * Validates a persisted public JWK overlap set: a JSON array of public-only
 * RSA JWK members, each with a bounded, unique identifier, compatible signing
 * metadata, complete public parameters, and no private members. The set holds
 * keys in addition to the current key, which the runtime publishes on its own,
 * so a fresh integration starts empty and rotation state is preserved across
 * runs instead of being rewritten.
 *
 * @param {string} encoded
 * @param {string} variable Environment variable name used in diagnostics.
 * @param {string} [currentKid] Current signing key identifier, which an
 *   overlap member must not reuse.
 */
export function validatePublicJwkSet(encoded, variable, currentKid) {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") === 0) {
    throw invalidPublicJwkSetError(variable);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw invalidPublicJwkSetError(variable);
  }
  if (!Array.isArray(parsed) || parsed.length > OAUTH_JWK_PUBLIC_SET_MAX_ITEMS) {
    throw invalidPublicJwkSetError(variable);
  }
  /** @type {Set<string>} */
  const kids = new Set();
  for (const member of parsed) {
    if (!isPublicJwkMember(member, kids, currentKid)) {
      throw invalidPublicJwkSetError(variable);
    }
  }
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
 * each factor must also carry at least half of the modulus bit length and pass
 * primality validation, preventing a large modulus from hiding a trivially
 * factorable component.
 * Supported Node versions can import a JWK whose public and private members
 * come from different keys, so the KeyObject sign/derive check alone is not
 * sufficient. Every failure is bounded and names the variables without
 * quoting their values.
 *
 * @param {string} encodedJwk
 * @param {string} kid
 * @param {string} [variable] Environment variable label for diagnostics.
 * @param {string} [keyIdVariable] Key identifier variable label for
 *   diagnostics.
 */
export function validateOAuthPrivateJwk(
  encodedJwk,
  kid,
  variable = "TAMA_OAUTH_PRIVATE_JWK",
  keyIdVariable = "TAMA_OAUTH_PRIVATE_JWK_ID",
) {
  if (
    typeof encodedJwk !== "string" ||
    Buffer.byteLength(encodedJwk, "utf8") < 1 ||
    Buffer.byteLength(encodedJwk, "utf8") > OAUTH_JWK_MAX_ENCODED_BYTES
  ) {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (!isBoundedKid(kid)) {
    throw invalidKidError(keyIdVariable, variable);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(encodedJwk);
  } catch {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (!isPlainObject(parsed) || Array.isArray(parsed.keys)) {
    throw invalidJwkError(variable, keyIdVariable);
  }

  if (parsed.kty !== "RSA") {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (typeof parsed.d !== "string" || parsed.d === "") {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (!isCompatibleMetadata(parsed.alg, OAUTH_JWK_ALGORITHM)) {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (!isCompatibleMetadata(parsed.use, "sig")) {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (parsed.kid !== undefined && parsed.kid !== null && parsed.kid !== kid) {
    throw mismatchedKidError(keyIdVariable, variable);
  }
  if (!isSigningKeyOps(parsed.key_ops)) {
    throw invalidJwkError(variable, keyIdVariable);
  }

  let keyObject;
  try {
    keyObject = createPrivateKey({ key: parsed, format: "jwk" });
  } catch {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (keyObject.asymmetricKeyType !== "rsa") {
    throw invalidJwkError(variable, keyIdVariable);
  }

  const modulus = base64urlUnsigned(parsed.n);
  const exponent = base64urlUnsigned(parsed.e);
  if (modulus === null || bigintBitLength(modulus) < OAUTH_JWK_MIN_MODULUS_BITS) {
    throw invalidJwkError(variable, keyIdVariable);
  }
  if (exponent === null || exponent < 3n || exponent % 2n === 0n || exponent >= modulus) {
    throw invalidJwkError(variable, keyIdVariable);
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
  const minimumPrimeBits = Math.floor(bigintBitLength(modulus) / 2);
  if (
    d === null ||
    p === null ||
    q === null ||
    dp === null ||
    dq === null ||
    qi === null ||
    bigintBitLength(p) < minimumPrimeBits ||
    bigintBitLength(q) < minimumPrimeBits ||
    p === q ||
    modulus !== p * q ||
    d % (p - 1n) !== dp ||
    d % (q - 1n) !== dq ||
    (q * qi) % p !== 1n ||
    (exponent * d) % bigIntLeastCommonMultiple(p - 1n, q - 1n) !== 1n ||
    !primeFactor(p) ||
    !primeFactor(q)
  ) {
    throw invalidJwkError(variable, keyIdVariable);
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
    throw invalidJwkError(variable, keyIdVariable);
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

/** @type {readonly string[]} */
const PUBLIC_JWK_PRIVATE_MEMBERS = Object.freeze(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

/**
 * A public overlap member must be a plain object without private members,
 * carrying complete RSA public parameters, compatible optional metadata, and
 * a bounded identifier that is unique within the set. The runtime republishes
 * overlap members as trusted RS256 material, so they are held to the same RSA
 * strength as the private signing key: a factorable modulus or a degenerate
 * exponent must not enter the rotation set.
 *
 * @param {unknown} member
 * @param {Set<string>} kids Identifiers already present in the set.
 * @param {string | undefined} currentKid Current signing key identifier.
 * @returns {boolean}
 */
function isPublicJwkMember(member, kids, currentKid) {
  const modulus = isPlainObject(member) && typeof member.n === "string" ? member.n : null;
  const exponent = isPlainObject(member) && typeof member.e === "string" ? member.e : null;
  const modulusValue = modulus === null ? null : base64urlUnsigned(modulus);
  const exponentValue = exponent === null ? null : base64urlUnsigned(exponent);
  if (
    !isPlainObject(member) ||
    Buffer.byteLength(JSON.stringify(member), "utf8") > OAUTH_JWK_MAX_ENCODED_BYTES ||
    PUBLIC_JWK_PRIVATE_MEMBERS.some((name) => member[name] !== undefined) ||
    member.kty !== "RSA" ||
    modulus === null ||
    exponent === null ||
    modulusValue === null ||
    exponentValue === null ||
    !isCompatibleMetadata(member.alg, OAUTH_JWK_ALGORITHM) ||
    !isCompatibleMetadata(member.use, "sig") ||
    !isVerificationKeyOps(member.key_ops) ||
    typeof member.kid !== "string" ||
    !isBoundedKid(member.kid) ||
    member.kid === currentKid ||
    kids.has(member.kid)
  ) {
    return false;
  }
  if (bigintBitLength(modulusValue) < OAUTH_JWK_MIN_MODULUS_BITS) {
    return false;
  }
  if (exponentValue < 3n || exponentValue % 2n === 0n || exponentValue >= modulusValue) {
    return false;
  }
  kids.add(member.kid);
  try {
    createPublicKey({ key: { kty: "RSA", n: modulus, e: exponent }, format: "jwk" });
  } catch {
    return false;
  }
  return true;
}

/**
 * Public verification keys may omit key operations; when present, the list
 * must contain only strings and explicitly allow signature verification.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isVerificationKeyOps(value) {
  if (value === undefined || value === null) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.includes("verify") &&
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

/** @param {bigint} integer @returns {boolean} */
function primeFactor(integer) {
  try {
    return checkPrimeSync(integer);
  } catch {
    return false;
  }
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
  return (a / bigIntGreatestCommonDivisor(a, b)) * b;
}

/**
 * @param {string} [variable]
 * @param {string} [keyIdVariable]
 * @returns {import("../errors.mjs").CLIError}
 */
function invalidJwkError(
  variable = "TAMA_OAUTH_PRIVATE_JWK",
  keyIdVariable = "TAMA_OAUTH_PRIVATE_JWK_ID",
) {
  return ownershipError(`${variable} is not a valid RSA private JWK for RS256 signing`, {
    variables: [variable, keyIdVariable],
  });
}

/**
 * @param {string} [keyIdVariable]
 * @param {string} [variable]
 * @returns {import("../errors.mjs").CLIError}
 */
function invalidKidError(
  keyIdVariable = "TAMA_OAUTH_PRIVATE_JWK_ID",
  variable = "TAMA_OAUTH_PRIVATE_JWK",
) {
  return ownershipError(`${keyIdVariable} is not a valid key identifier`, {
    variables: [keyIdVariable, variable],
  });
}

/** @param {string} variable @returns {import("../errors.mjs").CLIError} */
function invalidPublicJwkSetError(variable) {
  return ownershipError(`${variable} is not a valid public JWK array for RS256 signing`, {
    variables: [variable],
  });
}

/**
 * @param {string} [keyIdVariable]
 * @param {string} [variable]
 * @returns {import("../errors.mjs").CLIError}
 */
function mismatchedKidError(
  keyIdVariable = "TAMA_OAUTH_PRIVATE_JWK_ID",
  variable = "TAMA_OAUTH_PRIVATE_JWK",
) {
  return ownershipError(`${keyIdVariable} does not match the key identifier in ${variable}`, {
    variables: [variable, keyIdVariable],
  });
}
