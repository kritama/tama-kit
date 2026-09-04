---
name: tama-kit-cli
description: Bootstrap application repositories with a local Tama runtime, prepare and activate MCP App provider integrations, set up Tama source checkouts, and generate standalone Tama OAuth keys with the Tama Kit CLI. Use when a user asks to bootstrap or integrate an app with Tama, choose Tama Kit flags, continue a staged MCP App setup, or troubleshoot a Tama Kit command.
---

# Tama Kit CLI

Use Tama Kit to turn the user's requested integration into a safe, repeatable
repository change. Inspect the target repository and preserve its instructions,
existing Compose configuration, managed Tama files, and unrelated work.

## Route the request first

When the user asks generally to “bootstrap my app to work with Tama” or gives
equivalent ambiguous instructions, ask this before choosing a command:

> Is this application an MCP App provider that needs OAuth-protected access to
> Tama's `/mcp/app` endpoint, or a standard app that only needs a local Tama
> runtime and Terraform root?

Do not ask when the user has already identified the path. Do not infer MCP App
mode merely because the application uses MCP somewhere else.

Choose among these workflows:

- Standard application repository: `tama-kit bootstrap` without `--mcp-app`.
- MCP App provider repository: `tama-kit bootstrap --mcp-app`.
- A checkout of Tama itself for native Phoenix development: `tama-kit dev setup`.
- A deployment that only needs a System OAuth signing key: `tama-kit oauth generate-key`.

The workflow below is self-contained. You may run the installed command with
`--help` to detect an older or newer installed version, but do not inspect Tama
Kit source code to determine how to perform the setup.

## Do not require a Tama source checkout

Application bootstrap is self-contained: `tama-kit bootstrap` adds the local
Tama Compose runtime and Terraform root to the application repository. Do not
search sibling directories, guess a Tama source path, clone Tama, or switch
repositories just to set up an application integration. A missing Tama checkout
is expected and is not a blocker.

Use `tama-kit dev setup` only when the user explicitly identifies the target as
a Tama source checkout for native Phoenix development. Otherwise recommend the
appropriate `tama-kit bootstrap` command from the application repository.

## Inspect before running

1. For repository workflows, read the target repository's `AGENTS.md` and
   inspect its Git status, framework, Compose files, existing `tama/`
   directory, `tama/.tama.env*` files, and `tama/.tama-kit.json` when present.
2. Confirm Node.js 20.12 or newer. Prefer an already installed `tama-kit`
   executable; otherwise use `npx @kritama/tama-kit` without installing it
   globally.
3. If the installed command rejects a documented flag, run that command's
   `--help` and report the version/interface mismatch; do not inspect CLI source
   code as a substitute for repository evidence.
4. Ask only for values that cannot be established from repository evidence.
   Never ask the user to paste private JWKs, tokens, passwords, or the private
   Tama setup URL into chat.

## Check Docker before writes or runtime use

The JSON dry run is a pure planning step and may run before Docker is installed
or initialized. Before any bootstrap write, verify that the Docker client and
Compose plugin are installed. Run these checks without printing unrelated
environment values:

```bash
docker --version
docker compose version
```

Parse the reported Compose version and require 2.20.0 or newer. Before starting
or inspecting Compose services, opening guided setup, or activating an MCP App
integration, also verify that the daemon is initialized and reachable:

```bash
docker info --format '{{.ServerVersion}}'
```

`docker --version` alone only proves that the client exists. Treat a missing
Docker executable, missing Compose plugin, or a Compose version older than
2.20.0 as a hard preflight failure for a bootstrap write. Treat failed
`docker info` as a hard preflight failure only for operations that start or
inspect services. It must not block a dry run or a bootstrap write that does
not start services. Pause and tell the user which prerequisite is missing or
too old so they can install or start/initialize Docker first. Do not install
Docker or start a daemon on the user's behalf. Do not run Compose, open the
setup URL, or activate the integration unless the user explicitly requested
that operation. After the user confirms Docker is ready, rerun the checks
required for the next operation. These checks are not required for the
standalone `dev setup --prepare-only` or `oauth generate-key` workflows when
they do not use Docker.

## Plan bootstrap, then write

