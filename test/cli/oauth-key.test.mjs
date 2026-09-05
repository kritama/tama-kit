import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import {
  generateOAuthPrivateJwk,
  OAUTH_JWK_MAX_ENCODED_BYTES,
  OAUTH_JWK_MODULUS_BITS,
  OAUTH_JWK_PUBLIC_SET_MAX_ITEMS,
  validateOAuthPrivateJwk,
  validatePublicJwkSet,
} from "../../cli/shared/oauth-key.mjs";

/** @param {number} [bits] */
function rsaPrivateKeyObject(bits = 2048) {
  return generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 0x10001 }).privateKey;
}

/** @param {import("node:crypto").KeyObject} privateKey */
function rsaPrivateJwk(privateKey) {
  return /** @type {Record<string, string>} */ (privateKey.export({ format: "jwk" }));
}

/** @param {import("node:crypto").KeyObject} privateKey */
function rsaPublicJwk(privateKey) {
  return /** @type {Record<string, string>} */ (
    createPublicKey(privateKey).export({ format: "jwk" })
  );
}

/** @param {string} jwk */
function jwkKeyObject(jwk) {
  return createPrivateKey({ key: JSON.parse(jwk), format: "jwk" });
}

/** @param {Record<string, unknown>} publicJwk */
function rfc7638ThumbprintKid(publicJwk) {
  const canonical = JSON.stringify({ e: publicJwk.e, kty: "RSA", n: publicJwk.n });
  return `oauth-${createHash("sha256").update(canonical, "utf8").digest("base64url")}`;
}

/** @param {bigint} value */
function base64urlUnsigned(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex").toString("base64url");
}

/** @param {bigint} value @param {bigint} modulus */
function modularInverse(value, modulus) {
  let [oldRemainder, remainder] = [value, modulus];
  let [oldCoefficient, coefficient] = [1n, 0n];
  while (remainder !== 0n) {
    const quotient = oldRemainder / remainder;
    [oldRemainder, remainder] = [remainder, oldRemainder - quotient * remainder];
    [oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient];
  }
  return ((oldCoefficient % modulus) + modulus) % modulus;
}

