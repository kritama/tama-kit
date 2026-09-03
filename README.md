# Tama Kit

Tama Kit is a domain-neutral ChatGPT and Codex plugin for bootstrapping
applications with Tama and building, changing, and auditing Tama Terraform
graph networks. It combines guided CLI and application-integration skills,
focused graph skills, and a workspace-specific Tama MCP connection. The skills
cover standard bootstrap, MCP App OAuth provisioning, routed conversations,
direct forwarded actions, shared replies, ingestion, enrichment, embeddings,
indexing, batch reprocessing, the required global foundation, and
Terraform-safe graph migration.

## Bootstrap a local Tama runtime

Tama Kit also ships a conventional CLI for adding a local Tama runtime and a
starter Terraform root to an existing Rails, Phoenix, Node, or generic
application repository:

```bash
npx @kritama/tama-kit bootstrap
```

After a global npm installation, the equivalent command is:

```bash
tama-kit bootstrap
```

Bootstrap detects the project and its default Docker Compose file, creates a
private `.tama.env`, adds managed Tama and PostgreSQL services, and generates a
`tama/` Terraform root with one version-pinned `module "global"` and focused
`AGENTS.md` guidance. On the first interactive run, it asks whether to install
the bundled `tama-kit-cli`, `app-integration`, `graph-builder`, and
`graph-audit` skills into the repository's `.agents/skills/` directory or leave
skill installation to the user. It preserves an existing global-foundation
address and refuses ambiguous ownership rather than creating duplicate
data-bearing resources.

Skip the prompt in scripts by selecting the skill mode explicitly:

```bash
npx @kritama/tama-kit bootstrap --skills local
npx @kritama/tama-kit bootstrap --skills manual
```

JSON and other non-interactive runs default to `manual`. When manual mode is
selected, the human-readable final output prints both the project-scoped Skills
CLI command and the Codex plugin installation commands. Human-readable
bootstrap output also uses terminal colors and a progress bar when supported;
use `--no-color` to disable color styling.

After a successful write, bootstrap ends with a copy-ready coding-agent prompt.
The prompt starts and checks the local Compose runtime, guides the user through
the private browser setup without exposing credentials, runs Terraform
initialization, formatting, validation, and planning, and requires explicit
approval before `terraform apply`. Human output includes the complete private
onboarding URL with its setup token so it can be opened or copied into the agent
prompt. Treat that URL as a secret. JSON output exposes a token-redacted version
as `agentPrompt`; dry-run output sets it to `null`.

Generated non-sensitive files are tracked by `tama/.tama-kit.json`. If a
tracked file has been edited since the previous bootstrap, Tama Kit stops and
reports the drift instead of overwriting the user's changes.

Inspect the proposed changes without writing:

```bash
npx @kritama/tama-kit bootstrap --dry-run
```

Generate and start the local services:

```bash
npx @kritama/tama-kit bootstrap --start
```

### Bootstrap an MCP App provider integration

Use `--mcp-app` from the provider application's repository. Contract-aware
providers can commit `priv/contracts/tama-mcp-app-bootstrap-v1.json`; other
providers must supply an explicit name and origin. Non-interactive runs also
require the exact browser/MCP client origins. The integration requires a Tama
image pinned to a stable release inside the supported range (the floating
default tag is rejected):

```bash
npx @kritama/tama-kit bootstrap --mcp-app \
  --provider-name acme \
  --provider-origin http://host.docker.internal:4000 \
  --tama-origin http://127.0.0.1:4001 \
  --allowed-origin http://127.0.0.1:3000 \
  --port 4001 \
  --image ghcr.io/upmaru/tama:0.13.1
```

The provider origin must be one origin reachable from both the host-native
provider and the Tama container. `host.docker.internal` adds the managed
host-gateway mapping; Tama Kit does not rewrite OAuth endpoints to a different
transport origin. Public origins are exact identifiers, so `localhost`,
`127.0.0.1`, and `::1` are not interchangeable.

The same command also manages
`tama/contracts/mcp-app-provider-v1.json`, a non-secret local contract that
normalizes provider identity, exact environment bindings, public endpoint
paths, source provenance, and environment-loader evidence before either
owner's environment file is planned. Providers without a committed contract
use conventional bindings immediately; this local artifact does not claim the
provider runtime implements the OAuth protocol. Application-owned contracts
under `priv/contracts/` are only read, never generated or modified.

Activation is deliberately two-step:

```bash
npx @kritama/tama-kit bootstrap --mcp-app \
  --provider-name acme \
  --provider-origin http://host.docker.internal:4000 \
  --tama-origin http://127.0.0.1:4001 \
  --allowed-origin http://127.0.0.1:3000 \
  --port 4001 \
  --image ghcr.io/upmaru/tama:0.13.1 --start --activate
```

The first run verifies prepared state and enables/restarts Tama, then reports
the provider-owned mode change. Set the reported provider mode variable to
`enabled`, restart the provider, and rerun the same command. Tama Kit records
an enabled checkpoint only after both live services pass metadata, JWKS,
introspection, protected-resource, route, and direct Tama-container
reachability probes. It never executes provider lifecycle commands. See
[MCP App provider bootstrap](docs/mcp-app-provider-bootstrap.md)
for the contract, secret ownership, rerun, and recovery rules.

