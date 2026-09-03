# MCP App Local Contract Generation

Status: implemented on `feature/mcp-app-contract-scaffolding` after the
provider-bootstrap contract schema, identity resolution, conventional
bindings, discovery, loader verification, and manifest drift behavior in
`mcp-app-provider-bootstrap.md` stabilized.

## Summary

Extend `tama-kit bootstrap --mcp-app` so Tama Kit materializes its resolved
local MCP App provider contract under the managed Tama root before it plans the
provider and Tama environment variables.

The default path is:

```text
tama/contracts/mcp-app-provider-v1.json
```

When the provider application commits an authoritative compatible contract,
Tama Kit resolves that contract and records the local projection it will use.
When the provider has no contract, Tama Kit renders the same local projection
from its bundled bootstrap-v1 template, accepted provider identity,
conventional semantic bindings, endpoint paths, and loader evidence.

The generated local contract is immediately used by the same bootstrap plan to
generate all development environment values. It is a Tama Kit-managed local
configuration artifact, not a claim that the provider application implements
the OAuth runtime contract.

## Goal

Allow a provider repository without a committed MCP App contract to complete
local development bootstrap without duplicating variable-name derivation
across the planner or requiring the provider to adopt a production/runtime
contract first.

The workflow is:

1. Discover an application-owned provider contract when one exists.
2. Resolve and confirm the stable provider identity.
3. Resolve semantic bindings, endpoint paths, and environment-loading status.
4. Render the normalized local contract in memory.
5. Use that contract to plan both owner-specific environment files and the
   rest of the MCP App development topology.
6. Write the local contract and all other managed bootstrap changes in one
   transaction.
7. Reuse and drift-check the persisted contract on later runs.

## Decisions

1. The local contract lives under `tama/contracts/`, inside Tama Kit's managed
   development root.
2. Local contract generation is part of `tama-kit bootstrap --mcp-app`; it does
   not require a separate `init`, `validate`, or `promote` command.
3. The contract is rendered before provider and Tama environment planning, so
   all variable generation consumes one normalized contract model.
4. The file write remains part of the existing inspect-plan-write transaction.
   A failed bootstrap rolls it back with the other managed files.
5. The local contract is non-secret. It contains variable names, public
   endpoint paths, identity, provenance, and loader evidence, but never private
   JWKs, tokens, assertions, passwords, or environment values.
6. An application-owned contract discovered in `priv/contracts/` remains
   authoritative for provider-declared identity and bindings. The generated
   local contract records the normalized projection and its source; it does
   not overwrite or modify the provider contract.
7. Without an application-owned contract, the generated contract records
   `source: "generated"` and conventional bindings from the accepted prefix.
8. An unverified loader remains explicitly unverified. Local contract
   generation does not turn the presence of an object into loader evidence.
9. Provider runtime implementation remains provider-owned. Local contract
   generation configures development inputs but does not implement or certify
   metadata, JWKS, introspection, authorization, or lifecycle behavior.
10. Schema upgrades follow normal managed-file upgrade rules and must preserve
    stable provider identity, bindings, and secrets referenced by the contract.

## Scope

In:

- A bundled, non-secret local provider-contract template and renderer.
- Normalization of provider-owned and conventional sources into one local
  contract model.
- Automatic planning of `tama/contracts/mcp-app-provider-v1.json` before MCP
  App environment generation.
- Immediate use of the rendered contract for all provider-side semantic
  bindings and endpoint paths.
- Persistence of source provenance, accepted identity, exact bindings, loader
  status, and loader evidence.
- Transactional, idempotent managed-file writes and upgrades.
- Deterministic dry-run, human, and JSON reporting without secret material.
- Drift checks between the manifest, provider-owned source contract, local
  contract, and environment fragment.

Out:

- Writing, updating, or promoting a provider-owned contract under
  `priv/contracts/`.
- Editing arbitrary provider application source or environment loaders.
- Implementing OAuth, JWT, JWKS, introspection, metadata, lifecycle, consent,
  grants, refresh, revocation, or token behavior.
- Treating generated local configuration as proof of provider runtime
  compatibility.
- Moving secrets into the local contract or sharing private keys across owner
  boundaries.
