# OAuth Private JWK Bootstrap — Implementation Plan

Status: planned
Branch: `feature/oauth-private-jwk-bootstrap` (from `develop`)
Companion proposal: `wip/oauth-private-jwk-bootstrap.md`

## 0. Key findings and hard dependency

- The released Tama `0.13.0` tag still requires the obsolete symmetric
  `TAMA_OAUTH_SIGNING_KEY` / `TAMA_OAUTH_SIGNING_KEY_ID`
  (verified in `0.13.0:config/runtime.exs`). The `TAMA_OAUTH_PRIVATE_JWK`
  contract exists only in unreleased Tama `develop`
  (merged via `feature/tama-oauth-library-adoption`).
- Tama publishes container images **only on release publish**
  (`.github/workflows/docker.yml` is `on: release: published`); `latest-server`
  is re-tagged only when a release publishes from the default branch. No
  compatible image exists in GHCR today.
- **Image pin decision (user):** pin `ghcr.io/upmaru/tama:latest-server` in
  this change. Because `latest-server` floats per Tama release, a **release
  gate** applies: do not publish a Tama Kit release until
  `validate:bootstrap:runtime` passes against the live `latest-server`
  (the JWKS assertions in the harness prove the running image implements the
  new contract). Until Tama publishes, runtime acceptance will fail by design.
- Development loop before the Tama release: build the local Tama `develop`
  checkout with `docker build` and run the runtime harness against it via the
  existing `--image <reference>` bootstrap override.
- Contract reference: `tama_oauth` 0.3.0
  (`tama-oauth/lib/tama_oauth/signing_key.ex`) — limits: 65,536 encoded key
  bytes, 128-byte `kid`, no control characters in `kid`, `alg`/`use`/`kid`
  normalization, `key_ops` must contain `sign`.

## 1. New helper: `cli/bootstrap/oauth-key.mjs`

Pure functions, side-effect-free outside CSPRNG. No file I/O, no env reads,
no output.

```text
generateOAuthPrivateJwk() -> { jwk: string, kid: string }
validateOAuthPrivateJwk(encodedJwk, kid) -> void (throws bounded ownershipError)
```

Constants: `MODULUS_BITS = 3072` (explicit, per proposal),
`MAX_ENCODED_JWK_BYTES = 65_536`, `MAX_KID_BYTES = 128` (mirroring
`TamaOAuth.SigningKey`).

`generateOAuthPrivateJwk()`:

1. `generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 })`
2. Private JWK via `privateKey.export({ format: "jwk" })`.
3. RFC 7638 thumbprint over the canonical public members only,
   `{"e":"…","kty":"RSA","n":"…"}` (sorted keys, no whitespace), SHA-256,
   Base64url; `kid = "oauth-" + thumbprint` (49 bytes total, within the 128
   limit).
4. Return single-line JSON with normalized, stable member order
   `alg, kid, kty, use, n, e, d, p, q, dp, dq, qi`
   (`alg=RS256`, `kty=RSA`, `use=sig`, `kid` as derived).

`validateOAuthPrivateJwk()` (must accept everything Tama's loader accepts and
reject everything it rejects; member order irrelevant):

1. Encoded size within `1..65_536` bytes.
2. Configured `kid` within `1..128` bytes, non-blank, no control characters.
3. Parse exactly one JSON object; reject arrays and JWKS documents
   (`keys` array).
4. `kty` must be `RSA`; reject public-only, symmetric (`oct`), and EC material.
5. Metadata compatibility with RS256 signing: `alg` ∈ {absent, `"RS256"`};
   `use` ∈ {absent, `"sig"`}; `kid` ∈ {absent, configured `kid`} (a persisted
   `kid` need not be a thumbprint); `key_ops` ∈ {absent, string list
   containing `"sign"`}.
6. `createPrivateKey({ key: jwk, format: "jwk" })` must succeed, be an RSA
   private key, and `asymmetricKeyDetails.modulusLength >= 2048`.
7. Derive the public key; its JWK `n`/`e` must equal the input JWK's `n`/`e`
   (guards hand-crafted JWKs with mismatched CRT parameters).
