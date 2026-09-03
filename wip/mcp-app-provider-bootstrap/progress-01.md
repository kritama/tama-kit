# MCP App Provider Bootstrap — Progress 01

Date: 2026-09-02

Status: local implementation complete — cross-runtime acceptance pending

References:

- `wip/mcp-app-provider-bootstrap.md` (authoritative spec; contains
  `### Resolutions (review-01, 2026-09-02)`)
- `wip/mcp-app-provider-bootstrap/review-01.md` (driving review)

## Worklist (sequenced per review-01 resolution)

| # | Item | Status |
|---|------|--------|
| 1 | Review-01 #1: overlap sets are rotation state, fresh = `[]` | **done** |
| 2 | Review-01 #4: full contract validation before rendering secrets | **done** |
| 3 | Review-01 #5: dry-run side-effect-free and deterministic | **done** |
| 4 | Review-01 #6: explicit allowed origins, exact Tama public origin | **done** |
| 5 | Review-01 #2: single shared transport origin | **done** |
| 6 | Review-01 #3: provider-owned activation step | **done** |
| 7 | Review-01 #7: complete prepared/enabled verification gates | **done** |
| 8 | Review-01 "Remaining WIP gaps" + targeted cleanup | **done** |
| 9 | Full local verification | **done** — real Memovee/Tama acceptance remains external |

## Completion update

The implementation now includes:

- strict bounded v1 contract validation, safe relative paths, exact semantic
  roles, unique environment bindings, endpoint/origin rules, lifecycle sets,
  loader declarations, limits, and negative fixtures;
- placeholder-only secret planning for dry-run, deterministic JSON output, and
  deferred key generation on the write path;
- explicit repeatable client origins, exact persisted provider/Tama topology,
  and mismatch failures for `localhost`, `127.0.0.1`, and `::1`;
- removal of the split transport origin and conditional host-gateway emission
  only for `host.docker.internal`;
- two-phase activation: prepared verification, Tama enable/restart and route
  verification, an explicit provider-owned activation step, then an enabled
  checkpoint only after the provider advertises the exact resource;
- rollback on both enabled startup and probe failures, including a Tama restart
  in prepared mode and an explicit provider-restart requirement when that
  operator-owned process had consumed enabled state;
- structured metadata, JWKS, introspection, protected-resource, route, and
  resource-advertisement probes exposed in JSON results;
- provider fragment Git/index checks, root-anchored ignores, preservation of
  unrelated entries/comments, a 24-character reserved-prefix policy, persisted
  topology, public `.tama.env.example` values, and updated help/docs/prompts;
- explicit `--migrate-provider-identity`, which requires prepared mode and a
  verified new loader, preserves trust material and unrelated entries, writes
  the new fragment, transactionally removes the old managed fragment, and
  updates the manifest without combining migration with activation;
- persisted provider identity drift is rejected before manifest reuse,
  contract lifecycle sets are checked against the prepared/enabled workflow,
  and effective Git ignore rules are verified transactionally so nested
  negations cannot leave generated secrets exposed;
- Linux gateway probes connect to the resolved Docker gateway while retaining
  the provider origin as the HTTP authority for virtual-host routing.

Verification completed on the final local tree with Node 24:

- focused identity, lifecycle, and nested-ignore regressions: 4 passed;
- `npm test` outside the filesystem sandbox: 227 passed, 1 skipped, 0 failed;
- `npm run typecheck`: passed;
- `npm run check`: passed;
- `git diff --check`: passed;
- `npm pack --dry-run`: passed;
- GitHub Actions `Test, lint, and type-check`: passed;
- GitHub Actions `Bootstrap integration and runtime`: passed.

Real Memovee/Tama parser and live JWKS/lifecycle acceptance remains a separate
cross-repository verification item. No result in this document claims that
external runtime acceptance has run.

Sequencing decision (recorded in the WIP resolutions): do #1, #4, #5, #6 in
tama-kit first, then #2, then #3, then #7, then gaps/cleanup, then full
verification. #2 and #3 are user-confirmed product decisions:

- **#2**: single shared origin (host and container reach the same
  `--provider-origin`); `--provider-transport-origin` is removed;
  `extra_hosts` is emitted only when that origin's host is
  `host.docker.internal`; the Tama runtime is not changed.