/** @param {bigint} a @param {bigint} b */
function greatestCommonDivisor(a, b) {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** @param {bigint} a @param {bigint} b */
function leastCommonMultiple(a, b) {
  return (a / greatestCommonDivisor(a, b)) * b;
}

/** @param {bigint} p @param {bigint} q @param {string} kid */
function privateJwkFromFactors(p, q, kid) {
  const exponent = 65_537n;
  const d = modularInverse(exponent, leastCommonMultiple(p - 1n, q - 1n));
  return JSON.stringify({
    alg: "RS256",
    kid,
    kty: "RSA",
    use: "sig",
    n: base64urlUnsigned(p * q),
    e: base64urlUnsigned(exponent),
    d: base64urlUnsigned(d),
    p: base64urlUnsigned(p),
    q: base64urlUnsigned(q),
    dp: base64urlUnsigned(d % (p - 1n)),
    dq: base64urlUnsigned(d % (q - 1n)),
    qi: base64urlUnsigned(modularInverse(q, p)),
  });
}

/** @param {string} kid */
function smallPrimeFactorJwk(kid) {
  const p = 3n;
  const q = BigInt(
    "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08" +
      "8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD" +
      "3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E" +
      "7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899F" +
      "A5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
      "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C" +
      "62F356208552BB9ED529077096966D670C354E4ABC9804F1746" +
      "C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A" +
      "2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CE" +
      "A956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF",
  );
  return privateJwkFromFactors(p, q, kid);
}

/** @param {string} kid */
function compositePrimeFactorJwk(kid) {
  const prime = BigInt(
    "0x3d200624120d35cbcf199db3d625b2ea5a19e4e4ddee70e889e681c4e8b6eead" +
      "b896bcea285c93199562734d12aa1e8a420149ffddb8534e5363e346316c540e7" +
      "d3e436633a76d3b85337df81cab246920ff99ef42694fe64b288e83fec391b134" +
      "1e486f85f0c865585212f120317fc63cef4e024aa90bf1b03ffce2f2580be7",
  );
  const q = BigInt(
    "0xcf6801d9f075753a236332c68f28e8591d38d32ee2d985f7e77f8aaa923519d8" +
      "9622c4f2e3806aa24740bd8b49f2a203c7f795a6cdd10fe1192acaac532e8c51" +
      "8a7f442afd37fa9db43a2bcb11b42db2e558c417e73bb8fcb140368e816f444d" +
      "8a7529a7ae10a1d30b7b16637398a08a8effb1dfc98af6fa58edde9a12fe5f0d",
  );
  return privateJwkFromFactors(3n * prime, q, kid);
}

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"];

/**
 * Asserts a validation failure and that neither the encoded value nor any
 * private member value appears in the reported error.
 *
 * @param {string} encodedJwk
 * @param {string} kid
 */
function expectInvalid(encodedJwk, kid) {
  assert.throws(
    () => validateOAuthPrivateJwk(encodedJwk, kid),
    (error) => {
      assert.ok(error instanceof CLIError);
      assert.equal(error.exitCode, EXIT_CODES.OWNERSHIP);
      assert.match(error.message, /TAMA_OAUTH_PRIVATE_JWK/u);
      if (encodedJwk.length > 0) {
        assert.equal(error.message.includes(encodedJwk), false);
      }
      const key = safeParse(encodedJwk);
      if (key !== null) {
        for (const member of PRIVATE_JWK_MEMBERS) {
          const value = key[member];
          if (typeof value === "string" && value.length > 8) {
            assert.equal(error.message.includes(value), false, `leaked ${member}`);
          }
        }
      }
      return true;
    },
  );
}

/** @param {string} value */
function safeParse(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

test("generateOAuthPrivateJwk returns a single-line RS256 RSA private JWK", () => {
  const { jwk, kid } = generateOAuthPrivateJwk();
  assert.equal(jwk.includes("\n"), false);

  const parsed = /** @type {Record<string, string>} */ (JSON.parse(jwk));
  assert.deepEqual(Object.keys(parsed).sort(), [
    "alg",
    "d",
    "dp",
    "dq",
    "e",
    "kid",
    "kty",
    "n",
    "p",
    "q",
    "qi",
    "use",
  ]);
  assert.equal(parsed.alg, "RS256");
  assert.equal(parsed.kty, "RSA");
  assert.equal(parsed.use, "sig");
  assert.equal(parsed.kid, kid);
  for (const member of PRIVATE_JWK_MEMBERS) {
    assert.equal(typeof parsed[member], "string");
    assert.ok(parsed[member].length > 0, `empty ${member}`);
  }

  const keyObject = jwkKeyObject(jwk);
  assert.equal(keyObject.asymmetricKeyType, "rsa");
  assert.equal(keyObject.asymmetricKeyDetails?.modulusLength, OAUTH_JWK_MODULUS_BITS);
});

test("the generated kid matches the public-key RFC 7638 thumbprint", () => {
  const { jwk, kid } = generateOAuthPrivateJwk();
  const keyObject = jwkKeyObject(jwk);
  assert.equal(kid, rfc7638ThumbprintKid(rsaPublicJwk(keyObject)));
  assert.ok(Buffer.byteLength(kid, "utf8") <= 128);
});

test("the generated private key signs and the derived public key verifies", () => {
  const { jwk } = generateOAuthPrivateJwk();
  const privateKey = jwkKeyObject(jwk);
  const publicKey = createPublicKey(privateKey);
  const payload = Buffer.from("tama-kit oauth bootstrap contract");
  const signer = createSign("RSA-SHA256");
  signer.update(payload);
  const signature = signer.sign(privateKey);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(payload);
  assert.ok(verifier.verify(publicKey, signature));
});

test("public export contains only public members", () => {
  const { jwk } = generateOAuthPrivateJwk();
  const publicJwk = rsaPublicJwk(jwkKeyObject(jwk));
  assert.equal(publicJwk.kty, "RSA");
  assert.equal(typeof publicJwk.n, "string");
  assert.equal(typeof publicJwk.e, "string");
  for (const member of PRIVATE_JWK_MEMBERS) {
    assert.equal(member in publicJwk, false, `leaked ${member}`);
  }
});

test("separate generations produce separate keys and identifiers", () => {
  const first = generateOAuthPrivateJwk();
  const second = generateOAuthPrivateJwk();
  assert.notEqual(first.jwk, second.jwk);
  assert.notEqual(first.kid, second.kid);
});

test("validation accepts Tama-normalized variants and rejects incomplete private keys", () => {
  const { jwk, kid } = generateOAuthPrivateJwk();
  validateOAuthPrivateJwk(jwk, kid);

  const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(jwk));
  const stripped = {
    kty: parsed.kty,
    n: parsed.n,
    e: parsed.e,
    d: parsed.d,
    p: parsed.p,
    q: parsed.q,
    dp: parsed.dp,
    dq: parsed.dq,
    qi: parsed.qi,
  };
  validateOAuthPrivateJwk(JSON.stringify(stripped), kid);

  const nulled = {
    ...parsed,
    alg: null,
    use: null,
    kid: null,
  };
  validateOAuthPrivateJwk(JSON.stringify(nulled), kid);

  const reordered = Object.fromEntries(Object.entries(parsed).reverse());
  validateOAuthPrivateJwk(JSON.stringify(reordered), kid);

  const minimal = { kty: parsed.kty, n: parsed.n, e: parsed.e, d: parsed.d };
  expectInvalid(JSON.stringify(minimal), kid);

  const withOps = { ...parsed, key_ops: ["sign"] };
  validateOAuthPrivateJwk(JSON.stringify(withOps), kid);
});

test("an externally supplied kid need not be a thumbprint", () => {
  const { jwk } = generateOAuthPrivateJwk();
  const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(jwk));
  const customKid = "oauth-local-1";
  validateOAuthPrivateJwk(JSON.stringify({ ...parsed, kid: customKid }), customKid);
  expectInvalid(JSON.stringify({ ...parsed, kid: customKid }), "oauth-someone-else");
});