For `bootstrap` workflows, use `--dry-run --json` first. Since JSON mode cannot
prompt, always make the agent-skill choice explicit. First inspect
`tama/.tama-kit.json`. An existing `local` mode must remain `--skills local`;
`--skills manual` does not uninstall managed repository-local skills and the
CLI rejects that switch. Reuse a recorded `manual` mode unless the user
explicitly requests installing repository-local skills. When no mode is
recorded, use `--skills manual` by default because this skill is already active,
unless the user explicitly wants future agents in the repository to receive a
local copy.

Do not carry these flags into other workflows. `dev setup` has its own
`--dry-run`, `--prepare-only`, and `--json` sequence, while
`oauth generate-key` requires exactly one of `--stdout` or `--output` and
accepts none of those planning or skill-installation flags. Use the command
contracts below for the exact supported invocation.

Review the JSON plan for the selected root, Compose file, host port, image,
managed-file operations, sensitive-file markers, and Terraform foundation
ownership. A dry run does not generate reusable secret material and must not be
treated as proof that the runtime is ready.

If the plan matches the user's request, rerun the same command without
`--dry-run`. Keep `--json` so output is deterministic and token-redacted. Add
`--start` only when the user wants the local services started and the required
Docker Compose runtime is available.

Stop and explain managed-file drift, ambiguous foundation ownership, tracked
secret files, unsafe paths, unsupported images, or conflicting topology. Do not
overwrite files, delete state, rotate keys, or reset the manifest to bypass a
safety refusal. Never run `terraform apply` without explicit authorization.

## Standard application command contract

Use these commands from the application repository. Replace
`/path/to/app` only when the agent is operating from another directory.

```bash
npx @kritama/tama-kit bootstrap /path/to/app \
  --skills <resolved-skill-mode> --dry-run --json

npx @kritama/tama-kit bootstrap /path/to/app \
  --skills <resolved-skill-mode> --json
```

Use `tama-kit` instead of `npx @kritama/tama-kit` when the executable is already
installed. Replace `<resolved-skill-mode>` with `local` when that mode is
recorded in `tama/.tama-kit.json`. Otherwise use `manual` by default, or
`local` when the user explicitly requests repository-local skills. `--json`
is deterministic, does not prompt, and redacts secret values. `--dry-run`
plans only; it never writes files or starts Compose. Add `--start` to the
second command only when the user explicitly requests the runtime to start.
`--start` and `--dry-run` cannot be combined.

Optional standard flags are:

- `--compose <path>` to select an existing Compose file when discovery is
  ambiguous;
- `--port <port>` to change Tama's host port from the default `4000`; and
- `--image <reference>` to select a different supported image.

After a write, expect private `tama/.tama.env` and optional
`tama/.tama.postgres.env` files, a managed Compose include, and a `tama/` Terraform root
containing `README.md`, `AGENTS.md`, `.gitignore`, and the manifest
`.tama-kit.json`. Verify private files are ignored and untracked and that the
reported non-sensitive changes are expected.

## Standard application bootstrap

Run from the application root or pass its path. Let Tama Kit detect the
framework and Compose file unless discovery is ambiguous; use `--compose` to
select the intended existing file. Use `--port` or `--image` only for an actual
project requirement.

If the user has not asked you to make the change, recommend the exact
`tama-kit bootstrap --dry-run --json` command and explain what it will plan. If
the user instructs you to run bootstrap, review that plan first, then run the
same command without `--dry-run`; add `--start` only when they also want the
local runtime started.

After the write, verify that sensitive generated files such as `tama/.tama.env*` are
ignored and untracked. Non-sensitive Terraform, documentation, skill, manifest,
and application-owned Compose changes may be intended for version control;
verify that all reported changes are expected rather than untracking them. If
the runtime was started, verify the reported health result. Hand off the
generated `tama/README.md` and `tama/AGENTS.md` instructions for onboarding and
Terraform planning, while keeping the private setup URL out of the response.

## Complete interactive Tama setup when requested

After a successful non-dry-run bootstrap, if guided setup was requested, start
the managed Compose runtime and wait for the reported health endpoint. Then
load `tama/.tama.env` without echoing it and
open the private `/setup/root?token=...` URL in the in-app browser. Walk the
user through creating the root user, signing in, and creating provisioner
credentials. Keep the URL and token inside the browser interaction; never
repeat them in chat, logs, or unrelated output. If browser
control is unavailable, direct the user to the local instructions in
`tama/README.md` without reproducing the token.

