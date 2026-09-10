---
name: tama-kit-cli
description: Bootstrap application repositories with a local Tama runtime, prepare and activate MCP App provider integrations, set up Tama source checkouts, and generate standalone Tama OAuth keys with the Tama Kit CLI. Use when a user asks to bootstrap or integrate an app with Tama, choose Tama Kit flags, continue a staged MCP App setup, or troubleshoot a Tama Kit command.
---

# Tama Kit CLI

Inspect the application's instructions, Git status, current Compose files,
Terraform root, local MCP App contract, and private environment loader before
choosing an operation. All generated files are developer-owned immediately.
Edit them directly; receipts and generator comments are provenance only.
Never refresh generated files or update manifest hashes to make a check pass.

## Choose the command

- Fresh standard runtime: `tama-kit bootstrap`.
- Fresh MCP App provider integration: `tama-kit bootstrap --mcp-app`.
- Add MCP App to an existing standard runtime: `tama-kit generate mcp-app`.
- Existing project configuration: `tama-kit setup` to start and verify services.
- Read-only configuration diagnosis: `tama-kit doctor`; add `--runtime` for probes.
- Tama Phoenix source development: `tama-kit dev setup`.
- Standalone System OAuth signing key: `tama-kit oauth generate-key`.

If setup mode is unclear, establish whether the application needs a standard
runtime or is an OAuth provider for Tama's `/mcp/app`. Do not infer the latter
merely because an application uses MCP.

Use an installed `tama-kit`, otherwise `npx @kritama/tama-kit`. Check `--help`
if the installed interface differs. Do not inspect Tama Kit source to operate
the CLI. Application bootstrap does not require a Tama source checkout; do
not search sibling repositories or clone Tama to integrate an application.

## Generation and continuation

Bare bootstrap guides a person through initial settings and a review.
Agents use explicit flags and JSON; JSON/non-TTY execution never prompts.
For initial generation, preview with `bootstrap --dry-run --json` and execute
without `--dry-run` when local generation is authorized. Choose `--skills local`
for repository copies, or `--skills manual` for externally installed skills.
Copied skills become project-owned and bootstrap will not refresh them.

Existing bootstrap reruns produce no generation changes. They preserve edited
and deliberately deleted output. The interactive command offers setup or doctor.
Compatibility `bootstrap --start` and `--activate` route existing projects to
setup; prefer setup directly. Configuration-changing and migration flags do
not upgrade existing projects. Edit their current configuration instead.
An unfinished receipt may be resumed only with its explicit `--resume <id>`
and original generation options. Only pending destinations may be created;
existing output is preserved. Do not manufacture or edit a receipt to bypass
conflicts. Missing or invalid receipts do not prevent setup or doctor.

For a standard project gaining MCP App, use `generate mcp-app --dry-run --json`
with the provider inputs; do not rerun bootstrap with integration flags. Reuse
an existing compatible pinned image, or explicitly choose `--image` when the
current tag is floating or the service has a custom build. Select current
Compose files in order and the Tama service/environment source as needed.
The output includes a separate Compose override, private MCP fragment, provider
contract and `tama/MCP_APP.md`. Carry the emitted Compose selection into setup,
doctor and native commands. Local HTTPS changes the selected service's build
and published ports through that override. The separate MCP addition receipt
supports explicit unfinished resume; it never authorizes repairing completed output.

## Check prerequisites

Initial bootstrap dry-run needs neither Docker nor its daemon. Additive MCP App
generation reads current configuration and requires Compose even for dry-run;
its local HTTPS override requires Compose 2.24.4 or newer. A write needs Docker
and Compose 2.20.0 or newer (`docker --version`, `docker compose version`).
Current-configuration inspection additionally needs Compose's native
`config --format json --no-env-resolution` support, but no daemon. Starting or
probing services requires `docker info --format '{{.ServerVersion}}'` to succeed.
A failed daemon check must not block a generation dry run. Let the user install
or initialize missing tools; do not install or start Docker on their behalf.
Local HTTPS generation needs mkcert; CA trust is an explicit host operation.

## Use current project configuration

