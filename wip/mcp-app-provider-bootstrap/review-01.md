# MCP App Provider Bootstrap Review 01

Date: 2026-09-02

Status: implementation addressed locally; cross-runtime acceptance pending

Reviewed against: `wip/mcp-app-provider-bootstrap.md`

Review target: the complete working tree on
`feature/mcp-app-provider-bootstrap`, including the uncommitted implementation.

## Implementation follow-up (2026-09-02)

All seven blocking code changes and the local WIP safety gaps identified below
have been implemented in the current working tree:

- fresh overlap sets are empty rotation state and persisted sets are validated;
- one exact shared provider origin is used for issuer, JWKS, and introspection;
- activation is prepared-gated, Tama-restart-aware, provider-owned, and
  recoverable to prepared configuration;
- v1 contracts and semantic bindings are fully and boundedly validated;
- dry-run is deterministic, secret-free, and does not generate keys;
- client origins are explicit and exact topology is persisted and compared;
- verification returns per-probe diagnostics and gates prepared/enabled state;
- the provider fragment participates in Git safety checks, root-anchored ignore
  rules precede secret writes, unrelated entries are preserved, prefixes are
  bounded/reserved, and explicit transactional identity migration is present;
- public example values, CLI help, root/generated documentation, the agent
  prompt, and provider-integration documentation are updated.

Local verification is green: `npm test` reports 184 passed and 1 environment-
dependent skip; type checking, Biome, focused MCP App tests, Compose config,
and `git diff --check` pass. `validate:bootstrap` reaches and passes Docker
Compose configuration but cannot finish Terraform validation because this host
has neither Terraform nor a configured OpenTofu version.

The only remaining exit criterion is real Memovee/Tama runtime acceptance and
the coordinated Memovee contract update in its separate repository. That work
cannot be honestly claimed by this Tama Kit branch alone.

## Outcome

The provider-root bootstrap architecture and ownership boundaries are sound,
but the implementation is not ready to merge or use for activation. Several
runtime and lifecycle requirements in the WIP are either incomplete or
implemented incompatibly with the current Memovee and Tama parsers.

The blocking changes below should be completed before documentation polish or
contract scaffolding follow-up work.

## Blocking changes

### 1. Do not put the current key in its own overlap set

`cli/bootstrap/mcp-app.mjs` currently renders the provider's current public key
into `access_token_public_overlap_keys` and Tama's current introspection public
key into `TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS`.

Both runtimes already prepend the public half of the current private signing
key when constructing their JWKS documents. `TamaOAuth.JWKS` rejects duplicate
key identifiers, so the generated fresh configuration can make both public
JWKS documents invalid.

Required change:

- Render `[]` for both overlap sets on a fresh bootstrap.
- Treat overlap keys as rotation state, not as the public half of the current
  key.
- Preserve existing valid overlap arrays byte-for-byte on a normal rerun.
- Validate their public-only JWK members, algorithms, unique key identifiers,
  size bounds, and maximum item counts.
- Add runtime-acceptance tests proving that Memovee and Tama can construct and
  publish their JWKS documents from a freshly rendered configuration.

Relevant code:

- `cli/bootstrap/mcp-app.mjs`
- `Memovee.OAuth.KeyProvider.public_jwks/0`
- `Tama.OAuth.Introspection.KeyProvider.public_jwks/0`
- `TamaOAuth.JWKS.public_document/1`

### 2. Coordinate the transport-origin contract with Tama

The planner currently keeps `TAMA_MCP_APP_AUTHORIZATION_SERVER` on the public
provider origin while rewriting `TAMA_MCP_APP_JWKS_URI` and
`TAMA_MCP_APP_INTROSPECTION_ENDPOINT` to a different transport origin.

The current Tama runtime requires both service endpoints to have the same
origin as `TAMA_MCP_APP_AUTHORIZATION_SERVER`. A differing
`--provider-transport-origin` therefore produces configuration that the current
runtime rejects.

Required change:

- Choose and implement one coordinated runtime contract:
  - add an explicit Tama-only local transport override used only for network
    fetching while retaining the public endpoint identifiers; or
  - require one hostname/origin that is reachable from both the host and the
    container; or
  - require the provider to join the Compose network.
- Do not weaken issuer or endpoint-origin validation merely to accept a second
  arbitrary host.
- If an explicit transport override is adopted, restrict it to managed local
  development, validate an allow-listed local/container topology, and add
  issuer-confusion regression tests in Tama.
- Keep `extra_hosts` conditional on the selected topology rather than on the
  mere presence of any differing HTTP origin.
- Add acceptance coverage against the selected Tama image before claiming
  Phase 4 complete.