Do not open the setup URL or create credentials unless the user explicitly asks
for guided setup. Do not ask the user to paste credentials into chat; have them
store the resulting `TAMA_CLIENT_ID` and `TAMA_CLIENT_SECRET` in `tama/.tama.env`.

The complete standard setup sequence is:

1. Run the reviewed write command, adding `--start` only if requested.
2. If `--start` was omitted, run the Compose command printed by Tama Kit from
   the project root, then run the printed Compose status command. Wait for
   `http://localhost:<TAMA_PORT>/` to respond successfully.
3. If the user explicitly requests guided setup, load `tama/.tama.env` without
   echoing it, derive `http://localhost:<TAMA_PORT>/setup/root?token=<TAMA_SETUP_TOKEN>`
   locally, and open it in the in-app browser. Create the root user, sign in,
   and create provisioner credentials through the browser.
4. Have the user store `TAMA_CLIENT_ID` and `TAMA_CLIENT_SECRET` in the root
   `tama/.tama.env`; never ask them to paste those values into chat.
5. Load `tama/.tama.env` without echoing values and run:

   ```bash
   terraform -chdir=tama init
   terraform -chdir=tama fmt -check -recursive
   terraform -chdir=tama validate
   terraform -chdir=tama plan
   ```

6. Summarize all Terraform create, update, replace, destroy, and error actions.
   Run `terraform apply` only after the user explicitly approves that plan.

## MCP App provider bootstrap

Run this workflow from the provider application's repository. First inspect
the Tama Kit bootstrap state before inspecting or changing provider behavior.
Check `tama/.tama-kit.json`, `tama/AGENTS.md`, `tama/README.md`,
`tama/contracts/mcp-app-provider-v1.json`, `tama/.tama.env*`, and the optional
`priv/contracts/tama-mcp-app-bootstrap-v1.json` for presence, ownership, and
loader wiring; also inspect the intended Compose file and `.gitignore` rules.
Classify the state as complete, incomplete, or absent without printing private
values. If it is absent or incomplete, first run and review:
`tama-kit bootstrap --mcp-app --dry-run --json`. Then perform the approved
write before provider implementation or activation.

After the bootstrap gate passes, inspect whether the application already
provides the exact OAuth 2.1 capabilities required by the bundled
`app-integration` skill. Classify it as ready, partial, or absent; generic OAuth
for another resource is not sufficient.

If it is ready, reuse the implementation and verify the exact contract before
provisioning. If it is partial, explain the missing capabilities. If it has no
OAuth provider, explicitly tell the user that an application-side OAuth
provider integration is a prerequisite for usable `/mcp/app` access. Tama Kit
only provisions configuration and trust material. Unless provider
implementation was already authorized, ask whether the user wants that larger
prerequisite implemented and do not activate or describe the app as ready.
Route authorized provider work through `app-integration` when available.

Before planning the CLI command, also establish:

- the explicit provider identity when a committed provider contract does not
  supply it;
- one provider origin reachable from both the host and Tama container;
- the exact loopback Tama origin and matching Tama host port;
- every browser or MCP client origin that should be allowed; and
- a pinned Tama image accepted by the installed bootstrap contract.

Allow Tama Kit to discover
`priv/contracts/tama-mcp-app-bootstrap-v1.json`, or use `--mcp-app-contract` for
an intentional non-default contract. The application owns that file; do not
generate or rewrite it. Tama Kit owns the generated non-secret local projection
at `tama/contracts/mcp-app-provider-v1.json` and the managed environment
fragments. Contract presence is not proof that the provider loads its fragment
or implements the live OAuth endpoints.

The CLI does not implement the application's authorization, consent,
persistence, token, revocation, or introspection behavior. An explicitly
requested configuration-only write may stage an incomplete provider in
`prepared`, but report it as unverified and never follow it with activation.

Prepare first without `--activate`. Provider and Tama modes remain staged while
the application is configured to load the reported provider fragment. Use
`--start --activate` only when the user explicitly wants activation and the
provider can be run in prepared mode. Follow the command's two-step handoff:
Tama Kit may enable and verify Tama, but the user or provider-owned workflow
must set the reported provider mode to `enabled` and restart the provider before
the same activation command is rerun. Report prepared, activation-required,
enabled, and verification states distinctly.

