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
support. Only service startup or runtime inspection requires the Docker daemon.

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
