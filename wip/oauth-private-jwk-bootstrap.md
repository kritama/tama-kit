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

Also add a standalone command for operators who need to provision the same key
pair in staging or another environment that is not managed by bootstrap:

```bash
tama-kit oauth generate-key --kid staging-2026-09-01-1 --stdout
```

The command emits the two production environment assignments in dotenv format
only when stdout is explicitly selected. It can instead create a new
owner-only file for transfer into a deployment secret manager.

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
- Provide a standalone command that generates the same contract without a Tama
  checkout, Mix, Docker, or a bootstrap project.
- In bootstrap, store the private JWK only in the ignored, owner-only
  `.tama.env` file.
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
- Exposing the private JWK implicitly through bootstrap, dry-run, general JSON,
  errors, or logs. The standalone command's explicit `--stdout` destination is
  the only intentional terminal-output exception.
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

Tama Kit must not invoke `mix` to generate the key. Bootstrap and the standalone
generator must work before Tama source, Elixir, or compiled dependencies are
available. Node 20 is already Tama Kit's runtime and provides the required
asymmetric key APIs.

A Mix task is unnecessary for this migration. If one is added later, it should
only be a thin convenience wrapper around `TamaOAuth.SigningKey`; it must not
become a second owner of deployment persistence or rotation policy.

## Standalone command surface

Add an OAuth command module and route it through the existing top-level CLI
dispatcher:

```text
tama-kit oauth generate-key [options]

Options:
  --kid <identifier>  Set an explicit public key identifier
  --stdout            Emit dotenv assignments to standard output
  --output <path>     Create an owner-only dotenv file
  -h, --help          Show help
```

Exactly one of `--stdout` or `--output` is required. Requiring an explicit
destination prevents a user from placing a private key in terminal scrollback
by merely exploring a new command.

Examples:

```bash
# Generate copyable staging values explicitly on stdout.
tama-kit oauth generate-key --kid staging-2026-09-01-1 --stdout

# Prefer an owner-only file when transporting values through a password or
# deployment-secret manager.
tama-kit oauth generate-key \
  --kid staging-2026-09-01-1 \
  --output /tmp/tama-oauth-staging.env
```

Standard output in `--stdout` mode contains exactly two newline-terminated
dotenv assignments and no headings, colors, progress rendering, or explanatory
text:

```dotenv
TAMA_OAUTH_PRIVATE_JWK={"alg":"RS256","kid":"staging-2026-09-01-1",...}
TAMA_OAUTH_PRIVATE_JWK_ID=staging-2026-09-01-1
```

The abbreviated example does not contain actual private key material. Warnings
or diagnostics, if any, use stderr and must not quote the generated values.
This output is dotenv, not a shell script; users paste each value into the
staging environment or import the file with tooling that supports dotenv
syntax.

When `--kid` is omitted, derive the identifier from the public-key thumbprint.
When supplied, validate it using Tama's non-empty, control-free, maximum
128-byte contract and embed the identical value in the JWK. Do not expose
algorithm or RSA modulus flags in the first version; the command has one
supported contract, `RS256` with the selected secure modulus size.

`--output` resolves relative paths against the current working directory,
requires an existing safe parent directory, creates the final file exclusively
with mode `0600`, and prints only the resulting path after success. It must
refuse:

- an existing output file, even if Tama Kit created it previously, because
  silently replacing it would rotate a signing key;
- a symbolic-link final path or an existing symbolic-link ancestor;
- a directory target; and
- a missing, symbolic, or unwritable parent directory; and
- a path inside a Git worktree unless it is ignored and absent from the index.

The command must not edit `.gitignore` for an arbitrary operator-selected
path. Reuse Tama Kit's Git-index and symlink-ancestor safety patterns, moving
them to a shared helper where necessary. Recommend an external private
temporary directory or an already ignored deployment-secret path in the
documentation.

Do not add `--force` initially. Rotation needs an explicit lifecycle and public
JWKS overlap decision; a generic overwrite flag would make accidental token
invalidation too easy.

The standalone command does not support the existing general `--json` option
in its first version. Its dotenv payload is already deterministic and directly
usable by staging environment tooling. A future structured secret-output mode
must be explicitly named and documented as secret-bearing rather than
reusing Tama Kit's normally redacted JSON contract.

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

Add `cli/commands/oauth.mjs` to parse `generate-key`, call this helper, and own
the explicit stdout-or-file destination behavior. Import `runOAuth` from
`cli/index.mjs`, add the command to top-level usage, and follow the existing
`CLIError`, `usageError`, `CommandIO`, and stable exit-code conventions. The
command should not create a progress bar because its stdout may be piped
directly into staging tooling.

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
- private JWK content never appears in bootstrap human output, progress
  messages, general JSON output, dry-run output, errors, debug logs, snapshots,
  or telemetry;
- JSON change records may label `.tama.env` as sensitive and report its digest,
  but never its content;
- exceptions from Node crypto or JSON parsing are mapped to bounded generic
  errors; and
- tests use freshly generated ephemeral keys and never commit production-like
  private fixtures.

The standalone command is the narrow exception: `--stdout` deliberately emits
the generated secret because the operator explicitly selected that destination.
`--output` writes it only to the requested file and does not echo it. Neither
mode may copy the JWK to stderr, error details, progress output, or a secondary
result envelope.

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

### Standalone command tests

- Top-level and OAuth-specific help list `oauth generate-key` and its options.
- The command requires exactly one of `--stdout` or `--output`.
- Unknown subcommands and options return the stable usage exit code.
- `--stdout` emits exactly two dotenv assignments with no ANSI, progress,
  heading, or extra JSON envelope.
- The stdout JWK and ID pass the shared validator and match each other.
- An explicit valid `--kid` is embedded in both values; invalid, blank,
  control-bearing, or oversized identifiers are rejected without generation.
- `--output` creates a mode-`0600` file, prints only its path, and leaves stderr
  free of key material.
- Existing files, final symlinks, and symlinked ancestors fail closed without
  modification.
- A failed write does not leave a temporary private file behind.
- Errors generated before or after key creation contain none of the private
  JWK, `d`, `p`, `q`, `dp`, `dq`, or `qi` values.
- The packaged `bin/tama-kit.mjs` entry point can run the command without a Tama
  source checkout.

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
3. Add `oauth generate-key`, top-level routing, explicit destination handling,
   and standalone command tests.
4. Replace the obsolete variables for newly generated bootstrap environments.
5. Add the guarded, marker-aware migration for existing managed `.tama.env`
   files.
6. Update the safe environment example, CLI usage, and README documentation.
7. Select the compatible Tama image and update the pinned bootstrap contract.
8. Add runtime acceptance for startup, public JWKS safety, and token
   verification.
9. Run the complete Tama Kit validation and package inspection.

## Rollout checklist

- [ ] Tama Kit no longer generates `TAMA_OAUTH_SIGNING_KEY`.
- [ ] Tama Kit no longer generates `TAMA_OAUTH_SIGNING_KEY_ID`.
- [ ] `tama-kit oauth generate-key` works without a Tama checkout or Mix.
- [ ] The standalone command requires an explicit stdout or file destination.
- [ ] Output files are exclusive, symlink-safe, and mode `0600`.
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