Treat provider identity and public scheme/host as stable topology. Use
`--migrate-provider-identity` only for a deliberate migration that the user
requested and only after the new provider loader is ready; do not combine it
with activation.

### MCP App command contract

Fresh MCP App bootstrap uses a production-compatible local HTTPS topology:

```bash
npx @kritama/tama-kit bootstrap /path/to/provider \
  --mcp-app \
  --provider-name acme \
  --image ghcr.io/upmaru/tama:<pinned-version-in-intersection>-server \
  --skills <resolved-skill-mode> \
  --dry-run --json
```

The default public identities are `https://app.localhost` for the host-native
provider and `https://tama.app.localhost` for Tama's protected
`/mcp/app` resource. Caddy is the only public entry point; its
`host.docker.internal:<provider-port>` and `tama:4000` upstreams are private
routing details and never OAuth identities. The provider remains
`MIX_ENV=dev`, while the official Tama image remains `MIX_ENV=prod`.
Use `--local-domain` and `--provider-port` for deliberate customization. A
non-`.localhost` name also requires `--acknowledge-local-domain-risk` after
local-only DNS resolution is verified.
`--provider-origin` and `--tama-origin` are advanced migration assertions.
The default allowed client origin is the provider origin; repeat
`--allowed-origin` only for additional clients.
Loopback client origins may use HTTP, but every non-loopback allowed origin must use HTTPS;
at most 32 unique allowed origins are supported.

Supported MCP App flags are `--provider-name`, `--local-domain`,
`--acknowledge-local-domain-risk`, `--provider-port`,
`--install-local-ca`, `--migrate-local-https`, `--provider-origin`,
`--tama-origin`, repeated `--allowed-origin <origin>`,
`--mcp-app-contract <path>`, `--provider-prefix <prefix>`,
`--provider-env-file <path>`, `--activate`, and
`--migrate-provider-identity`. Provider-specific flags require `--mcp-app`;
`--activate` also requires `--start`. Existing HTTP projects require an
explicit `--migrate-local-https`; migration preserves OAuth and application
secrets.
Use the official server image tag `<version>-server` with a pinned version in
the supported Tama range; the floating `latest` tag is not valid for MCP App
preparation.

After reviewing the dry run, repeat the exact command without `--dry-run` to
write prepared configuration. Configure the provider to load the reported
private fragment, restart it in `prepared`, and verify metadata, public JWKS,
authenticated inactive-token introspection, and the absence of resource
advertisement and token issuance. Only after explicit activation authority run
the exact command with `--start --activate`; set the provider mode to
`enabled`, restart it, and rerun the same activation command. Accept success
only when Tama Kit reports both services live and the enabled checkpoint.

The generated local contract at
`tama/contracts/mcp-app-provider-v1.json` is safe to commit. The provider
fragment and `tama/.tama.env` contain private keys and must remain ignored and
untracked. The optional provider contract at
`priv/contracts/tama-mcp-app-bootstrap-v1.json` is application-owned: read it,
but never create or rewrite it.

### Tama source-development command contract

Only for an actual Tama Phoenix source checkout, use:

```bash
npx @kritama/tama-kit dev setup /path/to/tama --dry-run --json
npx @kritama/tama-kit dev setup /path/to/tama --json
```

`dev setup` accepts `--port` (default `4001`), `--postgres-port` (default
`55432`), `--prepare-only`, `--dry-run`, `--json`, and `--no-color`. It starts
only the Tama repository's PostgreSQL service, runs `mix setup` and test
foundation setup on a full write, and does not replace application bootstrap.

### Standalone System OAuth key command contract

Use this only when bootstrap does not own the environment:

```bash
tama-kit oauth generate-key --kid staging-key-1 \
  --output /private/ignored/directory/staging.env
```

Exactly one of `--stdout` or `--output` is required. Prefer a new private,
ignored output path. The command refuses existing destinations, unsafe parents,
symlinks, tracked files, and unignored paths. Never print the generated JWK;
report only the destination path.

## Finish with evidence

Report the command mode, expected file changes, runtime start/health state,
MCP App lifecycle and verification state when applicable, and any external
steps still owned by the user. Distinguish generated configuration from live
runtime verification. Never reproduce secret values or private setup URLs.