- **#3**: provider activation is a provider-owned step. Tama Kit never
  executes provider lifecycle commands; it stops at a verified prepared
  checkpoint and prints the provider's activation step. An enabled checkpoint
  is recorded only after both sides are verified live; activation failure
  restores the live prepared state and preserves trust material.

## 1. Overlap sets (review-01 #1) — done

Problem: fresh bootstrap rendered the current public key into its own overlap
set, producing duplicate JWKS key ids that `TamaOAuth.JWKS` rejects.

Implementation:

- `cli/bootstrap/oauth-key.mjs`:
  - Added `OAUTH_JWK_PUBLIC_SET_MAX_ITEMS = 30`.
  - Added `validatePublicJwkSet(encoded, variable)`: array ≤ 30 members;
    each member is a plain object, public-only RSA JWK (`kty: "RSA"`, `n`,
    `e`; none of `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`), `alg`
    `"RS256"` and `use` `"sig"` when present, required bounded unique
    `kid`, per-member and set size bounds, and `createPublicKey` must
    accept the member. Error: `<variable> is not a valid public JWK array
    for RS256 signing`.
  - Added private helpers `isPublicJwkMember(member, kids)`,
    `PUBLIC_JWK_PRIVATE_MEMBERS`, `invalidPublicJwkSetError(variable)`.
  - **Removed** `publicJwkFromPrivateJwk` (dead after this change).
  - TS narrowing note: tsc cannot narrow `member.n`/`member.e` to `string`
    through the base64url helpers, so `isPublicJwkMember` first captures
    `const modulus = isPlainObject(member) && typeof member.n === "string"
    ? member.n : null` (and `exponent` likewise) before calling
    `createPublicKey`.
- `cli/bootstrap/environment.mjs`: added `readRawEnvironmentLine(root,
  filename, variable)` returning the exact on-disk line (quoting/whitespace
  preserved) or `null`.
- `cli/bootstrap/mcp-app.mjs`:
  - Fresh provider overlap set and fresh Tama
    `TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS` render as `[]`.
  - Existing valid persisted overlap lines are re-emitted byte-for-byte from
    the raw file line (`readRawEnvironmentLine`); a present line is validated
    with `validatePublicJwkSet` and a corrupt or unparseable one fails
    closed. On the Tama side a present valid line is omitted from the
    environment update map so `updateEnvironment` leaves it untouched.
  - Removed the `parseJson` helper and the `providerPublicJwk` /
    `introspectionPublicJwk` derivations.
- Tests:
  - `test/cli/oauth-key.test.mjs`: `validatePublicJwkSet` accepts public-only
    RSA members (metadata optional, `null` metadata ok) and rejects private
    members, non-RSA, `HS256`, `use: enc`, null kid, oversized kid,
    malformed `n`, duplicate kids, oversized members, and over-count sets.
  - `test/cli/mcp-app.test.mjs`: main plan test now expects `[]` for both
    overlap sets; added "preserves a valid persisted public JWK overlap set
    byte-for-byte" (rotated distinct keys, different quoting per file;
    fragment + `.tama.env` file ops stay `unchanged`; any other non-unchanged
    op must be the manifest; after `applyOperations`, a third plan is fully
    `unchanged` — convergence) and "fails closed on an invalid persisted
    public JWK overlap set" (private `d` member in the fragment, then
    `kty: "EC"` in `.tama.env`).
  - Ordering gotcha: `planMcpApp` validates the fragment overlap before it
    reads `.tama.env`, so the invalid-set test must restore the fragment to
    valid `'[]'` before corrupting the Tama line.
  - Manifest note: preserving a raw line that changes file bytes makes the
    manifest's recorded digest a legitimate `update` op; the file ops
    themselves stay `unchanged`.

Verification: `node --test` mcp-app + oauth-key = 47 pass; full `npm test`
= 177 tests, 176 pass, 1 skip (pre-existing); `npm run check` and
`npm run typecheck` clean.

Runtime-acceptance part of #1 (real Memovee/Tama JWKS publication from a
fresh config) is deferred with #9; it needs running runtimes plus the
coordinated Memovee contract update (the committed Memovee contract's
`http://127.0.0.1:4000` origin is unusable under the shared-origin decision
because the container cannot reach host loopback).