test("validation rejects malformed, public, symmetric, and EC material", () => {
  const { jwk, kid } = generateOAuthPrivateJwk();
  const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(jwk));

  expectInvalid("{not-json", kid);
  expectInvalid(JSON.stringify({ keys: [parsed] }), kid);

  const publicOnly = {
    kty: parsed.kty,
    n: parsed.n,
    e: parsed.e,
    kid,
  };
  expectInvalid(JSON.stringify(publicOnly), kid);

  const symmetric = { kty: "oct", k: "fym6SyaNNMvzg7Z9fJcR7L63YnnYHrYQ3Vtjq1oYhUE" };
  expectInvalid(JSON.stringify(symmetric), kid);

  const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  expectInvalid(JSON.stringify(ecKey.export({ format: "jwk" })), kid);
});

test("validation rejects weak RSA keys and conflicting metadata", () => {
  const { kid } = generateOAuthPrivateJwk();

  const weak = rsaPrivateJwk(rsaPrivateKeyObject(1024));
  expectInvalid(JSON.stringify(weak), kid);
  const smallFactor = smallPrimeFactorJwk(kid);
  assert.ok((jwkKeyObject(smallFactor).asymmetricKeyDetails?.modulusLength ?? 0) >= 2048);
  expectInvalid(smallFactor, kid);
  const compositeFactor = compositePrimeFactorJwk(kid);
  assert.equal(jwkKeyObject(compositeFactor).asymmetricKeyDetails?.modulusLength, 2048);
  expectInvalid(compositeFactor, kid);

  const { jwk } = generateOAuthPrivateJwk();
  const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(jwk));
  expectInvalid(JSON.stringify({ ...parsed, alg: "HS256" }), kid);
  expectInvalid(JSON.stringify({ ...parsed, use: "enc" }), kid);
  expectInvalid(JSON.stringify({ ...parsed, key_ops: ["verify"] }), kid);
  expectInvalid(JSON.stringify({ ...parsed, key_ops: ["sign", 12] }), kid);
});

test("validation rejects mismatched identifiers and oversized keys", () => {
  const { jwk } = generateOAuthPrivateJwk();
  for (const unsafeKid of ["key#fragment", "key'quote", "key$value", "key/segment"]) {
    assert.throws(() => generateOAuthPrivateJwk(unsafeKid));
  }
  expectInvalid(jwk, "oauth-mismatched-identifier");
  expectInvalid(jwk, "");
  expectInvalid(jwk, `oauth-${"x".repeat(128)}`);
  expectInvalid("", "oauth-local-1");
  expectInvalid(
    JSON.stringify({
      kty: "RSA",
      n: "n",
      e: "AQAB",
      d: "d",
      padding: "x".repeat(OAUTH_JWK_MAX_ENCODED_BYTES),
    }),
    "oauth-local-1",
  );
});

