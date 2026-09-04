# Tama Directory File Layout Cleanup

Status: implemented on `feature/tama-directory-file-layout`

## Summary

Make `tama/` the single repository-local home for every dotenv file generated
by `tama-kit bootstrap`, including the safe example and the MCP App provider
fragment.

This is a clean pre-deployment layout change. No released application
repository depends on the current root-level paths, so the implementation will
not detect, migrate, copy, delete, or fall back to legacy root files.

## Goal

A fresh bootstrap should leave the application root focused on application
files and the minimal Compose integration, while all Tama Kit-owned local
runtime assets live together under `tama/`.

The target layout for a standard application is:

```text
application/
├── compose.yaml                     # application-owned; includes Tama
└── tama/
    ├── .gitignore
    ├── .tama.env                    # private Tama runtime values
    ├── .tama.postgres.env           # private PostgreSQL values
    ├── .tama.env.example            # non-secret tracked example
    ├── .tama-kit.json
    ├── AGENTS.md
    ├── README.md
    ├── compose.yaml
    ├── main.tf
    └── versions.tf
```

For an MCP App provider, add the provider fragment to the same directory:

```text
tama/.<provider>.integration.env     # private provider-side integration values
tama/contracts/mcp-app-provider-v1.json
```

The two private key domains remain separate even though their files share the
same directory:

- `tama/.tama.env` contains Tama-owned runtime and introspection credentials.
- `tama/.<provider>.integration.env` contains provider-owned access-token
  signing credentials and provider integration values.

Co-location is an organizational boundary, not permission to combine keys or
copy values between files.

## Decisions

1. Preserve the existing distinctive filenames and move them under `tama/`:
   - `.tama.env` becomes `tama/.tama.env`;
   - `.tama.postgres.env` becomes `tama/.tama.postgres.env`; and
   - `.tama.env.example` becomes `tama/.tama.env.example`.
2. The default MCP App provider fragment becomes
   `tama/.<provider>.integration.env`.
3. Provider contracts, `--provider-env-file`, the generated local contract,
   and the persisted manifest use project-relative paths beginning with
   `tama/`.
4. Bootstrap rejects provider fragment paths outside `tama/`. It also rejects
   collisions with `.tama.env`, `.tama.postgres.env`, `.tama.env.example`,
   `.tama-kit.json`, `compose.yaml`, contracts, Terraform files, and other
   Tama Kit-managed paths.
5. Private generated files remain mode `0600`, ignored, untracked,
   symlink-safe, and transactionally written.
6. `tama/.tama.env.example` remains non-secret, managed, and safe to commit.
7. `tama/.gitignore` owns the exact private-file ignore rules. The project-root
   `.gitignore` no longer needs Tama runtime or provider-fragment entries.
8. The root Compose file remains application-owned because it is the integration
   point that includes `tama/compose.yaml`.
9. An application-owned provider contract under `priv/contracts/` remains
   outside `tama/`; it must declare the new project-relative provider fragment
   path.
10. Repository-local agent skills remain under `.agents/skills/`; they are
    installed agent capabilities rather than Tama runtime assets.
11. `tama-kit dev setup` is out of scope. It targets a Tama source checkout and
    retains its own root `.envrc` and `.tama.dev.postgres.env` contract.
12. `tama-kit oauth generate-key --output` is out of scope because its
    destination is explicitly selected by the operator.

## No legacy behavior

Do not add compatibility code for the former root locations:

```text
.tama.env
.tama.postgres.env
.tama.env.example
.<provider>.integration.env
```

Specifically, the implementation must not:

- read old root files as a fallback;
- move or copy their contents;
- preserve or rewrite old root ignore blocks;
- delete old root files;
- merge values from old and new locations; or
- add manifest schema fields solely to track a migration.

Fresh and test repositories should be regenerated using the new layout. If an
old root file happens to exist, it remains outside Tama Kit ownership and must
not influence planning.

## Path model

Define canonical project-relative paths in one bootstrap module instead of
repeating string literals:

```text
tama/.tama.env
tama/.tama.postgres.env
tama/.tama.env.example
tama/.tama-kit.json
tama/compose.yaml
```

Provider fragment paths remain dynamic but must resolve inside `tama/`.
Callers that need filesystem paths join these project-relative values against
the inspected project root. Callers already operating from the Tama directory
may use the basename only after the canonical project-relative path has been
validated.

The public JSON plan continues to report project-absolute operation paths and
the provider fragment's project-relative path. It must not expose file
contents or secret values.

## Compose behavior

Because the managed Compose fragment lives beside both runtime files, its
entries become:

```yaml
services:
  tama-postgres:
    env_file:
      - ./.tama.postgres.env

  tama:
    env_file:
      - ./.tama.env
```

The application root continues to include `./tama/compose.yaml`. Validate the
effective configuration with the selected root Compose file so relative-path
semantics are proven for default and custom Compose locations.

The provider fragment is not automatically attached to an arbitrary
application service. Existing loader verification must recognize exact
references such as:

```text
tama/.memovee.integration.env
```

in a supported root `.envrc` or application Compose `env_file` entry. An
unverified loader stays unverified.

## Git ignore behavior

The generated `tama/.gitignore` should include exact local paths for:

```gitignore
/.tama.env
/.tama.postgres.env
/.*.integration.env
```

The example must remain visible to Git:

```text
tama/.tama.env.example
```

If custom provider fragment paths below `tama/` are supported, plan an exact
relative ignore entry for the resolved file rather than broadening the pattern
to unrelated dotenv files.

Before writing secrets, validate both the Git index and effective ignore
result using the full project-relative paths. A nested negation that exposes a
private file must fail the transaction.

