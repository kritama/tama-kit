# Tama Kit command reference

| Command | Purpose | Writes |
| --- | --- | --- |
| `bootstrap [path]` / `init [path]` | Initial generation; existing projects offer continuation | New files and reviewed integration edits |
| `generate mcp-app [path]` | Add MCP App to an existing standard project | Capability additions and missing ignore entries |
| `setup [path]` | Start and verify current configuration | Runtime operations |
| `setup --activate` | Verify prepared services and enable Tama | One unshadowed Tama mode assignment |
| `setup --dry-run` | Inspect configuration and preview activation when requested | None |
| `doctor [path]` | Inspect Compose, bindings and Terraform readiness | None |
| `doctor --runtime` | Also probe existing services | None |
| `env doctor [path]` | Inspect declared private environment files | None |
| `env init [path]` | Recover missing supported required environment files | Exclusive new private files only |
| `env init --dry-run` | Preview recovery and blockers | None; no keys generated |
| `dev setup [path]` | Native Tama Phoenix checkout setup | Separate development workflow |
| `oauth generate-key` | Generate a standalone System OAuth key | New explicit output only |

## Fresh generation

Use `--dry-run --json` for a noninteractive preview. `--skills local` copies
project-owned skills; `--skills manual` leaves skill installation to the caller.
`--image`, `--port`, and `--compose` choose the initial runtime. `--start` may
start and verify it after generation. MCP App generation adds `--mcp-app`,
`--provider-name <name>`, `--provider-port`, `--provider-service` (Compose runtime),
`--provider-runtime`, `--provider-prefix`, `--provider-env-file`,
`--mcp-app-contract`, `--local-domain`, `--allowed-origin` (repeatable),
`--acknowledge-local-domain-risk`, and `--install-local-ca`.
Use the command's `--help` for the installed version's complete argument list.

Completed generation never refreshes files, rotates keys, repairs permissions,
or recreates deleted output. Changing existing configuration through bootstrap
migration flags is no longer supported. Edit current files directly, preserving
keys and reviewing public identity, routing, certificates and bindings together.
An unfinished receipt permits `--resume <operation-id>` with the original
options; it may create only still-pending files and preserves existing output.
The receipt is optional provenance after generation. Setup and doctor ignore it.

## Add MCP App to a standard project

`generate mcp-app` accepts provider/contract/local HTTPS inputs from fresh
MCP App generation, plus ordered repeatable `--compose`, `--service`, and
`--env-file` selections. It reuses a compatible pinned runtime image; use
`--image` explicitly for a floating tag or custom build. `--start`, `--activate`,
`--port`, `--skills` and old migration flags are not additive generation options.

Preview with `--dry-run --json`; this needs Compose but not a daemon. Local HTTPS
requires Compose 2.24.4+, mkcert for writes, and explicitly authorized CA trust
installation if necessary. The override appends a new private environment fragment,
selects a derived CA image, and removes old Tama port publications. Existing files,
keys and Terraform are preserved; conflicting destinations fail before writes.

Use the output's `commands.setup`, `commands.activate`, `commands.doctor`, and
native Compose commands, also recorded in `tama/MCP_APP.md`. The override must
remain last in that selection. The new private TLS PEM bundle combines the
certificate and key atomically. Host providers load its public root from
`tama/mcp-app-tls/rootCA.pem`. Providers own loading their fragment, enabling
their mode, and restarting; generation reports no runtime acceptance.

`tama/.tama-kit-mcp-app.json` is a separate v2 capability receipt. An explicit
`--resume <id>` needs that unfinished receipt and the original options. Completed
reruns do not write, regardless of later edits or deletions.

## Current configuration selection

Setup and doctor accept ordered, repeatable `--compose <path>` (root then
overrides), `--service <name>`, `--proxy-service <name>`, `--env-file <path>`,
`--contract <path>`, `--provider-service <name>`, and `--ca-file <path>`.
Doctor accepts `--terraform-root <path>` and reports missing tooling,
uninitialized providers or invalid configuration without running init.
Use native Compose and Terraform commands to inspect details privately.

