# Tama Kit Bootstrap CLI

Status: implemented and locally smoke-validated

## Summary

Add a conventional Tama Kit CLI that can be run from an existing Rails,
Phoenix, JavaScript, or other application repository and prepare a local Tama
runtime beside that application.

The canonical command is:

```bash
tama-kit bootstrap
```

The npm-package entry point is:

```bash
npx @upmaru/tama-kit bootstrap
```

`tama-kit init` may be retained as an alias for discoverability, but
`bootstrap` is the documented command because it augments an existing project
rather than creating the application itself.

The first implementation creates or safely updates Docker Compose integration,
generates local runtime configuration in `.tama.env`, and establishes a
`tama/` Terraform root containing exactly one owned global foundation. It does
not apply Terraform or modify framework application code.

## Goals

- Work from the current directory by default, with an optional target path.
- Detect the project root, framework family, and default Docker Compose file.
- Add a self-contained Tama runtime and PostgreSQL dependency to Compose.
- Preserve unrelated Compose configuration and user-owned files.
- Generate local secrets once and prevent them from being committed.
- Generate a `tama/` Terraform root with a pinned provider and root
  `upmaru/base/tama` module.
- Reuse an existing global foundation instead of creating a duplicate.
- Be deterministic and idempotent: a second run should produce no changes.
- Provide dry-run, machine-readable, and optional start modes.
- Keep one implementation shared by the terminal CLI and any future
  agent-facing skill.

## Non-goals

- Editing Rails, Phoenix, Next.js, or other application source code.
- Automatically selecting or installing an application SDK.
- Applying Terraform or creating remote Tama graph resources.
- Reusing an application's existing PostgreSQL database in the first release.
- Deploying Tama to Fly.io or another remote platform.
- Depending on Tama's test-only provisioner setup or a `-ci` container image.
- Treating static configuration generation as proof of live runtime behavior.

## Command surface

```text
tama-kit bootstrap [path]
  --compose <path>
  --port <port>
  --image <tag-or-digest>
  --dry-run
  --start
  --json
```

Behavior:

- `path` defaults to the current working directory.
- `--compose` resolves ambiguity when more than one Compose root is present.
- `--port` changes the host-facing Tama port without changing container port
  4000.
- `--image` overrides the tested default image for local experimentation.
- `--dry-run` reports the detection result and proposed file operations without
  writing or starting containers.
- `--start` runs Docker Compose after generation and waits for Tama health.
- `--json` emits a stable result envelope for automation and implies no
  interactive output.

`bootstrap` should generate files by default but should not pull images or
start containers unless `--start` is supplied.

## Repository layout

The CLI is a first-class product surface and belongs in a top-level `cli/`
directory. Existing `scripts/` remain repository-maintenance utilities.

```text
tama-kit/
├── bin/
│   └── tama-kit.mjs
├── cli/
│   ├── index.mjs
│   ├── commands/
│   │   └── bootstrap.mjs
│   ├── bootstrap/
│   │   ├── detect-project.mjs
│   │   ├── detect-compose.mjs
│   │   ├── compose.mjs
│   │   ├── terraform.mjs
│   │   ├── environment.mjs
│   │   ├── gitignore.mjs
│   │   ├── manifest.mjs
│   │   ├── plan.mjs
│   │   └── write.mjs
│   └── templates/
│       └── bootstrap/
│           ├── compose.yaml
│           ├── global-module.tf
│           ├── main.tf
│           ├── versions.tf
│           ├── README.md
│           └── tama-env.example
├── test/
│   ├── cli/
│   │   └── bootstrap.test.mjs
│   └── fixtures/
│       ├── rails/
│       ├── phoenix/
│       ├── node/
│       └── generic/
└── skills/
    ├── graph-builder/
    ├── graph-audit/
    └── app-bootstrap/
        └── SKILL.md
```

Responsibilities:

- `bin/tama-kit.mjs` is an executable shim that passes arguments to
  `cli/index.mjs` and maps errors to exit codes.
- `cli/index.mjs` parses global arguments and dispatches commands.
- `cli/commands/bootstrap.mjs` coordinates inspection, planning, conflict
  handling, writes, and optional startup.
- `cli/bootstrap/` contains the deterministic implementation and must not
  depend on terminal prompting.
- `cli/templates/bootstrap/` contains safe, versioned templates.
- A future `skills/app-bootstrap` skill calls the same CLI implementation. It
  must not contain a second generator.
- `skills/graph-builder` continues to own Tama graph construction guidance;
  application discovery and Compose mutation do not belong there.

`package.json` must publish both `bin/` and `cli/` and expose:

```json
{
  "bin": {
    "tama-kit": "./bin/tama-kit.mjs"
  }
}
```

## Detection model

Detection produces a value before any changes are planned:

```text
ProjectInspection
  root
  framework
  frameworkEvidence[]
  composeCandidates[]
  selectedCompose
  existingTamaDirectory
  terraformInventory
  conflicts[]
  warnings[]
```

Project-root precedence:

1. Explicit command path.
2. Closest Git worktree root containing the current directory.
3. Current directory when no Git root is available.

Initial framework evidence:

- Rails: `Gemfile` declares Rails and `config/application.rb` exists.
- Phoenix: `mix.exs` declares Phoenix and `config/config.exs` exists.
- Node: `package.json`, with recognized framework dependencies recorded when
  present.
- Generic: none of the supported framework signatures match.

Framework detection informs diagnostics and future integration work. It does
not authorize application-code changes.

Compose-candidate precedence:

1. `compose.yaml`
2. `compose.yml`
3. `docker-compose.yaml`
4. `docker-compose.yml`

If multiple candidates are independently usable, bootstrap stops and requests
`--compose`. It must not guess which Compose project the user operates.

## Generated project layout

For a new integration:

```text
project/
├── .tama.env
├── .tama.postgres.env
├── .tama.env.example
├── compose.yaml
└── tama/
    ├── .tama-kit.json
    ├── compose.yaml
    ├── main.tf
    ├── versions.tf
    └── README.md
```

When a Compose root already exists, bootstrap minimally connects it to
`tama/compose.yaml` rather than replacing it.

## Docker Compose design

`tama/compose.yaml` owns:

- a `tama` service using a version- or digest-pinned
  `ghcr.io/upmaru/tama` server image;
- a `tama-postgres` service using a version-pinned pgvector PostgreSQL image;
- a persistent database volume;
- a PostgreSQL health check;
- a Tama health check against the container's HTTP port;
- a dependency that waits for PostgreSQL health;
- `.tama.env` as the Tama service environment file; and
- management labels such as `dev.upmaru.tama-kit.managed=true`.

PostgreSQL should remain internal to the Compose network by default. Tama maps
`${TAMA_PORT:-4000}` on the host to port 4000 in the container.

The preferred integration is a root Compose `include` entry for
`./tama/compose.yaml`. Bootstrap must verify that the installed Docker Compose
supports the required include behavior before selecting this strategy. An
older Compose installation is an actionable compatibility error in the first
release; direct service merging can be added later as an explicit compatibility
mode.

Compose mutation must use a YAML document API so unrelated keys and comments
are preserved as far as the library permits. The updater owns only its include
entry and the generated `tama/compose.yaml` file.

Conflicts that stop generation include:

- an unmanaged service named `tama` or `tama-postgres`;
- a generated file whose ownership marker is missing but whose path would be
  overwritten;
- multiple Compose roots without `--compose`;
- malformed YAML; and
- an existing managed include pointing at a different path.

## Local environment

Bootstrap creates `.tama.env` once with owner-only permissions and creates a
safe `.tama.env.example` without live secrets. It derives an ignored,
owner-only `.tama.postgres.env` containing only the three PostgreSQL bootstrap
values so the database container does not receive Tama's runtime secrets.

Required generated or configured values include:

```dotenv
POSTGRES_USER=tama
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=tama
DATABASE_URL=ecto://tama:<generated>@tama-postgres/tama

PHX_HOST=localhost
PORT=4000
TAMA_PORT=4000
SECRET_KEY_BASE=<generated>
TAMA_VAULT_KEY=<generated>
TAMA_JWT_SECRET=<generated>
TAMA_OAUTH_SIGNING_KEY=<generated>
TAMA_OAUTH_SIGNING_KEY_ID=<generated>
TAMA_SETUP_TOKEN=<generated>

TAMA_DISABLE_CLUSTERING=true
TAMA_OAUTH_ISSUER=http://localhost:4000
TAMA_MCP_RESOURCE=http://localhost:4000/mcp
TAMA_MCP_ALLOWED_ORIGINS=http://localhost:4000
TAMA_BASE_URL=http://localhost:4000
```

The exact variable set must be verified against the pinned Tama image before
release. Generated secrets must use a cryptographically secure random source,
must not appear in normal terminal output, and must not rotate on rerun.
Persisted values are validated against the pinned runtime contracts:
`SECRET_KEY_BASE` must contain at least 64 bytes, and `TAMA_VAULT_KEY` must be
either 32 raw bytes or canonical Base64 that decodes to 32 bytes.

Bootstrap adds the secret-file patterns to the project-root `.gitignore`:

```gitignore
.tama.env
.tama.postgres.env
```

Ignore rules do not protect files that are already in the Git index. Bootstrap
refuses to continue if either private environment file is tracked or staged and
reports the explicit `git rm --cached -- ...` remediation without removing the
working-tree files.

It adds Terraform working-directory and state patterns to `tama/.gitignore`,
after any existing rules at that scope so nested negations cannot make state
trackable:

```gitignore
.terraform/
*.tfstate
*.tfstate.*
```

`tama/.terraform.lock.hcl` is intentionally not ignored.

## Terraform foundation

### Outcome

The generated `tama/` directory is a standalone Terraform root that owns a new
local Tama environment's global foundation, or explicitly preserves an
existing foundation owner.

### Trigger

The user runs `tama-kit bootstrap`. Bootstrap writes configuration only. A
later, explicit Terraform workflow initializes, plans, and applies it.

### Ownership

For a new Terraform root, local state owns exactly one root
`upmaru/base/tama` module at the conventional address `module.global`.

For an existing Terraform root, bootstrap inspects all `.tf` files first:

- If a root `upmaru/base/tama` module exists, preserve its current Terraform
  address and version.
- If foundation ownership is external and documented, do not create a local
  module.
- If ownership is unknown, stop rather than create duplicate data-bearing
  resources.
- If Terraform exists and no foundation exists, create a separate managed
  `tama-kit-global.tf` instead of rewriting user HCL.

### New-root files

`tama/main.tf` contains provider configuration and exactly one global module:

```hcl
provider "tama" {}

module "global" {
  source  = "upmaru/base/tama"
  version = "<tested-version>"
}
```

`tama/versions.tf` pins Terraform and the Tama provider to one compatibility
set tested with the pinned module and Tama container image. Versions must not
be inferred from a neighboring checkout at generation time.

Provider credentials remain environment-owned through `TAMA_CLIENT_ID` and
`TAMA_CLIENT_SECRET`; they are not written into HCL.

### Terminal and safety boundary

The bootstrap terminal is valid source configuration on disk. It is not a
Terraform apply and does not prove that remote global resources exist.

Bootstrap never runs `terraform apply`. Optional future helpers may run
`terraform init`, formatting, validation, or plan only when their command
contract explicitly requests those actions.

## First-run credentials

The Tama server can start with the generated runtime environment, but the Tama
Terraform provider requires provisioner client credentials before it can
create the global foundation.

The first release uses the supported interactive setup flow:

1. Start the Compose services.
2. Wait for Tama health.
3. Print the local Tama URL.
4. Print a setup URL that references the generated `TAMA_SETUP_TOKEN` without
   printing the token separately.
5. Guide the user through root-user and provisioner creation.
6. Instruct the user to store `TAMA_CLIENT_ID` and `TAMA_CLIENT_SECRET` in
   `.tama.env`.
7. Only then initialize and plan the generated Terraform root.

Completely headless setup requires a supported, idempotent Tama runtime
bootstrap command or API. That runtime contract is a separate prerequisite.
Tama Kit must not use the existing test-only provisioner variables or the CI
container image as a production bootstrap mechanism.

## Planning and write model

Inspection and mutation are separate phases:

```text
inspect project
  -> build change plan
  -> report conflicts and warnings
  -> stop on ownership conflicts or managed-file drift
  -> write atomically
  -> validate generated configuration
  -> optionally start and health-check
```

Each planned operation records:

```text
Change
  action: create | update | unchanged
  path
  owner: tama-kit | user
  beforeDigest
  afterDigest
  sensitive
  reason
```

Sensitive content is redacted from human and JSON output. JSON errors include
their stable numeric exit code, and file changes include reasons plus before
and after SHA-256 digests. Writes use temporary files followed by
same-filesystem rename where supported. If validation fails, bootstrap reports
the affected generated files and does not start containers.

`--dry-run` performs the same inspection and planning code path but skips all
writes and runtime or prerequisite processes. It may perform a read-only local
Git-index inspection to protect private environment files.

## Idempotency and ownership

Generated files include an appropriate Tama Kit ownership marker when their
format permits it. Ownership is path- and content-specific; the presence of a
`tama/` directory alone does not authorize overwriting everything beneath it.

On rerun:

- preserve `.tama.env` and its secrets;
- preserve an existing global-module address;
- update only Tama Kit-managed templates;
- leave user-owned Terraform and Compose content untouched;
- report template drift and refuse to overwrite a user-modified managed file;
  and
- produce no changes when inputs and template versions are unchanged.