Provider identity is immutable during a normal rerun. To migrate it, first
update the provider-owned loader (and contract, when present) for the new
fragment, keep the current provider mode prepared, then run with an explicit
new name:

```bash
npx @kritama/tama-kit bootstrap --mcp-app \
  --migrate-provider-identity --provider-name new-name \
  --provider-origin http://host.docker.internal:4000 \
  --tama-origin http://127.0.0.1:4001 \
  --allowed-origin http://127.0.0.1:3000 \
  --port 4001 \
  --image ghcr.io/upmaru/tama:0.13.1
```

The migration moves preserved provider-owned entries to the new fragment,
renames the managed bindings, preserves signing material and overlap keys,
removes the old managed fragment transactionally, and records the new identity.

The first release uses Tama's supported interactive setup flow to create root
and provisioner credentials. Bootstrap does not use the test-only provisioner
path and never runs `terraform apply`.

## Prepare a Tama source checkout

Tama contributors can prepare a newly cloned Tama repository with:

```bash
npx @kritama/tama-kit dev setup
```

This command is intentionally separate from `bootstrap`. It generates a private
`.envrc`, starts only the pgvector PostgreSQL service declared by Tama's
repository-owned `compose.yml`, waits for the container to become healthy, runs
`mix setup`, and provisions Tama's test foundation. It installs only the
OpenTofu version declared by the checkout when foundation provisioning is
required, that tool is missing, and `mise` is available. It also maintains
repository ignore rules for the generated credentials before writing them. It
does not install or use a host PostgreSQL. Phoenix remains a native host process.
Native Phoenix listens on `127.0.0.1:4001` by default. Development and test
database connections use loopback port `55432` by default, so they do not
select a PostgreSQL server listening on the host's standard `5432` port. The
generated environment also bounds local ExUnit concurrency so high-core
development machines do not overwhelm the container.

Choose another native Phoenix or isolated PostgreSQL loopback port when
necessary:

```bash
npx @kritama/tama-kit dev setup --port 4567
npx @kritama/tama-kit dev setup --postgres-port 55433
```

To generate the private files without starting Docker or running Mix, use
`--prepare-only`. Use `--dry-run` or `--json` for a secret-free plan. Existing
secrets and an existing Tama port are preserved on every rerun. Passing
`--port` updates only the native Phoenix `PORT` export; changing the PostgreSQL
port updates only the development and test database port exports. For the
canonical Memovee integration topology, use:

```bash
npx @kritama/tama-kit dev setup --port 4001 --postgres-port 55432 --json
```

## Generate a staging OAuth key

For environments that bootstrap does not manage, such as a staging deployment
whose configuration lives in a secret manager, generate the same System OAuth
signing key pair standalone:

```bash
tama-kit oauth generate-key --kid staging-2026-09-01-1 --stdout
```

The command works without a Tama checkout, Mix, or Docker and requires exactly
one destination. With `--stdout` it prints exactly two dotenv assignments and
nothing else:

```dotenv
TAMA_OAUTH_PRIVATE_JWK='{"alg":"RS256","kid":"staging-2026-09-01-1",...}'
TAMA_OAUTH_PRIVATE_JWK_ID=staging-2026-09-01-1
```

`--kid` is optional; when omitted, the identifier is derived from the
public-key thumbprint. Explicit identifiers accept ASCII letters, digits,
dots, underscores, tildes, and hyphens so the emitted assignments remain
portable dotenv syntax. Paste each value into the staging environment, or
create an owner-only file for transfer with `--output`:

```bash
mkdir -p "$HOME/tama-oauth-transfer"
chmod 700 "$HOME/tama-oauth-transfer"
tama-kit oauth generate-key --kid staging-2026-09-01-1 \
  --output "$HOME/tama-oauth-transfer/staging.env"
```

`--output` resolves relative paths against the current working directory,
creates the file exclusively with mode `0600`, and prints only the resulting
path. It refuses existing files, symbolic links, missing or unwritable parent
directories, directories owned by another user, and directories that are
group- or world-writable without the sticky bit (root-owned sticky
directories such as `/tmp` remain usable because other users cannot rename
entries there, and the directory owner can rename entries even in a sticky
directory). Paths inside a Git worktree must be ignored and untracked.
Requiring a private parent directory means another user cannot exchange the
path between validation and the write, so the reported path is the file that
was created. It never edits `.gitignore` and never replaces an existing file,
so rotating the signing key always uses an explicit new destination.

## Installation

### Codex

Tama Kit is distributed as a plugin containing `tama-kit-cli`,
`app-integration`, `graph-builder`, and `graph-audit`. The plugin is downloaded
from npm through the Upmaru marketplace; installing the npm package by itself
does not enable the plugin in ChatGPT or Codex.

This installation path requires the Codex CLI with plugin support, Node.js 20.12
or newer, and an npm CLI available on your system.