test("validation rejects public members that disagree with the private key", () => {
  const first = rsaPrivateJwk(rsaPrivateKeyObject());
  const second = rsaPrivateJwk(rsaPrivateKeyObject());
  const configuredKid = rfc7638ThumbprintKid(rsaPublicJwk(rsaPrivateKeyObject()));
  const swapped = { ...first, n: second.n, kid: configuredKid };
  expectInvalid(JSON.stringify(swapped), configuredKid);
});

test("validation rejects a foreign public pair combined with valid private parameters", () => {
  const local = rsaPrivateJwk(rsaPrivateKeyObject());
  const foreignPublic = /** @type {Record<string, string>} */ (
    createPublicKey(rsaPrivateKeyObject()).export({ format: "jwk" })
  );
  const configuredKid = rfc7638ThumbprintKid(foreignPublic);
  const mixed = {
    ...local,
    n: foreignPublic.n,
    e: foreignPublic.e,
    kid: configuredKid,
  };
  expectInvalid(JSON.stringify(mixed), configuredKid);
});

test("validatePublicJwkSet accepts public-only RSA members with compatible metadata", () => {
  validatePublicJwkSet("[]", "TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS");

  const keyA = { ...rsaPublicJwk(rsaPrivateKeyObject()), alg: "RS256", kid: "key-a", use: "sig" };
  const keyB = { ...rsaPublicJwk(rsaPrivateKeyObject()), kid: "key-b" };
  const keyC = {
    ...rsaPublicJwk(rsaPrivateKeyObject()),
    alg: null,
    use: null,
    key_ops: ["verify"],
    kid: "key-c",
  };
  validatePublicJwkSet(JSON.stringify([keyA, keyB, keyC]), "MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS");
});

test("validatePublicJwkSet rejects private, non-RSA, duplicate, and oversized members", () => {
  const key = { ...rsaPublicJwk(rsaPrivateKeyObject()), alg: "RS256", kid: "key-a", use: "sig" };
  const expectInvalidSet = (encoded) =>
    assert.throws(
      () => validatePublicJwkSet(encoded, "MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS"),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.OWNERSHIP &&
        /MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS/u.test(error.message) &&
        error.message.includes(key.n) === false,
    );

  expectInvalidSet("not-json");
  expectInvalidSet(JSON.stringify(key));
  expectInvalidSet(JSON.stringify([{ ...key, d: "AQ" }]));
  expectInvalidSet(JSON.stringify([{ ...key, kty: "EC" }]));
  expectInvalidSet(JSON.stringify([{ ...key, alg: "HS256" }]));
  expectInvalidSet(JSON.stringify([{ ...key, use: "enc" }]));
  expectInvalidSet(JSON.stringify([{ ...key, key_ops: ["encrypt"] }]));
  expectInvalidSet(JSON.stringify([{ ...key, key_ops: ["verify", 12] }]));
  expectInvalidSet(JSON.stringify([{ ...key, kid: null }]));
  expectInvalidSet(JSON.stringify([{ ...key, kid: `key-${"x".repeat(128)}` }]));
  expectInvalidSet(JSON.stringify([{ ...key, n: "!!" }]));
  expectInvalidSet(
    JSON.stringify([{ ...key, n: base64urlUnsigned(1n << 2047n), kid: "even-modulus" }]),
  );
  expectInvalidSet(
    JSON.stringify([
      { ...key, n: base64urlUnsigned(3n * ((1n << 2046n) + 1n)), kid: "small-factor" },
    ]),
  );
  expectInvalidSet(JSON.stringify([{ ...key }, { ...key }]));
  expectInvalidSet(JSON.stringify([{ ...key, padding: "x".repeat(OAUTH_JWK_MAX_ENCODED_BYTES) }]));
  expectInvalidSet(
    JSON.stringify(Array.from({ length: OAUTH_JWK_PUBLIC_SET_MAX_ITEMS + 1 }, () => key)),
  );
});
