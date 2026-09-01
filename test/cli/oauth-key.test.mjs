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
import {
  generateOAuthPrivateJwk,
  OAUTH_JWK_MAX_ENCODED_BYTES,
  OAUTH_JWK_MODULUS_BITS,
  validateOAuthPrivateJwk,
} from "../../cli/bootstrap/oauth-key.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";

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

  const { jwk } = generateOAuthPrivateJwk();
  const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(jwk));
  expectInvalid(JSON.stringify({ ...parsed, alg: "HS256" }), kid);
  expectInvalid(JSON.stringify({ ...parsed, use: "enc" }), kid);
  expectInvalid(JSON.stringify({ ...parsed, key_ops: ["verify"] }), kid);
  expectInvalid(JSON.stringify({ ...parsed, key_ops: ["sign", 12] }), kid);
});

test("validation rejects mismatched identifiers and oversized keys", () => {
  const { jwk } = generateOAuthPrivateJwk();
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