Run `doctor --json` or `setup --dry-run --json` first when inspection is useful.
Select nonstandard layouts with repeatable `--compose <path>` (root first,
overrides in order), `--service`, `--proxy-service`, `--env-file`, `--contract`,
`--provider-service`, and `--ca-file`. Doctor also accepts `--terraform-root`.
Selections apply consistently to Compose validation, start, status, and probes.
The actual Compose model, environment bindings, contract, Terraform source and
state are authoritative. Do not require historical files, hashes, topology, or
loader checkpoints. Ambiguous service or writable mode sources need an explicit
selection or manual edit. Keep secrets private, ignored, and untracked.

Doctor never initializes Terraform or rewrites configuration. Missing tooling,
uninitialized providers, and invalid Terraform are distinct from runtime health.
Use native `docker compose` and `terraform init`, `fmt`, `validate`, and `plan`
commands as needed; these workflows do not require Tama Kit or its receipt.
Review a Terraform plan before an authorized apply. File presence does not
prove the global foundation or an active root recipient exists.

## Complete browser root setup when requested

After a successful non-dry-run bootstrap, if browser root setup was requested, start
the current Compose runtime and wait for the reported health endpoint. Then
load `tama/.tama.env` without echoing it and
open the private `/setup/root?token=...` URL in the in-app browser. Walk the
user through creating the root user, signing in, and creating provisioner
credentials. Keep the URL and token inside the browser interaction; never
repeat them in chat, logs, or unrelated output. If browser
control is unavailable, direct the user to the local instructions in
`tama/README.md` without reproducing the token.

Do not open the setup URL or create credentials unless the user explicitly asks
for browser root setup. The terminal wizard alone does not authorize browser
credential creation. Do not ask the user to paste credentials into chat; have them
store the resulting `TAMA_CLIENT_ID` and `TAMA_CLIENT_SECRET` in `tama/.tama.env`.

The complete standard setup sequence is:

1. Run the reviewed write command, adding `--start` only if requested.
2. If `--start` was omitted, run the Compose command printed by Tama Kit from
   the project root, then run the printed Compose status command. Wait for
   `http://localhost:<TAMA_PORT>/` to respond successfully.
3. If the user explicitly requests browser root setup, load `tama/.tama.env` without
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

For a fresh integration, read the application-owned provider contract when
present and use the `app-integration` skill for OAuth readiness and implementation.
Preview `bootstrap --mcp-app --dry-run --json` with explicit provider inputs.
The local contract `tama/contracts/mcp-app-provider-v1.json` becomes editable
project configuration. The contract under `priv/contracts/` remains application
runtime documentation. Neither artifact proves live readiness.

Fresh generation defaults to local HTTPS identities `https://app.localhost`
and `https://tama.app.localhost/mcp/app`. Use `--provider-name`, `--provider-port`,
`--local-domain`, and optionally `--provider-service` for an existing Compose
provider. Private container and host transport names are not OAuth identities.
Use the official server image tag `<version>-server` pinned to the intersection
of the bundled range `>= 0.13.2 and < 0.14.0` and the provider contract's range.
Without a narrower provider range, `0.13.2-server` is the default.
Supply at most 32 unique allowed origins with `--allowed-origin`; every
non-loopback allowed origin must use HTTPS. Custom non-`.localhost` domains
require `--acknowledge-local-domain-risk` and operator-managed DNS.

The application owns its provider listener, environment loader, code, keys,
mode and restart. Make it load the private fragment specified in the current
local contract. Keep fragments ignored and untracked; never print private JWKs
or credentials. Readiness is checked against current bindings, not receipt data.

After both prepared services are ready, authorized `setup --activate` verifies
them, changes only Tama's unshadowed mode assignment, restarts Tama, and reports
the provider mode/restart handoff. Set the provider mode to enabled through its
application workflow and run `setup` again. Existing enabled verification
failures do not revert configuration. Recovery after this invocation's Tama
mode edit restores only that assignment and preserves unrelated developer edits.
If its mode source is ambiguous, edit it manually and run setup for verification.

`setup.phase`, `runtimeHealth`, and `runtimeVerified` distinguish configured,
provider-restart-required, verification-required and live enabled states.
Follow `setup.nextActions` and each `workingDirectory`. Complete browser root
setup, Terraform provisioning and OAuth client connection independently.
Use authorization code with PKCE for clients; provisioner credentials are not
MCP client credentials. See the [CLI reference](references/cli-reference.md).

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

Use this for a deliberately selected standalone environment:

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