## 2. Full contract validation (review-01 #4) — in progress

Investigation complete; no code written yet. Target file:
`cli/bootstrap/mcp-app-contract.mjs`.

### Confirmed facts that shape the design

- `unsupportedTamaImage` is already a hard plan gate
  (`cli/bootstrap/mcp-app.mjs:240-243` throws `usageError`); the
  compatibility identifiers are already hard gates in
  `validateMcpAppContract`. What remains is structural validation, binding
  rules, path safety, loader validation, and bounded reads.
- Only `local_development` is consumed by code today
  (`contractLocalOrigin`); the other sections are declarative runtime/gate
  metadata, but v1 treats them as required where both real contracts have
  them.
- The bundled Tama contract
  (`cli/bootstrap/contracts/mcp-app-bootstrap-v1.json`) has no
  `provider`, `bindings`, `environment_loading`, `cache_policy`, or
  `mode_gate_responses` — those must stay optional. It uses extension keys
  (`x-owner`), a variable with no `format`
  (`TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM`), and
  `local_development` values that are full URLs with paths
  (`resource`, `*_jwks_uri`, …) — so only keys ending in `_origin` may be
  required to be bare origins.
- The Memovee contract
  (`/home/zacksiri/Work/_kritama/memovee/priv/contracts/tama-mcp-app-bootstrap-v1.json`)
  has `provider`, all 9 `bindings`, `environment_loading`
  (`mechanism: "direnv"`, `loader: ".envrc"`,
  `loads: ".memovee.integration.env"`), `cache_policy`, and
  `mode_gate_responses` (`{status, error}` per probe).
- The test fixture `memoveeContract()`
  (`test/cli/mcp-app.test.mjs:56`) currently has a minimal lifecycle
  (`modes` only) and no variables/endpoints/availability/local_loopback.
  It must be enriched to the full v1 shape when the validator tightens.
- The existing "validateMcpAppContract enforces the bootstrap schema" test
  feeds minimal documents; the first throws must remain
  `schema_version` / `compatibility_identifier` / `lifecycle.modes`, in that
  order.
- `parseContract` and the `priv/contracts/` scan in
  `discoverProviderContract` read files with no size bound.

### Finalized design

Top level:

- Keep the existing `schema_version === "1"` and
  `compatibility_identifier` checks.
- Reject unknown top-level keys except `supported_*` keys, which must be
  non-empty strings (version ranges, e.g. `supported_tama_versions`,
  `supported_memovee_versions`).
- Required sections: `lifecycle`, `variables`, `public_endpoints`,
  `availability`, `local_development`, `local_loopback`.
- Optional sections: `provider`, `bindings`, `environment_loading`,
  `cache_policy`, `mode_gate_responses`.

Section rules:

- `lifecycle`: exactly the keys `modes`, `default_production_mode`,
  `configured_modes`, `enabled_modes`. `modes` must include all three of
  `disabled`, `prepared`, `enabled` (existing message), be unique, and be
  supported; the other three fields must be unique subsets of `modes`
  (`default_production_mode` a single mode).
- `variables`: non-empty object; every key matches
  `[A-Z][A-Z0-9_]*`; each spec is an object with only the keys
  `required`, `required_in`, `format`, `exact_path`, `same_origin_as`,
  `max_bytes`, `max_items`, `initial_value`, `allowed_values`, `values`,
  `default`, `x-sensitive`, plus any `x-*` extension. Exactly one of
  `required` (boolean) or `required_in` (unique lifecycle modes) must be
  present. `format` ∈ {`absolute-uri`, `absolute-origin`,
  `comma-separated-absolute-origins`, `comma-separated-list`,
  `bounded-identifier`, `private-json-jwk`, `public-json-jwk-array`}.
  `exact_path` matches `^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$`.
  `same_origin_as` must reference a declared variable. `max_bytes` /
  `max_items` are positive integers. String and string-array values must be
  non-empty and contain no control characters (newline/equals injection
  guard). `x-sensitive` is a boolean when present.
- `public_endpoints`: non-empty object of safe absolute paths (same regex as
  `exact_path`).
- `availability`: object that declares all lifecycle modes; each value is a
  probe name → boolean map.