The generator maintains a non-secret `tama/.tama-kit.json` manifest containing
the manifest schema version and SHA-256 digests for generated, non-sensitive
managed files. A rerun updates a managed template only when its current digest
matches the previously recorded digest. Missing or user-modified managed files
fail closed instead of being silently replaced. Sensitive environment files
are excluded from the manifest.

## Exit codes

Proposed stable exit categories:

- `0`: success, including an unchanged rerun.
- `1`: unexpected execution or validation failure.
- `2`: invalid CLI usage.
- `3`: project or Compose ambiguity.
- `4`: ownership or overwrite conflict.
- `5`: missing or incompatible prerequisite.
- `6`: optional startup completed unsuccessfully or health timed out.

JSON output should include the category name in addition to the numeric exit
code.

## Verification

### Unit and fixture tests

- Detect Rails, Phoenix, Node, and generic projects.
- Resolve each supported Compose filename.
- Reject multiple Compose roots without `--compose`.
- Reject malformed Compose YAML and unmanaged service collisions.
- Create the expected project layout when Compose is absent.
- Add exactly one include when Compose exists.
- Preserve unrelated YAML nodes and representative comments.
- Generate secrets with correct shape and file permissions.
- Reject persisted secrets that do not satisfy the pinned runtime formats.
- Append missing `.gitignore` patterns exactly once.
- Refuse private environment files that are already tracked or staged in Git.
- Preserve existing secrets and produce no diff on a second run.
- Detect an existing root global module under any Terraform address.
- Refuse duplicate or unknown global-foundation ownership.
- Prove that `--dry-run` writes nothing.
- Redact all sensitive values from text and JSON output.

### Static integration checks

- `docker compose config` succeeds for every Compose fixture.
- Generated Terraform passes `terraform fmt -check -recursive`.
- `terraform init` and `terraform validate` succeed against the selected,
  pinned compatibility set.
- The npm package contains `bin/`, `cli/`, and all bootstrap templates.
- Both `npx @upmaru/tama-kit bootstrap` and a globally linked
  `tama-kit bootstrap` exercise the same implementation.

The branch CI runs these checks through `npm run validate:bootstrap:runtime`,
including packaged CLI installation, Compose validation, Terraform formatting,
initialization and validation, local runtime health, and setup-route
reachability.

### Runtime smoke check

In a disposable test project:

1. Bootstrap with `--start`.
2. Pull the pinned images.
3. Wait for PostgreSQL health.
4. Confirm Tama migrations and startup succeed.
5. Confirm the Tama health endpoint responds.
6. Confirm the supported setup route is reachable.
7. Tear down containers while retaining an explicit choice about volume
   deletion.

This smoke check proves local runtime startup only. Terraform creation of the
global foundation remains a separate acceptance check requiring supported
provisioner credentials.

## Implementation sequence

1. Add the `bin/` shim, `cli/` dispatcher, command parser, error model, and npm
   package wiring.
2. Implement project and Compose inspection plus dry-run planning.
3. Add generated Compose and environment templates with ownership tracking.
4. Add Terraform inspection and new-root generation.
5. Add atomic writes, idempotent reconciliation, and fixture tests.
6. Add optional Docker Compose startup and health verification.
7. Document interactive provisioner setup and Terraform initialization.
8. Select and validate one pinned Tama image, provider, base-module, and
   PostgreSQL compatibility set before release.
9. Design a separate supported Tama runtime contract for headless local
   provisioner creation before automating credentials.

## Open decisions

- Whether `init` ships as a permanent alias or is omitted until user demand is
  demonstrated.
- Docker Compose 2.20.0 or newer is required for `include`.
- A managed digest manifest is included in the first release. Format-specific
  ownership markers remain as a secondary check for sensitive generated files
  that are deliberately excluded from the manifest.
- `--start` prints setup guidance and does not open a browser.
- Whether a future `tama-kit terraform <args>` command should load
  `.tama.env`, or documentation should keep Terraform invocation explicit.
- The first validated set is Tama `0.13.0-server`, pgvector
  `0.8.6-pg15-bookworm`, Tama provider `~> 0.6.3`, and global module `0.5.6`.
  The upgrade policy remains open.
- The supported Tama runtime interface for headless provisioner creation.

## Source references

- Tama container startup and health contract:
  `../../tama/Dockerfile`
- Tama production environment contract:
  `../../tama/config/runtime.exs`
- Tama provider environment and authentication contract:
  `../../terraform-provider-tama/tama/provider.go`
- Global foundation implementation:
  `../../terraform-tama-base/`
- Tama Kit global-foundation guidance:
  `../skills/graph-builder/references/global-foundation.md`

These paths are development-checkout references. The implementation must pin
released artifacts and validate their installed interfaces before publishing
generated defaults.