## Runtime and documentation updates

Update every bootstrap consumer of the current root paths, including:

- environment creation, validation, port preservation, and setup URL reading;
- derived PostgreSQL environment generation;
- MCP App Tama-side key preservation and persisted-origin lookup;
- provider fragment creation, identity persistence, local-contract rendering,
  loader evidence, activation rollback, and live verification;
- generated Compose configuration;
- ignored/untracked validation before and after writes;
- dry-run and JSON change reporting;
- generated `tama/README.md` and `tama/AGENTS.md` instructions;
- the copy/paste agent handoff;
- README, bundled skills, CLI reference, and eval expectations; and
- all fixtures and assertions that encode root-level paths.

Commands shown from the application root should load:

```bash
set -a
. ./tama/.tama.env
set +a
```

Commands shown from inside `tama/` should load:

```bash
set -a
. ./.tama.env
set +a
```

Do not print the setup token, private JWKs, passwords, or generated dotenv
contents in JSON output, tests, logs, or PR descriptions.

## Provider contract consequences

The provider contract and generated local contract carry a project-relative
`provider.environment_file`. Under the new invariant, a conventional Memovee
value is:

```json
{
  "provider": {
    "name": "memovee",
    "environment_prefix": "MEMOVEE",
    "environment_file": "tama/.memovee.integration.env"
  }
}
```

Update provider examples and integration repositories before they are treated
as deployed contracts. Tama Kit still reads but never rewrites an
application-owned contract.

The provider process remains responsible for loading the exact declared path.
Moving the file does not change provider ownership of authorization, token
issuance, lifecycle, persistence, revocation, JWKS, or introspection behavior.

## Implementation outline

### Phase 1: Centralize paths

1. Add canonical bootstrap path constants/helpers.
2. Replace root dotenv literals in environment and setup URL code.
3. Make provider fragment defaults and validation enforce the `tama/`
   boundary.

### Phase 2: Compose and ignore rules

1. Point the managed Compose fragment at sibling dotenv files.
2. Move private ignore ownership into `tama/.gitignore`.
3. Validate full project-relative secret paths as ignored and untracked.
4. Keep the example tracked.

### Phase 3: MCP App propagation

1. Persist the new provider fragment path in the manifest and local contract.
2. Update key preservation, loader verification, and activation rollback.
3. Update live verification reads for both owner-specific key files.
4. Ensure provider and Tama private keys remain isolated.

### Phase 4: Guidance and contracts

1. Update generated onboarding and agent instructions.
2. Update repository README, bundled skills, CLI reference, and eval cases.
3. Update application-owned provider contract examples and identify required
   downstream contract changes without modifying other repositories in this
   branch.

### Phase 5: Validation

1. Run focused bootstrap and MCP App tests.
2. Run the full Node test suite, formatting/lint, and type checking.
3. Validate submission and review-ready metadata.
4. Validate the dry-run package contents.
5. Run packaged bootstrap, Docker Compose configuration, Terraform validation,
   and the runtime gate in a capable environment.

## Test matrix

### Fresh standard bootstrap

- Creates `tama/.tama.env`, `tama/.tama.postgres.env`, and
  `tama/.tama.env.example`.
- Creates no bootstrap dotenv files at the project root.
- Writes private files as `0600` and preserves their values across reruns.
- Keeps the example non-secret, unignored, and eligible to commit.
- Resolves the managed Compose fragment successfully from the root Compose
  project.

### Fresh MCP App bootstrap

- Creates `tama/.<provider>.integration.env`.
- Stores only the provider private key in the provider fragment.
- Stores only the Tama introspection private key in `tama/.tama.env`.
- Persists the project-relative provider path in the manifest and local
  contract.
- Verifies exact `.envrc` and Compose loader references to the new path.
- Rejects provider fragment overrides outside `tama/` and collisions inside
  it.

### Safety

- Rejects tracked private files at every new path.
- Rejects symlinked `tama/` ancestors and final secret-file symlinks.
- Rejects nested ignore negations that expose a private file.
- Rolls back every newly written file when post-write validation fails.
- Produces no secret material during dry runs.
- Never reads or mutates legacy root dotenv files.

### Idempotency and reporting

- An identical rerun reports unchanged files.
- Port and allowed-origin changes update only intended values.
- Valid keys and credentials remain byte-for-byte stable.
- Human instructions reference the new paths.
- JSON output is deterministic, non-interactive, and redacted.

## Acceptance criteria

- Every dotenv file generated by `tama-kit bootstrap` is inside `tama/`.
- No bootstrap code reads or writes the former root dotenv paths.
- Private files are `0600`, ignored, untracked, and protected by existing
  managed-path and transactional-write safeguards.
- The example is non-secret, managed, and commit-safe.
- Compose, Terraform onboarding, guided setup, MCP App preparation,
  activation, rollback, and verification all consume the new paths.
- Provider and Tama key ownership remain separate and test-covered.
- Standard and MCP App bootstraps pass the full repository and packaged-runtime
  validation suites.

## Delivery boundary

This branch implements the approved layout and provider-fragment path contract.
The PR remains focused on file placement and path propagation; Caddy, `.dev`
domains, TLS, and certificate provisioning remain separate future work.

## Implementation validation

- Focused bootstrap and MCP App suites: 172 passed.
- Full Node test suite: 242 passed, 1 expected root-only skip.
- Biome checks and TypeScript checking passed.
- Submission and review-ready metadata validation passed.
- Package dry run passed and included the updated CLI, templates, docs, skills,
  and evals.
- Bootstrap validation reached and passed Docker Compose configuration, then
  stopped because Terraform is not installed in the validation environment.