- `local_development`: non-empty object; keys are lowercase dotted/hyphen
  identifiers; values are non-empty strings without control characters; keys
  ending in `_origin` must be bare http(s) origins (no path, query, or hash).
- `local_loopback`: non-empty object of strings or non-empty string arrays.
- `provider`: exactly `name` (lowercase kebab-case, matching
  `normalizeProviderName` output), `environment_prefix`
  (`[A-Z][A-Z0-9_]*`), and `environment_file`.
- `provider.environment_file` and `environment_loading.loader` / `.loads`:
  safe project-root-relative path — not absolute, no backslashes, at most 3
  segments, each matching `[A-Za-z0-9._-]+`, no `.`/`..`, no empty segments,
  no control characters, ≤ 256 bytes total. This rejects traversal
  (`../x`), absolute paths, and newline/equals injection.
- `bindings` (when present): every one of the 9 semantic roles is declared
  exactly once, every value matches `[A-Z][A-Z0-9_]*`, and all 9 resolved
  names are unique (duplicate names name both offending roles). The same
  checks are added to `resolveBindings` so the function stays safe when
  called with an unvalidated document (existing tests call it directly).
- `environment_loading` (when present): exactly `mechanism`, `loader`,
  `loads`; `mechanism` is a non-empty string without control characters;
  `loader`/`loads` are safe relative paths; when both `loads` and
  `provider.environment_file` are present they must be equal.
- `cache_policy`: non-empty object of non-empty strings.
- `mode_gate_responses`: object keyed by lifecycle modes; each probe is
  either `{available: boolean}` or `{status: 100..599, error: non-empty
  string}`.

Read bounds:

- `parseContract`: `lstatSync` first; missing/symlink → existing
  "does not exist" error; size > 256 KiB → `usageError` "too large".
- `discoverProviderContract` scan: skip files > 256 KiB (they cannot be
  contracts).