- Production deployment, activation authority, rollback policy, or secret
  custody.
- Committing generated files to Git on the provider's behalf.

## Ownership boundary

The two contract locations have different owners and meanings:

| Location | Owner | Meaning |
| --- | --- | --- |
| `priv/contracts/tama-mcp-app-bootstrap-v1.json` | Provider application | Optional authoritative declaration of provider runtime names and policy |
| `tama/contracts/mcp-app-provider-v1.json` | Tama Kit | Normalized local-development contract used by bootstrap |

Tama Kit may read the provider-owned contract but never manages or rewrites it.
It owns the local contract using the same managed-file protections as the
other generated files under `tama/`.

The local contract must state whether it was derived from a provider contract
or generated conventionally. Consumers must not confuse the generated local
projection with provider runtime certification.

## Resolution and precedence

### First run

1. Discover an explicit `--mcp-app-contract` or one compatible provider
   contract under `priv/contracts/`.
2. Resolve provider identity using the provider-bootstrap precedence rules.
3. If a provider contract declares bindings, validate and use all nine roles.
4. Otherwise, derive all nine roles through the canonical conventional-binding
   resolver from the accepted environment prefix.
5. Verify supported environment-loading evidence.
6. Render the local contract and pass it directly to MCP App environment
   planning.

The renderer must not contain a second variable-suffix table. It consumes the
same resolved binding object that bootstrap already persists and reports.

### Later runs

1. Read the persisted manifest and managed local contract.
2. Rediscover the provider-owned contract, when present.
3. Resolve the current projection without changing accepted identity or
   binding names implicitly.
4. Compare the resolved projection with the manifest and local contract.
5. Treat a schema-only managed-template upgrade separately from identity or
   binding drift.

Identity or binding disagreement fails planning with the existing drift
diagnostic. Tama Kit must not rewrite the provider environment fragment under
new variable names merely because a provider contract, repository directory,
or Git remote changed.

If a provider later adds an application-owned contract whose identity and
bindings match the persisted generated projection, Tama Kit changes local
provenance from `generated` to `provider-contract` without changing generated
environment values or keys. A disagreement fails and requires an explicit
migration workflow outside this scope.

## Local contract schema

The local document has its own schema kind because it is a normalized
development artifact rather than the provider's runtime contract.

Example:

```json
{
  "schema_version": "1",
  "kind": "tama-kit-mcp-app-local-provider-contract",
  "compatibility_identifier": "tama-mcp-app-bootstrap-v1",
  "scope": "local-development",
  "source": {
    "type": "generated",
    "provider_contract_path": null,
    "provider_contract_digest": null
  },
  "provider": {
    "name": "acme",
    "environment_prefix": "ACME",
    "environment_file": ".acme.integration.env"
  },
  "lifecycle": {
    "modes": ["disabled", "prepared", "enabled"]
  },
  "bindings": {
    "mode": "ACME_TAMA_MCP_APP_MODE",
    "issuer": "ACME_OAUTH_ISSUER",
    "resource": "ACME_TAMA_MCP_APP_RESOURCE",
    "access_token_signing_algorithm": "ACME_OAUTH_SIGNING_ALGORITHM",
    "access_token_signing_key_id": "ACME_OAUTH_SIGNING_KEY_ID",
    "access_token_private_signing_key": "ACME_OAUTH_PRIVATE_SIGNING_KEY",
    "access_token_public_overlap_keys": "ACME_OAUTH_PUBLIC_SIGNING_KEYS",
    "introspection_client_id": "ACME_TAMA_INTROSPECTION_CLIENT_ID",
    "introspection_jwks_uri": "ACME_TAMA_INTROSPECTION_JWKS_URI"
  },
  "public_endpoints": {
    "authorization_server_metadata": "/.well-known/oauth-authorization-server",
    "jwks": "/.well-known/jwks.json",
    "introspection": "/auth/introspections"
  },
  "environment_loading": {
    "status": "unverified",
    "mechanism": null,
    "evidence_path": null
  }
}
```

### Required fields

- `schema_version`: the local contract schema version.
- `kind`: distinguishes the document from an application-owned runtime
  contract.