8. Any failure throws a bounded generic error that names the variable and
   category ("not a valid RSA private JWK for RS256 signing"), never quoting
   the value or any member.

## 2. `cli/bootstrap/environment.mjs`

- `REQUIRED_ENVIRONMENT_VARIABLES`: replace `TAMA_OAUTH_SIGNING_KEY` and
  `TAMA_OAUTH_SIGNING_KEY_ID` with `TAMA_OAUTH_PRIVATE_JWK` and
  `TAMA_OAUTH_PRIVATE_JWK_ID`.
- `newEnvironment(port)`: call `generateOAuthPrivateJwk()`; write the two new
  lines in the same position the obsolete lines currently occupy.
- `validateEnvironment()`: after the non-empty check, run
  `validateOAuthPrivateJwk(jwk, kid)` on the persisted pair.
- `postgresEnvironment()` unchanged — the JWK never reaches
  `.tama.postgres.env` (it already copies only the three Postgres variables).

### Migration state machine (existing `.tama.env`)

Add a classification step in the existing-file branch of `planEnvironment`,
before port updates and validation. Export `hasManagedMarker` from
`cli/bootstrap/files.mjs` (currently private) and reuse it. Treat empty
values as absent.

| New pair (JWK + ID) | Old pair (KEY + KEY_ID) | Managed marker | Action |
| --- | --- | --- | --- |
| both, valid | absent | any | preserve; no diff on rerun |
| both, invalid or kid mismatch | any | any | fail closed (generic JWK/kid error) |
| exactly one present | any | any | fail closed; name both variables |
| absent | both, non-empty | present | **migrate**: generate a fresh pair, replace only the two obsolete lines in place (position, comments, order, all other lines preserved) |
| absent | both, non-empty | absent | fail closed; unmanaged file — instruct adding a valid pair manually, do not claim or rewrite |
| absent | exactly one present | any | fail closed; name both variables |
| absent | absent (or empty) | any | existing missing-variables error (names the two new variables) |

Candidate content = (migrated if applicable) → (port/URL updates if
`requestedPort` given) → `validateEnvironment` on the candidate. This makes
"the rest of the managed environment passes its structural checks" a
precondition of the migration write, and the write still flows through the
existing `operationForContent` atomic write/rollback path.

Errors identify variable names and remediation category only, never values.

Idempotency: a valid persisted pair is never regenerated; `updateEnvironment`
already touches only port-related keys, so port changes, `--start`, and
skill-mode changes cannot rotate the key.

## 3. `cli/templates/bootstrap/tama-env.example`

```dotenv
TAMA_OAUTH_PRIVATE_JWK=replace-me
TAMA_OAUTH_PRIVATE_JWK_ID=replace-me
```

`replace-me` is not a structurally valid private JWK. The rendered
`.tama.env.example` (managed template) inherits this.

## 4. Image pin: `cli/bootstrap/constants.mjs`

`DEFAULTS.tamaImage` → `ghcr.io/upmaru/tama:latest-server`. The compose
template consumes `{{TAMA_IMAGE}}` unchanged. Release gate per section 0.

## 5. Documentation

- `wip/bootstrap-cli.md`: update the example environment block
  (currently lists `TAMA_OAUTH_SIGNING_KEY[_ID]`).
- Bootstrap docs/skills that mention the obsolete variables (repo grep shows
  none beyond the files above; keep the sweep to what the grep finds).

## 6. Tests

### New: `test/cli/oauth-key.test.mjs`

- Generated JWK parses as a private RSA key with the 3072-bit modulus.
- Generated metadata is exactly RS256/sig; `kid` equals configured ID and the
  RFC 7638 thumbprint of the public members.
- Private key signs a payload; derived public key verifies it.
- Public export contains `kty`/`n`/`e` and none of `d`, `p`, `q`, `dp`, `dq`,
  `qi`.
- Two generations differ in key material and `kid`.
- Validation rejects: malformed JSON, JWKS document, public-only JWK,
  symmetric key, EC key, weak (<2048-bit) RSA, conflicting `alg`/`use`,
  mismatched configured ID, oversized encoded key, mismatched public members.
- Every validation error string contains neither the encoded JWK nor any
  private member value.

### Extended: `test/cli/bootstrap.test.mjs`