Add the marketplace and install the plugin:

```bash
codex plugin marketplace add kritama/tama-kit
codex plugin add tama-kit@upmaru
```

Start a new Codex session after installation so Codex can load the bundled
skills. You can then invoke any skill explicitly:

```text
$graph-builder
$graph-audit
$tama-kit-cli
$app-integration
```

For example:

```text
Use $tama-kit-cli to help me bootstrap my app to work with Tama.
```

The skill first asks whether the application is an MCP App provider so it can
choose between ordinary bootstrap and the contract-aware `--mcp-app` workflow.
For an MCP App, it then classifies the provider as OAuth-ready, partial, or
absent. When OAuth is absent, it explains that an application-side OAuth 2.1
provider integration is a prerequisite and asks before expanding the work;
Tama Kit configuration alone does not make the application a provider.
For graph work:

```text
Use $graph-builder to add a routed support-search component with plain and
artifact replies, then verify every trigger-to-terminal path.
```

To confirm the plugin is installed:

```bash
codex plugin list
```

### OpenCode

OpenCode loads Agent Skills directly; it does not use the Codex plugin
manifest. Install all Tama Kit skills globally with the Skills CLI:

```bash
npx skills add kritama/tama-kit \
  --agent opencode \
  --global \
  --yes
```

For a project-only installation, run the same command from the project root
without `--global`:

```bash
npx skills add kritama/tama-kit \
  --agent opencode \
  --yes
```

Start a new OpenCode session after installation, then ask it to use
`tama-kit-cli`, `app-integration`, `graph-builder`, or `graph-audit`. You may
install an individual skill with `--skill <name>`. These steps install only the
skills; configure your workspace-specific Tama MCP server separately when
runtime inspection is needed. See the
[Skills CLI](https://github.com/vercel-labs/skills),
OpenCode's official [Agent Skills](https://opencode.ai/docs/skills/), and
[MCP servers](https://opencode.ai/docs/mcp-servers/) documentation.

## Included skills

`tama-kit-cli` selects and runs the appropriate CLI workflow for an ordinary
application, MCP App provider, Tama source checkout, or standalone OAuth key.
For an ambiguous application bootstrap request, it first asks whether the app
is an MCP App provider before choosing flags.

`app-integration` implements and provisions the application-owned OAuth
authorization server for Tama's exact `/mcp/app` protected resource. It consumes
the generated local contract, first verifies whether existing OAuth is ready,
partial, or absent, preserves provider/Tama key custody, implements the
disabled/prepared/enabled lifecycle when authorized, and verifies the staged
activation handoff.

`graph-builder` designs, implements, extends, migrates, and removes graph
slices. It models execution edges, control edges, operational policy, terminals,
and Terraform lifecycle impact before editing.

`graph-audit` traces existing graphs without editing them. It reports
incomplete topology, missing control edges, unsafe lifecycle changes, and
runtime unknowns with exact evidence.

## Development

The bundled maintenance utilities and Terraform inspector are dependency-free
Node.js ES modules; no Python runtime is required. The CLI remains native ESM
and uses JSDoc contracts with a no-emit TypeScript check, so development does
not require a compiled `dist/` tree.

Memovee-derived forward-test cases live in `evals/cases.json`; public skill
references remain domain-neutral. Validate the public-directory metadata,
Template MCP scaffold, and review cases with:

```bash
npm run check
npm run typecheck
npm test
npm run validate:bootstrap
npm run validate:submission
```

`npm run check` verifies formatting, lint rules, and import ordering with Biome.
Use `npm run check:fix` to apply its safe fixes and formatter output locally.

The public Template MCP connection is intentionally not represented by a fake
local endpoint. Configure the review materials with a concrete, working example
endpoint:

```bash
npm run configure:mcp -- \
  --example-url "$TAMA_KIT_EXAMPLE_MCP_URL"
```

The example URL must be publicly reachable and must match the committed
`https://{host}/mcp` template. Tama deployments expose Streamable HTTP at
`/mcp`; their OAuth discovery metadata remains owned by each deployment.
The OpenAI Platform draft identifier shown as `asdk_app_v_...` belongs to the
draft URL and is not an MCP app ID, package setting, or `.app.json` value.

After configuration, run the review-readiness gate and build the distributable
plugin ZIP:

```bash
npm run validate:review
npm run build:submission
```

The archive is written to `dist/tama-kit-<version>.zip`. In the OpenAI Platform
draft, enter the Example and Template MCP Server URLs directly and upload the
final skill bundles from `skills/`. Portal test cases remain in
`evals/cases.json` because they are review materials rather than plugin runtime
files. Copy-ready listing URLs, selected review cases, and release notes live in
`submission/portal.json`.

Template MCP URLs are available only to trusted OpenAI developers with an
established relationship. The OpenAI review also requires a verified publisher,
Apps Management write access, and a public non-test example MCP endpoint. See
the official [plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [submission requirements](https://developers.openai.com/plugins/deploy/submission).

## License

Tama Kit is licensed under the [Apache License 2.0](LICENSE).