Relevant code:

- `cli/bootstrap/mcp-app.mjs`
- `cli/bootstrap/plan.mjs`
- `Tama.MCP.App.Policy.validate_trusted_endpoint/5`

### 3. Make activation and rollback change runtime state, not only files

`--activate` currently renders both applications as enabled before starting
Tama. If verification fails, rollback rewrites the files to prepared but does
not restart or reload either application. Processes may therefore continue
running with enabled configuration after the command reports rollback.

The host-native provider is also never restarted or reloaded after its fragment
changes, so writing provider mode does not prove that the provider is operating
in that mode.

Required change:

- Keep both sides prepared during initial write and prepared verification.
- Activate Tama first, restart/reload it, and verify its metadata and route.
- Activate the provider only through a contract-declared lifecycle mechanism;
  restart/reload it and verify exact resource advertisement.
- If Tama Kit cannot safely control the provider lifecycle, stop after a
  prepared checkpoint and report an explicit provider-owned activation step.
- On every activation failure, restore prepared configuration and restart or
  reload every process that consumed the enabled values.
- Preserve trust material during rollback.
- Record a secret-free checkpoint only after live state matches the requested
  lifecycle mode.

Relevant code:

- `cli/commands/bootstrap.mjs`
- `cli/bootstrap/mcp-app-verify.mjs`
- `cli/bootstrap/start.mjs`

### 4. Fully validate provider contracts before rendering secrets

`validateMcpAppContract` currently validates only the top-level schema version,
compatibility identifier, and presence of lifecycle modes. Binding values are
accepted as any non-empty string.

This permits malformed or duplicate environment bindings, unsafe fragment
paths, incomplete endpoint declarations, invalid loader metadata, unexpected
lifecycle shapes, and contract/runtime drift to reach secret-file planning.

Required change:

- Validate all required v1 sections and reject unexpected incompatible shapes.
- Require each resolved binding to match `[A-Z][A-Z0-9_]*`.
- Require every semantic role to resolve exactly once and every resulting
  environment variable name to be unique.
- Validate `provider.environment_file` as a safe project-root-relative filename
  or a deliberately supported bounded relative path.
- Validate variable formats, `required_in`, exact paths, same-origin
  relationships, item/byte bounds, lifecycle sets, endpoints, provider
  identity, and `environment_loading`.
- Bound contract file reads.
- Make the provider and bundled Tama compatibility identifiers and selected
  runtime-version ranges hard plan gates.
- Add negative fixtures for newline/equals injection, duplicate role bindings,
  path traversal, malformed loader declarations, invalid endpoints, and
  unsupported version ranges.

Relevant code:

- `cli/bootstrap/mcp-app-contract.mjs`
- `cli/bootstrap/provider-identity.mjs`
- `cli/bootstrap/contracts/mcp-app-bootstrap-v1.json`

### 5. Make dry-run side-effect-free and deterministic

The planner generates two real RSA keypairs whenever the private files do not
already contain keys. The same planner runs for `--dry-run`, so dry-run performs
cryptographic key generation and produces different sensitive operation
digests on identical invocations.

Required change:

- During dry-run, represent missing secrets as future sensitive create/update
  operations without generating key material.
- Generate keys only within the write path after all ownership, Git, ignore,
  path, and contract validations have succeeded.
- Keep both private files in the same transaction and roll back all changes if
  later validation fails.
- Ensure repeated JSON dry-runs are byte-for-byte deterministic for unchanged
  public inputs.
- Add an injectable generator test proving it is never called during dry-run.

Relevant code:

- `cli/bootstrap/mcp-app.mjs`
- `cli/bootstrap/plan.mjs`
- `cli/commands/bootstrap.mjs`
- `cli/bootstrap/write.mjs`

### 6. Keep allowed origins explicit and use exact public identifiers

The planner always inserts Tama's own public origin into
`TAMA_MCP_APP_ALLOWED_ORIGINS`. The WIP assigns Origin policy to the actual
browser/MCP client context and explicitly says it must not be inferred from the
provider or Tama origin.

The planner also derives the Tama origin as `http://localhost:<port>`, while the
bundled and Memovee contracts currently commit to exact `127.0.0.1` public
identifiers. These hostnames must not be treated as interchangeable OAuth
resource identifiers.

Required change:

- Require at least one explicit `--allowed-origin` in non-interactive mode when
  the selected lifecycle requires allowed origins.
- Prompt for and confirm client origins interactively; do not infer them from
  service origins.
- Resolve the Tama public origin from an explicit flag, accepted contract, or
  persisted topology and preserve it exactly on reruns.