Negative fixtures to add (new test, e.g. "validateMcpAppContract rejects
malformed v1 contracts", plus a bounded-read test):

- lifecycle missing `default_production_mode`; `enabled_modes` with an
  unknown mode.
- missing `variables`; `required` and `required_in` both set; unknown
  `format`; `exact_path` without leading slash and `exact_path` containing a
  newline (`"/mcp/app\nINJECT=1"`); `same_origin_as` to an undeclared
  variable; `max_bytes: 0`; invalid variable key (`"BAD NAME"`); unknown
  variable spec key.
- `public_endpoints` value without leading slash / with a query string.
- `availability` missing a mode.
- `local_development` `_origin` value with a non-http(s) scheme.
- `provider.environment_file` = `"../escape.env"` and `"/etc/passwd"`.
- `environment_loading` missing `mechanism`; `loads` differing from
  `provider.environment_file`.
- duplicate binding names (two roles → one variable); invalid binding name.
- `mode_gate_responses` status outside 100..599.
- `supported_*` range that is not a string.
- unknown top-level key.
- oversized contract file: discovery skips it; explicit path fails with
  "too large".

Also enrich the `memoveeContract()` fixture with the full v1 shape (complete
lifecycle, `variables` for all 9 bound names, `public_endpoints`,
`availability` for all modes, `local_loopback`, and
`supported_memovee_versions`) so `validContract()` stays green.

## 3. Dry-run determinism (review-01 #5) — pending, design finalized

- `planMcpApp` gains `materializeKeys: boolean`. Dry-run (`false`): no
  keypair generation; missing secrets are represented with placeholder kids
  (`mcp-app-provider-pending` / `mcp-app-tama-pending`) and the sentinel
  value `PENDING_KEY_MATERIAL = "__tama-kit-pending-key-material__"` in the
  sensitive create/update operations. Write path (`true`): keys are
  generated inside `planMcpApp` after all ownership/Git/ignore/path/contract
  validations, before `planEnvironment`.
- `createBootstrapPlan` passes `materializeKeys: !dryRun` via a new
  `BootstrapPlanOptions.materializeKeys`.
- `validateMcpAppVariables` skips the JWK parse when the value is the
  sentinel (dry-run).
- Both private files already land in one `applyOperationsTransactionally`
  transaction; keep that.
- Tests: injectable `generateKeyPair` spy proves it is never called during
  dry-run; two identical `--dry-run` JSON outputs are byte-for-byte equal.

## 4. Allowed origins and exact Tama origin (review-01 #6) — pending, design finalized

- New `--tama-origin` flag (replaces the hard-coded
  `http://localhost:<port>`). Resolution order: explicit flag (normalized
  origin; its port must equal the resolved Tama port) → origin derived from
  the persisted `TAMA_MCP_APP_RESOURCE` in `.tama.env` (resource minus
  `/mcp/app`; a port mismatch is a usage error) → default from the accepted
  contract's `local_development.<provider>_origin` / Tama contract
  `local_development.tama_origin` host plus the resolved port
  (→ `http://127.0.0.1:<port>`). Validation: http only for loopback hosts or
  https; no path/query/hash; exact origin preserved on reruns.
- Allowed origins are explicit: repeatable `--allowed-origin`; non-interactive
  runs require at least one when the selected lifecycle needs them;
  interactive runs prompt and confirm. They are never inferred from service
  origins; the current auto-insertion of Tama's own origin is removed.
  Per-entry validation: origin format, https or loopback-http, ≤ 32 unique
  entries.
- The resolved allowed origins are threaded into the plan options
  (`prepareMcpApp` returns them; `planMcpApp` requires a non-empty
  `options.allowedOrigins`). Note: `mcpAppOptions` is built twice in
  `cli/commands/bootstrap.mjs` (separate object references) — thread the
  resolved value through both.
- Tests must cover `localhost` vs `127.0.0.1` vs `::1` mismatch (exact
  identifiers, not interchangeable) and non-inference.
- Known test impact: `planWithMcp`/`buildVerifiedRoot` fixtures must pass
  `allowedOrigins` explicitly; `mcp-app-verify` fetch mocks currently key on
  `url.includes("localhost")` and will collide once the Tama origin host is
  `127.0.0.1` — switch fixtures to distinct ports (provider 4000, Tama 4001)
  and key mocks on full URL.
- `cli/types.mjs`: `McpAppBootstrapOptions` += `tamaOrigin?`;
  `McpAppPrepared` += `allowedOrigins: string[]`;
  `BootstrapPlanOptions` += `materializeKeys?` (shared with #5).
- Legacy `TAMA_MCP_ALLOWED_ORIGINS` on `localhost:<port>` for the old `/mcp`
  endpoint is untouched.

## 5. Single shared transport origin (review-01 #2) — pending, design finalized

- Remove `--provider-transport-origin` and the transport rewrite of
  `TAMA_MCP_APP_JWKS_URI` / `TAMA_MCP_APP_INTROSPECTION_ENDPOINT`; all three
  Tama service URLs keep the one public `--provider-origin` (issuer stays
  bound to the same origin — no validation weakening).
- `TAMA_EXTRA_HOSTS` in the compose template is emitted only when the
  provider origin's host is `host.docker.internal`
  (`cli/bootstrap/plan.mjs:93`, template block at `plan.mjs:25`).
- Tama runtime unchanged. Acceptance against the selected Tama image is part
  of #9.

## 6. Provider-owned activation (review-01 #3) — pending, design finalized

- `--activate` no longer flips the provider to enabled: initial write and
  prepared verification keep both sides `prepared`.
- Tama is activated first (file rewrite to enabled + compose restart), then
  verified (metadata, `/mcp/app` route, exact resource).
- Provider activation is reported as a provider-owned step derived from the
  contract (its lifecycle/environment mechanism); Tama Kit never executes it.
  The enabled checkpoint is recorded only after the operator activates the
  provider and both sides verify live.
- Any activation failure restores the prepared files and restarts/reloads
  every process that consumed enabled values; trust material (keys, overlap
  sets) is preserved.
- Result/checkpoint reporting is secret-free and only recorded once live
  state matches the requested mode.

## 7. Verification gates (review-01 #7) — pending

- Prepared verification becomes a hard gate when `--start` is requested
  (currently a failed prepared verify returns success; only enabled verify
  throws).
- Add probes: provider authorization-server metadata (+ exact issuer/JWKS
  relationship), both expected current public key ids and algorithms,
  authenticated inactive-token introspection with the expected audience;
  enabled mode adds protected-resource metadata, `/mcp/app` route
  availability, and exact Tama resource advertisement by the provider.
- Return structured per-probe diagnostics (name, ok, reason); no assertions,
  tokens, or private material in output.
- Never report "Tama is ready" / `verified: true` / an enabled checkpoint
  while any required probe failed.
- Replace `verified` booleans with explicit probe results (also a review
  cleanup item).

## 8. WIP gaps and cleanup (review-01) — pending

Gaps: tracked/staged secret-file validation must include the provider
fragment; root-anchored ignore protection before private-file creation and
after later negations; preserve unrelated env entries/comments (partially
met by #1's line-preserving updates); reject reserved prefixes and
collisions with existing env keys; reduce the environment-prefix maximum to
the documented bound or update the WIP; explicit identity migration command
or flag; persist and compare the exact accepted public/transport topology on
reruns (interacts with #4/#6); `.tama.env.example` public MCP App values;
bootstrap help + README + agent prompt + new-provider docs; coordinated
Memovee contract update + runtime parser acceptance (separate repo).

Cleanup: split `cli/bootstrap/mcp-app.mjs` (contract/state resolution,
environment rendering, key-state planning); split
`test/cli/mcp-app.test.mjs` by contract/identity/filesystem/lifecycle/
verification concerns; one topology value object instead of ad hoc URL
assembly; derive endpoint paths/bounds from the validated contracts instead
of duplicated string constants; explicit probe results instead of
`verified` booleans; superseded-WIP removal in its own commit.

Note: `wip/bootstrap-cli.md`, `wip/dev-http-port-selection-plan.md`,
`wip/oauth-private-jwk-bootstrap-plan.md`, and
`wip/oauth-private-jwk-bootstrap.md` are currently deleted in the working
tree (superseded documents) — keep that removal in a separate commit.

## 9. Full verification (exit criteria) — pending

- Focused tests per change; full `npm test` (currently 177 tests, 176 pass,
  1 pre-existing skip after #1); `npm run check` + `check:fix`;
  `npm run typecheck`; `git diff --check`.
- Compose validation of the rendered stack.
- Real runtime acceptance (blocked on running Memovee + Tama and the
  coordinated Memovee contract update): fresh prepared config accepted by
  both runtime parsers; both JWKS documents publish exactly one current key;
  shared-origin topology accepted; staged activation recoverable to live
  prepared state.

## Environment and state

- Repo: `/home/zacksiri/Work/_kritama/tama-kit`, branch
  `feature/mcp-app-provider-bootstrap`, Node v26.7.0, ESM `.mjs`, biome,
  `node --test`. Scripts: `check`, `check:fix`, `typecheck`, `test`.
- Tama runtime: `/home/zacksiri/Work/_upmaru/tama` (clean `develop`,
  0.13.1). Memovee: `/home/zacksiri/Work/_kritama/memovee`. Shared lib:
  `/home/zacksiri/Work/_kritama/tama-oauth`.
- All feature work is uncommitted (do not commit unless asked).
- Tama runtime facts relied on: `Tama.MCP.App.Policy.validate/1` requires
  exact paths, same-origin JWKS/introspection vs authorization server,
  ≤30 introspection keys, ≤32 unique allowed origins, http-only-for-loopback;
  there is no cross-validation between `TAMA_MCP_APP_RESOURCE` and
  `TAMA_BASE_URL`/`TAMA_OAUTH_ISSUER`; `TamaOAuth.URI.same_origin?/2`
  compares scheme+host+port (`localhost:4000` ≠ `127.0.0.1:4000`).
- Memovee facts: `MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS` optional, default `[]`,
  ≤30 keys/2 MB; duplicate kid in the overlap set fails its key provider.

## Next steps

1. Finish #4: implement the finalized `validateMcpAppContract` design in
   `cli/bootstrap/mcp-app-contract.mjs`, the `resolveBindings` name/
   uniqueness rules, safe-path helpers, bounded reads, the negative-fixture
   tests, and the enriched `memoveeContract()` fixture. Verify with
   `npm run check`, `npm run typecheck`, `npm test`.
2. Proceed to #5 (dry-run determinism), then #6 (allowed origins/Tama
   origin), then #2 (shared transport origin), then #3 (activation), then
   #7 (verification gates), then #8 gaps/cleanup, then #9 full
   verification.
