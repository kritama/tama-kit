# OAuth Private JWK Bootstrap

Status: proposed

## Summary

Update `tama-kit bootstrap` to generate the asymmetric System OAuth signing
configuration required by current Tama releases:

```dotenv
TAMA_OAUTH_PRIVATE_JWK=<private RSA JWK JSON>
TAMA_OAUTH_PRIVATE_JWK_ID=<matching key identifier>
```

Tama Kit currently generates the superseded symmetric variables
`TAMA_OAUTH_SIGNING_KEY` and `TAMA_OAUTH_SIGNING_KEY_ID`. Current Tama
production configuration instead requires a private JSON JWK and signs System
OAuth access tokens with `RS256`. Tama publishes only the public counterpart at
`/.well-known/jwks.json`.

The user-facing generation lifecycle belongs to Tama Kit because bootstrap
already owns creation, validation, persistence, permissions, redaction, and
idempotent upgrades of `.tama.env`. The cryptographic contract remains owned by
`tama_oauth`, and Tama remains responsible for loading the key, failing startup
on invalid configuration, signing tokens, and publishing its public JWKS.

This change is limited to the System OAuth signing-key pair. Keep every other
bootstrap variable and behavior unchanged, including `TAMA_JWT_SECRET`, which
still serves Tama's separate Joken API-token path.

## Goals

- Generate an RSA private JWK compatible with Tama's `RS256` signing contract.
- Give the key a stable `kid` and write the same value to
  `TAMA_OAUTH_PRIVATE_JWK_ID`.
- Store the private JWK only in the ignored, owner-only `.tama.env` file.
- Preserve an existing valid private JWK on every rerun.
- Upgrade a Tama Kit-managed environment from the obsolete symmetric OAuth
  variables without changing unrelated secrets or configuration.
- Reject partial, malformed, weak, or mismatched persisted key configuration.
- Keep dry-run, JSON, errors, logs, and normal human output free of private key
  material.
- Validate the generated contract against a pinned compatible Tama image.

## Non-goals

- Changing or removing `TAMA_JWT_SECRET`.
- Adding OAuth key material to `tama-kit dev setup`; Tama development already
  generates an ephemeral RSA key in non-production configuration.
- Adding a required Tama Mix task or depending on a Tama source checkout.
- Exposing the private JWK through command output.
- Implementing general-purpose production secret-manager integrations.
- Implementing automatic key rotation or a multiple-key JWKS overlap window.
- Migrating unrelated Tama runtime variable names in the same change.
- Changing the `tama_oauth` signing or validation contract.

## Ownership boundary

| Layer | Responsibility |
| --- | --- |
| `tama_oauth` | Define supported algorithms, normalize private JWK metadata, reject ineligible keys, and derive safe public JWKS documents. |
| Tama | Read the production environment, validate it at boot, sign System OAuth tokens, verify them, and publish only public key members. |
| Tama Kit | Generate deployment key material, persist it safely, preserve it across reruns, migrate managed bootstrap files, redact output, and verify compatibility with the pinned image. |

Tama Kit must not invoke `mix` to generate the key. Bootstrap is designed to
work from an arbitrary application repository and may run before Tama source,
Elixir, or compiled dependencies are available. Node 20 is already Tama Kit's
runtime and provides the required asymmetric key APIs.

A future optional manual-administration command may wrap the same Tama Kit key
helper, but it is not required for this migration. A Mix task would only be a
thin convenience wrapper around `TamaOAuth.SigningKey`; it must not become a
second owner of deployment persistence or rotation policy.

## Generated contract

Generate one RSA key pair using Node's `node:crypto` module and export the
private `KeyObject` with `format: "jwk"`. The generated private JWK must be a
single-line JSON object containing the RSA private key members and these
metadata fields:

```json
{
  "alg": "RS256",
  "kid": "<public-key-derived identifier>",
  "kty": "RSA",
  "use": "sig"
}
```

The abbreviated example intentionally omits all key material. The persisted
object must also contain the public members `n` and `e` and the private members
required by Node's RSA JWK export, including `d`, `p`, `q`, `dp`, `dq`, and
`qi`. Never include a private JWK in documentation, fixtures, snapshots, error
messages, or test failure output.

Use an RSA modulus of at least 2,048 bits. The implementation should select one
explicit modulus size and cover it with tests rather than relying on a runtime
default. The initial implementation should use 3,072 bits for newly generated
bootstrap keys.

Derive `kid` from the public key rather than from secret bytes or a mutable
timestamp. Use the RFC 7638 SHA-256 JWK thumbprint of the canonical public RSA
members, encoded with Base64url and optionally prefixed with `oauth-`. The full
identifier must remain within Tama's 128-byte `kid` limit.

The resulting environment entries are:

```dotenv
TAMA_OAUTH_PRIVATE_JWK={"alg":"RS256","kid":"oauth-...","kty":"RSA","use":"sig",...}
TAMA_OAUTH_PRIVATE_JWK_ID=oauth-...
```