- `compatibility_identifier`: the MCP App bootstrap compatibility target.
- `scope`: always `local-development` in v1.
- `source.type`: `generated` or `provider-contract`.
- `source.provider_contract_path`: provider-root-relative path when the source
  is a provider contract, otherwise `null`.
- `source.provider_contract_digest`: non-secret content digest when the source
  is a provider contract, otherwise `null`.
- `provider`: accepted stable identity and provider environment fragment.
- `lifecycle.modes`: compatibility modes against which bootstrap validates the
  separately planned mode.
- `bindings`: all nine exact semantic role names consumed by environment
  generation.
- `public_endpoints`: exact conventional or provider-declared public paths.
- `environment_loading`: status and supported evidence without claiming
  verification when no evidence exists.

Provider origins, resources, key identifiers, and other per-environment values
belong in the public plan, manifest where required for drift detection, or
private environment files. They are not copied into the local contract unless
the implementation demonstrates that doing so is necessary and stable across
reruns and port changes.

## Template and renderer

Tama Kit may ship a static template for stable JSON shape, but dynamic values
must come from canonical code-owned constants and resolver output:

- compatibility identifier and lifecycle modes from the contract module;
- provider identity from the accepted identity resolver;
- bindings from `resolveBindings`;
- endpoints from the validated provider contract or bootstrap-v1 constants;
- loader status from structured static verification; and
- source path and digest from provider-contract discovery.

The rendered document is validated before any environment content or secret is
generated. Planning fails as an internal contract error if Tama Kit produces a
document that its own local-contract validator rejects.

## Environment generation

`planMcpApp` receives the validated local contract rather than independently
resolving provider variable names. It uses:

- `provider.environment_file` as the provider fragment destination;
- `bindings.mode` through `bindings.introspection_jwks_uri` as the exact
  provider environment variable names;
- `public_endpoints.jwks` and `public_endpoints.introspection` when composing
  provider service URLs; and
- `lifecycle.modes` to validate the mode selected by the bootstrap options.

Tama's own `TAMA_MCP_APP_*` names continue to come from the bundled Tama-side
runtime contract. The local provider contract does not change Tama's ownership
or variable namespace.

The existing secret boundary remains unchanged:

- provider access-token private JWK: provider environment fragment only;
- Tama introspection private JWK: `.tama.env` only;
- local contract, manifest, example files, plans, and command output: no
  private key material.

## Environment-loading evidence

The local contract records `environment_loading.status` as `verified` only
when a supported static check confirms an exact reference to the provider
environment fragment. Initial evidence may include:

- a known shell or direnv file containing an exact fragment reference; or
- an existing provider Compose service whose `env_file` entry resolves to the
  fragment.

Substring matches are insufficient. The verifier reports the supported
mechanism and provider-root-relative evidence path.

When loading cannot be confirmed, the local contract records:

```json
{
  "status": "unverified",
  "mechanism": null,
  "evidence_path": null
}
```

Bootstrap may still generate the provider fragment and complete the prepared
local plan, but it must report that the provider integration is not runnable
until the application-owned loader consumes the file. Generation never turns
an arbitrary `environment_loading` object into verified evidence.

## Managed-file behavior

- The local contract is planned by the existing managed-file planner under
  `tama/`.
- It is written atomically in the same transaction as the manifest,
  environment files, Compose fragment, and Terraform root.
- First run: create the local contract.
- Identical rerun: report unchanged.
- Managed schema/template upgrade with stable resolved semantics: update the
  file and record the new managed digest.
- User-edited managed contract: stop with the existing ownership diagnostic
  rather than overwrite it.
- Provider source contract, identity, or binding drift: stop before generating
  replacement secrets or rewriting environment files.
- Transaction validation failure: restore the previous local contract with the
  rest of the pre-bootstrap snapshot.

The file is non-sensitive and may appear in dry-run and diff summaries. Tama
Kit still reports its path and digests rather than dumping it repeatedly in
normal human output.

## Plan and result output

Human output reports:

- local contract path;
- source type and provider contract path when applicable;
- provider identity and environment file;
- binding source;
- loader status and evidence path; and
- create, update, unchanged, or blocked action.

JSON output adds a non-secret block such as:

```json
{
  "providerContract": {
    "path": "tama/contracts/mcp-app-provider-v1.json",
    "source": "generated",
    "sourcePath": null,
    "compatibilityIdentifier": "tama-mcp-app-bootstrap-v1",
    "environmentLoading": "unverified",
    "action": "create"
  }
}
```

`--dry-run` renders the local contract operation and uses the in-memory
validated document to plan the remaining changes. It writes nothing, performs
no network requests, and emits no private environment values.

## Implementation plan

### Phase 1: local schema and canonical renderer

- Define the local contract schema, kind, source provenance, and validator.
- Export conventional endpoint and lifecycle constants from the existing
  contract module instead of duplicating them in a template.
- Render from accepted identity, resolved bindings, provider contract source,
  and structured loader evidence.
- Prove render, validate, serialize, parse, and render stability.

### Phase 2: planning integration

- Resolve and validate the local contract before `planMcpApp` generates keys or
  environment content.
- Refactor `planMcpApp` to consume the validated local contract for provider
  fragment path, bindings, endpoints, and supported lifecycle modes. The
  bootstrap options continue to select the planned mode separately.
- Keep the bundled Tama runtime contract as the source for Tama-owned variable
  requirements.
- Persist local contract path, schema, source, source digest, and semantic
  digest in manifest state as needed for drift detection.

### Phase 3: managed write and drift behavior

- Add `tama/contracts/mcp-app-provider-v1.json` to the existing managed-file
  planner and transaction.
- Distinguish safe managed-template upgrades from provider identity or binding
  migrations.
- Preserve the existing fail-closed behavior for user-edited managed files and
  differing provider contracts.
- Verify rollback restores or removes the contract with the rest of the
  transaction.

### Phase 4: output, documentation, and handoff

- Add local contract provenance and action to human, JSON, and dry-run output.
- Update bootstrap documentation and generated Tama README.
- Explain that the generated contract configures local inputs but does not
  implement provider runtime behavior.
- Document how a later matching provider-owned contract changes provenance
  without rotating keys or renaming variables.

## Acceptance criteria

### Generation and consumption

- Generic provider without a contract: bootstrap renders a generated local
  contract and uses its exact bindings to generate both owner-specific
  environment files in the same plan.
- Provider with a compatible contract: bootstrap renders a local projection
  with `source.type: "provider-contract"` and uses the declared bindings.
- `planMcpApp` does not independently derive provider variable names after the
  local contract has been rendered.
- The local contract is validated before any key generation or file write.

### Idempotency and drift

- Identical rerun: local contract and generated environment files are
  unchanged; private keys are preserved byte-for-byte.
- Port or allowed-origin change: environment values update without changing
  stable provider identity or binding names.
- A later matching provider-owned contract changes provenance without
  rotating keys or rewriting semantic bindings.
- Provider identity or binding disagreement with the manifest or local
  contract fails planning before writes.
- A user-edited managed local contract is never overwritten silently.

### Loader behavior

- Exact supported loader evidence records `verified`, mechanism, and evidence
  path.
- Missing, malformed, stale, ambiguous, or substring-only evidence records
  `unverified`.
- An unverified loader does not block prepared file generation but prevents a
  runnable/readiness claim.

### Ownership and safety

- The generated contract exists only under `tama/contracts/`; Tama Kit never
  creates or modifies `priv/contracts/`.
- The local contract contains no private keys, tokens, passwords, assertions,
  or private environment values.
- Managed writes retain path containment, symlink protection, ownership
  checks, transactional validation, and rollback behavior.
- JSON and dry-run output contain only non-secret local contract metadata.

### Runtime boundary

- Local contract generation does not report that the provider implements the
  runtime protocol.
- Activation still requires the existing live JWKS and authenticated
  introspection verification gates.
- Provider-owned lifecycle, persistence, authorization, grant, and token
  policy remain outside Tama Kit.

## Future work

- An explicit export command that uses the local contract as a starting point
  for an application-owned contract without claiming runtime implementation.
- Explicit migrations between local contract schema or compatibility versions.
- Language-specific adapters that can verify application-owned environment
  loading without executing untrusted provider code.
- Provider starter packages that implement the OAuth runtime protocol; these
  remain separate from local contract generation.