`--json` and non-TTY execution never prompt; `--non-interactive` disables
terminal questions. `--no-color` suppresses styling. `--help` is read-only.
Current inspection requires native Compose JSON and `--no-env-resolution`
support. Read-only configuration inspection does not need a running daemon.
Env init probes persistence before new secret issuance; failed probes leave an
unknown state requiring an explicit fresh-runtime assertion. Startup and runtime
probes require the daemon to be reachable.

## Private environment recovery

Use this after cloning a bootstrapped project whose ignored private files are
absent. These commands never prompt, regardless of JSON or terminal mode:

```bash
tama-kit env doctor --json
tama-kit env init --dry-run --json
tama-kit env init --json
tama-kit env doctor --json
```

Inspect blockers before writing. Supported roles are core `.tama.env`, derived
`.tama.postgres.env`, additive `.mcp-app.env`, and the provider fragment named by
the selected local MCP App contract. Init creates only missing required files
with mode 0600; existing files and keys are preserved. Optional absent files are
informational and never auto-created. Other application files need manual
restoration; invalid existing files need repair through the project workflow.

Both commands accept a project path and ordered repeatable `--compose`,
`--service`, `--env-file`, `--contract`, and `--provider-service`. Paths are relative
to that project root. Preserve this selection in every command; additive projects
need their MCP App override after the base roots. Select a provider when multiple
Compose services load its fragment. A host provider has no provider-service flag.
Proxy/CA/Terraform options apply to `setup`/`doctor`, not `env` commands.

Current Compose env-file/inline precedence, local contracts, public examples and
surviving private files supply recovery inputs. Receipts do not describe desired
configuration. Resume incomplete generation explicitly before recovering files;
completed generation never recreates deleted output. Standard public inputs
come from `.tama.env.example`; combined integration inputs live there too.
Additive projects use `.mcp-app.env.example`, and provider fragments have sibling
examples. Missing or conflicting public identity, origins or contract bindings
block recovery instead of being guessed.

New secret issuance checks Tama persistence and, for MCP App, provider database,
data mounts and running/stopped provider containers. Detected persistence refuses
issuance even with `--fresh`; restore original private files when retaining data.
Unknown persistence requires the caller's explicit fresh-runtime assertion:

```bash
tama-kit env init --fresh --dry-run --json
tama-kit env init --fresh --json
```

Carry the current selection into these commands. `--fresh` neither resets data
nor bypasses detected data or ambiguous associations. Derived-only PostgreSQL
recovery can retain surviving credentials with data present. Init rechecks inputs
and persistence inside the transaction; failures roll back newly created files.

New integration signing material is independent on provider and Tama sides and
requires prepared peers. Existing keys, modes and overlap sets are preserved;
enabled/conflicting peers block new issuance. Follow the provider loader and
`setup ... --activate` handoff after prepared verification. Local HTTPS needs its
own certificate/trust preparation. Init never starts services, creates TLS,
activates integration modes, supplies provisioner credentials or runs Terraform.

`env doctor --json` reports file role/source/status, declaring services, sanitized
issues, `changes: []` and `persistence.status: not-checked`. Init reports file
create/preserve actions, new/derived/none issuance, persistence, blockers, changes
and next actions. Dry-run reports planned destinations without creating keys or
files. Results never contain private file contents. Successful results exit 0;
unsatisfied required files or init blockers exit 4. Other CLI errors retain their
category and exit code. Empty provisioner credentials are expected until private
onboarding; successful environment completion does not verify runtime readiness.

## MCP App handoff

1. Generate initial prepared configuration and implement the application provider.
2. Load its private fragment through the application-owned loader and start it.
3. Run authorized `setup --activate`; it verifies prepared services and enables Tama.
4. Set the reported provider mode to enabled and restart it in the application.
5. Run `setup` to verify both live enabled services.

The provider is never reconfigured or restarted by Tama Kit. Activation changes
only Tama's mode when its effective source is unambiguous and safely editable.
On failure after that edit, recovery restores only its own assignment; concurrent
mode edits require manual resolution. Already-enabled checks never reset modes.

`setup.phase` distinguishes configuration, running, provider-restart-required,
verification-required, and live enabled. `runtimeHealth` and `runtimeVerified`
are separate. `foundation=not-verified` requires native Terraform and runtime
evidence. Sanitized `error.diagnostic` identifies startup failures; raw private
Compose output and secret values are suppressed.