The JSON is stored directly as the dotenv value. It is not PEM, not a JWKS
document containing a `keys` array, and not a Base64 wrapper around JSON.

## Tama Kit implementation

Add a focused helper, for example:

```text
cli/bootstrap/oauth-key.mjs
```

Its narrow interface should support:

```js
generateOAuthPrivateJwk()
validateOAuthPrivateJwk(encodedJwk, kid)
```

`generateOAuthPrivateJwk()` returns the encoded one-line private JWK and its
matching `kid`. It does not print, write files, read process environment, or
make policy decisions about upgrades. Keeping it side-effect-free outside of
cryptographically secure randomness makes it reusable and testable.

`validateOAuthPrivateJwk()` must:

- enforce the existing encoded-key size bound;
- parse exactly one JSON object;
- require an RSA private key and reject public-only, symmetric, EC, or malformed
  material;
- accept only metadata compatible with `RS256`, signing use, and the separately
  configured `kid`;
- require a modulus of at least 2,048 bits;
- construct a Node private `KeyObject` from the JWK;
- derive the public key and confirm that any JWK `kid` matches the separately
  configured identifier; and
- return a generic validation failure that does not quote the value.

Generated output should include normalized `alg`, `use`, and `kid` fields.
Validation of persisted values should remain aligned with Tama's accepted
contract: an otherwise eligible key may omit optional metadata that Tama
normalizes while loading it, and an externally supplied `kid` need not be a
thumbprint. JSON member order must not affect validity.

Update `cli/bootstrap/environment.mjs` to:

- replace the two obsolete required variables with
  `TAMA_OAUTH_PRIVATE_JWK` and `TAMA_OAUTH_PRIVATE_JWK_ID`;
- generate the pair when creating a new `.tama.env`;
- validate both values before accepting a persisted environment;
- preserve both values when changing ports or reconciling other managed
  content; and
- keep the JWK out of `.tama.postgres.env`.

Update the safe example template to use non-secret placeholders:

```dotenv
TAMA_OAUTH_PRIVATE_JWK=replace-me
TAMA_OAUTH_PRIVATE_JWK_ID=replace-me
```

The example must not contain a structurally valid private key.

## Managed environment migration

An existing `.tama.env` may contain:

```dotenv
TAMA_OAUTH_SIGNING_KEY=<old symmetric secret>
TAMA_OAUTH_SIGNING_KEY_ID=<old identifier>
```

That secret cannot be converted into an RSA private key. Migration therefore
generates a new asymmetric key pair.

Only upgrade a sensitive environment automatically when all of the following
are true:

1. the file has Tama Kit's generated ownership marker;
2. neither new private-JWK variable is present;
3. both obsolete OAuth signing variables are present and non-empty; and
4. the rest of the managed environment passes its existing structural checks.

For an eligible managed file, replace only the two obsolete OAuth lines with
the two new private-JWK lines. Preserve all unrelated values, comments, order,
ports, credentials, and user-added environment entries. The update participates
in the existing atomic write and rollback behavior.

Fail closed without overwriting when:

- only one new variable is present;
- only one obsolete variable is present;
- old and new pairs are both present;
- the private JWK is malformed, weak, public-only, or incompatible;
- the JWK's `kid` conflicts with `TAMA_OAUTH_PRIVATE_JWK_ID`; or
- the file lacks Tama Kit's ownership marker.

The error should identify the variable names and remediation category, never
their values. An unmanaged file should receive explicit instructions to add a
valid pair manually; Tama Kit must not claim or rewrite it.

Once a valid new pair exists, reruns must preserve it byte-for-byte. A port
change, template refresh, `--start`, or skill-mode change must never rotate the
key.

## Runtime compatibility and cutover

The generated environment and pinned Tama image form one runtime contract. Do
not release this change while Tama Kit still pins an image that requires the
obsolete symmetric variables.

Implementation must identify and pin a Tama image release that:

- requires `TAMA_OAUTH_PRIVATE_JWK` and `TAMA_OAUTH_PRIVATE_JWK_ID` in
  production;
- signs System OAuth access tokens using `RS256`;
- starts successfully without `TAMA_OAUTH_SIGNING_KEY` or
  `TAMA_OAUTH_SIGNING_KEY_ID`; and
- publishes the matching public key from `/.well-known/jwks.json` without any
  private RSA members.

For a managed bootstrap upgrade, the compatible image/template update and
environment migration must be planned and written together. `--start` may run
only after the complete plan is written successfully.

Legacy HS256 System OAuth access tokens are not accepted by the new Tama
runtime. This is an intentional authentication cutover: active clients must
refresh or reauthorize. This WIP does not add a compatibility verifier or a
multi-key overlap mechanism.

## Secret handling

The existing sensitive-file invariants apply to the new private key:

- `.tama.env` remains root-anchored in the project `.gitignore` and mode
  `0600`;
- bootstrap refuses to write when the secret file is tracked or staged;
- `.tama.postgres.env`, Compose, Terraform, the manifest, and generated agent
  guidance never receive the JWK;