- Use that exact origin consistently for resource, introspection client ID,
  provider-side Tama JWKS URI, metadata, verification, and result output.
- Add mismatch tests for `localhost`, `127.0.0.1`, and `::1`.

Relevant code:

- `cli/bootstrap/mcp-app.mjs`
- `cli/bootstrap/environment.mjs`
- `cli/bootstrap/contracts/mcp-app-bootstrap-v1.json`

### 7. Complete prepared and enabled verification gates

The verifier currently checks the provider JWKS, Tama JWKS, and authenticated
inactive-token introspection. It does not check provider authorization-server
metadata, Tama protected-resource metadata, `/mcp/app` availability, or exact
resource advertisement. A failed prepared verification is also returned as a
successful bootstrap result; only enabled verification failure throws.

Required change:

- Prepared verification must be a gate when `--start` is requested.
- Verify provider authorization-server metadata and its exact issuer/JWKS
  relationships.
- Verify both expected current public key identifiers and algorithms.
- Verify authenticated inactive-token introspection with the expected audience.
- In enabled mode, verify protected-resource metadata and `/mcp/app` route
  availability.
- Verify that the provider advertises the exact Tama resource only after the
  provider is enabled.
- Return structured per-probe diagnostics without assertions, tokens, or
  private key material.
- Do not report `Tama is ready`, `verified: true`, or an enabled checkpoint when
  any required probe failed.

Relevant code:

- `cli/bootstrap/mcp-app-verify.mjs`
- `cli/commands/bootstrap.mjs`
- `cli/bootstrap/plan.mjs`

## Remaining WIP gaps

These are required by the WIP but may follow the blocking runtime fixes above:

- Include the provider fragment in tracked and staged secret-file validation.
- Ensure root-anchored ignore protection is established before private-file
  creation and remains effective after later negations.
- Preserve unrelated environment entries and comments rather than replacing the
  complete provider fragment.
- Reject reserved prefixes and collisions with existing environment keys.
- Reduce the environment-prefix maximum to the documented conservative bound,
  or update the WIP with a justified replacement bound.
- Implement an explicit identity migration command or flag. Do not instruct
  users to edit the manifest and remove the fragment manually.
- Persist and compare the exact accepted public and transport topology on
  reruns.
- Add `.tama.env.example` public MCP App values without live secrets.
- Update bootstrap help, root README, generated README, agent prompt, and new
  provider integration documentation.
- Complete the coordinated Memovee contract update and runtime parser
  acceptance tests.

## Code cleanup

- Split `cli/bootstrap/mcp-app.mjs` into contract/state resolution, environment
  rendering, and key-state planning modules after the lifecycle contract is
  fixed.
- Split `test/cli/mcp-app.test.mjs` by contract, identity, filesystem,
  lifecycle, and verification concerns.
- Replace ad hoc URL assembly with one topology value object that carries exact
  public and transport endpoints.
- Derive endpoint paths and bounds from the validated contracts rather than
  duplicating string constants across planning, validation, public output, and
  verification.
- Replace `verified` booleans with explicit probe results so diagnostics cannot
  conflate reachability, key presence, metadata correctness, and introspection.
- Keep removal of superseded WIP documents in a separate commit from the
  implementation unless their retirement is part of the intended review.

## Verification completed during this review

- `npm test`: 172 passed, 1 skipped.
- `npm run typecheck`: passed.
- `npm run check`: passed.
- `git diff --check`: passed.

The initial sandboxed full-test attempt encountered `spawnSync git EPERM` in
tests that create temporary Git repositories. The suite was rerun outside that
sandbox constraint and passed. This was an environment limitation, not a
product failure.

No real Memovee/Tama runtime acceptance was exercised by the Node test suite.
That acceptance is required before the implementation can be considered sound,
particularly for JWKS construction, transport-origin validation, lifecycle
restarts, and exact resource metadata.

## Exit criteria for Review 01

Review 01 is addressed when:

1. Fresh prepared configuration is accepted by both real runtime parsers and
   both JWKS documents publish exactly one current key.
2. The selected transport topology is accepted by the coordinated Tama runtime
   contract without weakening public issuer binding.
3. Prepared verification is a hard gate and enabled activation is staged,
   restart-aware, and recoverable to live prepared state.
4. Provider contracts and semantic bindings are fully validated before secret
   generation or file planning.
5. Dry-run generates no keys and produces deterministic JSON.
6. Exact public origins and allowed client origins are explicit, persisted, and
   verified.
7. Focused tests, the full Tama Kit suite, real Memovee/Tama parser acceptance,
   Compose validation, type checking, formatting/linting, and diff checks all
   pass.
