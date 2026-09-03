# Tama Kit CLI reference

Use the help output from the installed Tama Kit version as the final authority.
This reference explains how the current commands and flags affect workflow
decisions.

## Command selection

| Goal | Command |
| --- | --- |
| Add a local Tama Compose runtime and Terraform root to an application | `tama-kit bootstrap [path]` |
| Bridge an MCP App provider to Tama's protected `/mcp/app` endpoint | `tama-kit bootstrap [path] --mcp-app` |
| Prepare a Tama source checkout for native Phoenix development | `tama-kit dev setup [path]` |
| Generate a System OAuth private JWK outside bootstrap | `tama-kit oauth generate-key` |

`tama-kit init` is an alias for `bootstrap`.

## Shared bootstrap flags

| Flag | Use |
| --- | --- |
| `--compose <path>` | Select one existing Compose file when discovery is ambiguous. |
| `--port <port>` | Select Tama's host port. The ordinary default is `4000`; MCP App topologies commonly need a different port from the host-native provider. |
| `--image <reference>` | Override the Tama image. MCP App mode requires a pinned version inside the installed contract's supported range. |
| `--skills local\|manual` | Copy Tama Kit skills to `.agents/skills/` or leave their installation external. Supply this explicitly with `--json`. |
| `--dry-run` | Return a plan without writing or starting services. It cannot be combined with `--start`. |
| `--start` | Start Compose and wait for Tama health after writing. |
| `--json` | Emit deterministic machine-readable output without secret values or terminal progress. |
| `--no-color` | Disable color in human output. |

Recommended agent sequence for a standard app:

```bash
npx @kritama/tama-kit bootstrap /path/to/app \
  --skills local --dry-run --json

npx @kritama/tama-kit bootstrap /path/to/app \
  --skills local --json
```

Add `--start` to the write command only when starting Docker services is part of
the request.

## MCP App flags and constraints

All provider-specific flags require `--mcp-app`.

| Flag | Use and constraints |
| --- | --- |
| `--mcp-app-contract <path>` | Select an application-owned provider contract instead of default discovery. |
| `--provider-name <name>` | Confirm the stable provider identity. Non-interactive runs must make a detected identity explicit unless the contract or persisted state owns it. |
| `--provider-prefix <prefix>` | Override the derived provider environment-variable prefix. Keep it stable across reruns. |
| `--provider-env-file <path>` | Override the derived private provider fragment path. The provider must actually load this file. |
| `--provider-origin <origin>` | Set the provider issuer/service origin. It must have no path, query, or fragment and must be reachable by both host probes and the Tama container. Do not use loopback or `0.0.0.0`; for a host-native HTTP provider, use `http://host.docker.internal:<provider-port>`. |
| `--tama-origin <origin>` | Set Tama's exact public origin. For the generated local Compose service it must be HTTP loopback and use the selected `--port`. |
| `--allowed-origin <origin>` | Allow an exact browser/MCP client origin. Repeat for multiple origins. At least one is required; non-loopback origins must use HTTPS. Maximum 32 unique origins. |
| `--activate` | Request live activation and verification. Requires both `--mcp-app` and `--start`. |
| `--migrate-provider-identity` | Deliberately migrate persisted provider identity. Requires an explicit `--provider-name`, a verified loader for the new fragment, and prepared provider mode. It cannot be combined with `--activate`. |

For this Tama Kit contract revision, the bundled supported Tama range is
`>= 0.13.1 and < 0.14.0`; confirm it against the installed version before
choosing a tag. A typical local plan is:

```bash
npx @kritama/tama-kit bootstrap /path/to/provider \
  --mcp-app \
  --provider-name acme \
  --provider-origin http://host.docker.internal:4000 \
  --tama-origin http://127.0.0.1:4001 \
  --allowed-origin http://127.0.0.1:3000 \
  --port 4001 \
  --image ghcr.io/upmaru/tama:0.13.1 \
  --skills local \
  --dry-run --json
```

Repeat the accepted command without `--dry-run` to prepare files. Do not add
activation implicitly.

### MCP App lifecycle

1. Preparation writes both owners' environment inputs in `prepared` mode and
   generates `tama/contracts/mcp-app-provider-v1.json` before environment
   planning. It does not prove the provider loads its fragment.
2. Configure the provider process to load the reported private fragment and
   restart it in prepared mode.
3. With explicit user authorization, rerun the full command with
   `--start --activate`. Tama Kit checks the prepared provider, starts/enables
   Tama, and reports when provider activation is still required.
4. Set the reported provider-owned mode variable to `enabled`, restart the
   provider, and rerun the same activation command.
5. Treat the integration as enabled only when the result reports the enabled
   checkpoint and successful live verification.

If enabled-state verification fails, Tama Kit restores the prepared files and
restarts Tama in prepared mode without rotating trust material. If the provider
had already loaded its enabled fragment, tell its owner to restart the provider
after the fragment is restored. Do not report activation until the next full
verification succeeds.

The generated provider private key stays in the provider fragment. Tama's
introspection private key stays in `.tama.env`. Neither belongs in source
control, logs, prompts, or chat.

### MCP App reruns

- Keep provider identity, provider origin, allowed origins, Tama image, and
  relevant explicit flags consistent with persisted state.
- Change a Tama port through another `--mcp-app` run so the resource,
  introspection client ID, contract, and both environment owners update
  atomically.
- A normal rerun cannot change provider scheme/host. Treat that as a topology
  migration requiring separate design and authorization.
- Do not remove a manifest entry or private fragment to work around drift or
  rotate keys accidentally.

## Tama source development

`dev setup` is for the Tama repository itself, not an application consuming a
local Tama runtime.

| Flag | Use |
| --- | --- |
| `--port <port>` | Native Phoenix loopback port; default `4001`. |
| `--postgres-port <port>` | Isolated Compose PostgreSQL loopback port; default `55432`. |
| `--prepare-only` | Generate private environment files without starting services or running Mix. |
| `--dry-run` | Inspect without writing or starting. |
| `--json` | Emit secret-free machine output. |

Typical sequence:

```bash
npx @kritama/tama-kit dev setup /path/to/tama --dry-run --json
npx @kritama/tama-kit dev setup /path/to/tama --json
```

The full write starts only Tama's repository-owned PostgreSQL service, runs
`mix setup`, and ensures the test foundation. The user starts native Phoenix
separately with the generated environment.

## Standalone OAuth key generation

Use this only when bootstrap does not own the environment, such as a staging
secret-manager workflow:

```bash
tama-kit oauth generate-key --kid staging-2026-09-01-1 \
  --output /private/ignored/directory/staging.env
```

Exactly one of `--stdout` or `--output` is required. Prefer `--output` to a new,
private, Git-ignored path. The command refuses replacement, unsafe parents,
symlinks, tracked destinations, and destinations inside Git that are not
ignored. Use `--stdout` only when the caller can pipe the two dotenv assignments
directly into an authorized secret-management workflow without exposing them
to logs or chat.