- private JWK content never appears in normal human output, progress messages,
  JSON output, dry-run output, errors, debug logs, snapshots, or telemetry;
- JSON change records may label `.tama.env` as sensitive and report its digest,
  but never its content;
- exceptions from Node crypto or JSON parsing are mapped to bounded generic
  errors; and
- tests use freshly generated ephemeral keys and never commit production-like
  private fixtures.

Dry-run may perform generation in memory if required by the existing planning
architecture, but it must not persist or expose the discarded key. A later real
run may generate a different key because no key was committed by dry-run.

## Verification

### Focused unit tests

- A generated JWK parses as a private RSA key of the selected modulus size.
- The generated metadata is exactly compatible with `RS256` signing.
- The configured ID matches the JWK `kid` and the public-key thumbprint.
- The private key signs a test payload and its derived public key verifies it.
- Public export contains `kty`, `n`, and `e` but none of `d`, `p`, `q`, `dp`,
  `dq`, or `qi`.
- Separate generations produce separate keys and identifiers.
- Validation rejects malformed JSON, a JWKS document, a public-only JWK, a
  symmetric key, an EC key, a weak RSA key, conflicting metadata, and a
  mismatched ID.
- Validation errors contain neither the encoded JWK nor any private member.

### Bootstrap environment tests

- A new bootstrap writes the two new variables and omits the two obsolete
  variables.
- `.tama.env` remains mode `0600` and ignored.
- `.tama.postgres.env` does not contain OAuth key material.
- A second run preserves the private JWK and ID byte-for-byte and produces no
  environment diff.
- Port changes and other supported updates preserve the key pair.
- A marked legacy environment receives exactly one new pair while every
  unrelated line remains unchanged.
- Partial, conflicting, invalid, and unmanaged legacy environments fail closed.
- `TAMA_JWT_SECRET` remains present and unchanged during migration.
- Human, JSON, dry-run, error, and progress output do not contain the private
  JWK or its private RSA parameters.
- The safe example contains placeholders only.

### Runtime acceptance

Against the newly pinned Tama image:

1. run bootstrap into a temporary fixture repository;
2. verify Compose configuration without printing the resolved environment;
3. start Tama and PostgreSQL using the generated private files;
4. confirm Tama reaches its health endpoint;
5. fetch `/.well-known/jwks.json`;
6. select the entry matching `TAMA_OAUTH_PRIVATE_JWK_ID`;
7. assert `kty=RSA`, `alg=RS256`, and `use=sig`;
8. assert the document contains no private RSA parameters; and
9. prove a System OAuth token minted by Tama verifies with the published public
   key.

The acceptance harness must redact the private environment if a command fails.
Avoid commands such as `docker compose config` without a redaction boundary
when their output could expand `.tama.env` values.

Run the normal Tama Kit verification after focused tests:

```bash
npm test
npm run check
npm run typecheck
npm run format:check
npm pack --dry-run
git diff --check
```

## Implementation sequence

1. Add the isolated Node RSA JWK generation, thumbprint, and validation helper.
2. Add focused cryptographic contract tests with output-leak assertions.
3. Replace the obsolete variables for newly generated bootstrap environments.
4. Add the guarded, marker-aware migration for existing managed `.tama.env`
   files.
5. Update the safe environment example and bootstrap documentation.
6. Select the compatible Tama image and update the pinned bootstrap contract.
7. Add runtime acceptance for startup, public JWKS safety, and token
   verification.
8. Run the complete Tama Kit validation and package inspection.

## Rollout checklist

- [ ] Tama Kit no longer generates `TAMA_OAUTH_SIGNING_KEY`.
- [ ] Tama Kit no longer generates `TAMA_OAUTH_SIGNING_KEY_ID`.
- [ ] New bootstrap environments contain one valid private RSA JWK and matching
      ID.
- [ ] Existing managed environments migrate once without unrelated changes.
- [ ] Reruns do not rotate keys.
- [ ] All output channels remain free of private key material.
- [ ] The pinned Tama image starts with only the new OAuth key variables.
- [ ] Tama's public JWKS exposes the matching public key and no private members.
- [ ] `TAMA_JWT_SECRET` and its existing behavior remain unchanged.
- [ ] Focused, full-suite, static, package, and runtime checks pass.

## Source references

- Tama Kit bootstrap environment ownership:
  `../cli/bootstrap/environment.mjs`
- Tama Kit safe environment example:
  `../cli/templates/bootstrap/tama-env.example`
- Tama Kit bootstrap tests:
  `../test/cli/bootstrap.test.mjs`
- Tama production environment contract:
  `../../../_upmaru/tama/config/runtime.exs`
- Tama System OAuth key adapter:
  `../../../_upmaru/tama/lib/tama/oauth/key_provider.ex`
- Shared signing-key contract:
  `../../tama-oauth/lib/tama_oauth/signing_key.ex`

The dependency checkout path is a development reference only. The
implementation must validate behavior against the released `tama_oauth`
version included in the selected Tama image.