- New bootstrap writes the two new variables and omits the obsolete ones.
- `.tama.env` stays mode `0600` and git-ignored; `.tama.postgres.env` has no
  OAuth key material.
- Second run preserves JWK + ID byte-for-byte, zero environment diff.
- Port change and skill-mode change preserve the pair.
- Marked legacy environment migrates exactly the two obsolete lines; every
  unrelated line byte-identical.
- Fail-closed: partial new pair, partial old pair, old+new both present,
  malformed/weak/public-only JWK, kid mismatch, unmanaged file (file left
  untouched, error carries manual-remediation guidance).
- `TAMA_JWT_SECRET` present and unchanged through migration.
- Human, JSON, dry-run, progress, and error output never contain the JWK or
  any private RSA member (assert against captured output incl. dry-run JSON).
- `.tama.env.example` contains placeholders only.

### `scripts/validate-bootstrap.mjs`

- `SENSITIVE_ENVIRONMENT_VARIABLES`: replace `TAMA_OAUTH_SIGNING_KEY` with
  `TAMA_OAUTH_PRIVATE_JWK` so failure redaction covers the key.
- Runtime acceptance (after the existing health/setup checks):
  1. `GET /.well-known/jwks.json`
  2. select the entry where `kid === TAMA_OAUTH_PRIVATE_JWK_ID`
  3. assert `kty=RSA`, `alg=RS256`, `use=sig`
  4. assert no `d`, `p`, `q`, `dp`, `dq`, `qi` in the document
  5. assert the entry's `n`/`e` match the public export of the generated
     private JWK read from the fixture `.tama.env`
  6. mint a System OAuth access token headlessly (registration →
     authorization code → token, all plain HTTP) and verify the RS256
     signature and `kid` against the published public key with `node:crypto`

## 7. Verification

```bash
npm test
npm run check
npm run typecheck
npm run format:check
npm pack --dry-run
git diff --check
npm run validate:bootstrap
npm run validate:bootstrap:runtime   # needs a compatible image (see gate)
```

Dev loop before the Tama release: build local Tama `develop`, then
`node bin/tama-kit.mjs bootstrap <tmp> --start --image <local-image-ref>`
and the JWKS/token checks.

## 8. Implementation sequence and commits

1. Add `cli/bootstrap/oauth-key.mjs` + `test/cli/oauth-key.test.mjs`
   (isolated; no bootstrap wiring yet). — `Add OAuth private JWK generation and validation helper`
2. Swap the variables for newly generated environments, update the safe
   example, extend `test/cli/bootstrap.test.mjs`. —
   `Generate asymmetric System OAuth signing keys in bootstrap`
3. Add the marker-aware, fail-closed migration + tests. —
   `Migrate managed bootstrap environments to the private JWK`
4. Pin `ghcr.io/upmaru/tama:latest-server`; extend
   `scripts/validate-bootstrap.mjs` redaction and runtime acceptance. —
   `Pin Tama image and extend bootstrap runtime acceptance`
5. Update `wip/bootstrap-cli.md` and any other found references; run the full
   verification suite. — `Update bootstrap documentation for private JWK`

## 9. Release gate (must be green before publishing Tama Kit)

- Tama publishes a release from `develop` containing the JWK contract,
  moving `latest-server`.
- `npm run validate:bootstrap:runtime` passes against live `latest-server`,
  including the JWKS safety and token-verification assertions.
- Proposal rollout checklist items all satisfied.

## 10. Risks and open items

- Headless consent: the authorization step is a LiveView consent screen.
  `POST /auth/session` and `POST /auth/tokens` are plain controller
  endpoints, so the flow is drivable with `fetch`; if consent approval proves
  flaky, the release gate falls back to JWKS assertions 1–5 plus Tama's own
  Elixir suite for signature proof. Track as an implementation spike in step
  4.
- `latest-server` is a floating tag; the harness's JWKS assertions are the
  contract check that the currently pinned image implements the new contract.
- Legacy HS256 System OAuth tokens are intentionally invalidated at cutover;
  note active clients must reauthorize in the release notes.
- 3072-bit RSA key generation is one-shot per bootstrap/migration
  (hundreds of ms); no action needed.
