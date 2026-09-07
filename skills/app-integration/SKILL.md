---
name: app-integration
description: Assess, implement, and provision an application's OAuth 2.1 authorization-server integration for Tama's protected `/mcp/app` endpoint. Use when checking whether an app's existing OAuth is Tama-ready, identifying or closing provider gaps, consuming a Tama Kit MCP App contract, or completing provider-side work after `tama-kit bootstrap --mcp-app`. Do not use for ordinary Tama graph construction or for Tama's provider-independent `/mcp/system` authorization.
---

# Tama MCP App integration

Make the application the OAuth authorization server for one exact protected
resource owned by Tama: `/mcp/app`. Implement the provider-side vertical slice
and use Tama Kit to provision the cross-service local configuration. Do not
implement `/mcp/app` inside the application; Tama owns that endpoint.

Tama Kit provisions the local Tama runtime from the application repository; it
does not require a sibling Tama source checkout. Do not search for, clone, or
switch to a separate Tama repository during application setup.

Read [the OAuth contract](references/mcp-app-oauth.md) before changing provider
authorization, tokens, introspection, lifecycle, or persistence.

## Choose terminal guidance or agent execution

For a person setting up the application in their terminal, recommend bare
`tama-kit bootstrap` and select MCP App setup in the questionnaire. The wizard
discovers configuration, presents a preview, and offers preparation, startup,
or staged activation. A later bare invocation can resume or inspect configured
status; `:back` and `:cancel` allow revision or exit before effects.

For agent execution, use the explicit `--dry-run --json` sequence below and
reuse valid recorded choices. JSON and non-TTY calls never ask questions;
`--non-interactive` disables questions for `bootstrap` in a terminal. Ask only
for missing intent or values. The terminal wizard does not implement provider
OAuth or authorize browser root-user/provisioner creation.

## Check Docker before writes or runtime use

The JSON dry run is a pure planning step and may run before Docker is installed
or initialized. Before running MCP App bootstrap without `--dry-run`, verify
the Docker client and Compose plugin:

```bash
docker --version
docker compose version
```

Parse the Compose version and require 2.20.0 or newer. Before starting or
inspecting Compose services, opening browser root setup, or activating the
integration, also verify that the daemon is initialized and reachable:

```bash
docker info --format '{{.ServerVersion}}'
```

If a required check fails or the Compose version is too old, pause and tell the
user to install or start/initialize Docker before the corresponding write or
runtime operation. A failed daemon check must not block a dry run or a
bootstrap write that does not start services. After the user confirms
Docker is ready, rerun the checks required for the next operation. Never
install or start Docker on the user's behalf.

## Inspect current project configuration first

Read repository instructions and Git status, then inspect the intended Compose
files, current environment bindings, local MCP App contract, provider loader,
and Terraform source and state before assessing readiness. All generated output
is developer-owned and may be edited directly. `tama/.tama-kit.json` and generator
comments are optional provenance, never a permanent integration gate.

Use `tama-kit doctor --json` for read-only inspection of existing configuration.
For custom layouts select ordered `--compose` files, `--service`, `--env-file`,
`--contract`, `--provider-service`, `--proxy-service`, and `--ca-file` as needed.
Missing receipts or stale historical hashes do not justify regeneration.
Keep secrets ignored, untracked, and private; inspect presence and loader wiring
without printing values. Diagnose actual missing files or incompatible bindings.

Only a fresh integration uses `bootstrap --mcp-app --dry-run --json`, followed
by the authorized initial write. An interrupted generation requires its explicit
resume ID and original options. Existing projects continue with `setup`; do not
regenerate edited or deleted output as a readiness prerequisite. Native Docker
Compose and Terraform workflows remain valid without Tama Kit.

## Assess provider readiness after configuration inspection

Inspect the application before provisioning and classify it as ready, partial,
or absent:

- **Ready OAuth provider:** it already satisfies the exact Tama MCP App
  contract, including authorization code with PKCE S256, the exact Tama
  `/mcp/app` resource, `mcp.message`, public metadata and JWKS, RS256-signed
  access tokens and claims, lifecycle gates, persistence and revocation,
  Tama-authenticated introspection, and reachability from Tama. Reuse it and
  close only evidence-backed gaps.
- **Partial or incompatible OAuth:** it has OAuth, but one or more required
  capabilities or bindings are missing. Explain the exact gaps. Do not assume
  an OAuth server for the application's own API is ready for Tama.
- **No OAuth provider:** tell the user that an application-side OAuth 2.1
  provider integration is a prerequisite for `/mcp/app`. Explain that Tama Kit
  can provision configuration and trust material but cannot supply the
  application's authorization, actor, consent, persistence, issuance,
  revocation, or introspection behavior.

If the user only asked to bootstrap or provision and closing a partial or
absent implementation would materially expand the work, stop before changing
application behavior and ask whether they want that prerequisite implemented.
If they already authorized implementation, proceed without asking again. If
they decline, offer ordinary non-MCP Tama bootstrap when useful and do not
claim that `/mcp/app` is ready or activatable.

Never run `setup --activate` until the readiness evidence in the
contract reference is satisfied. A user may explicitly choose to stage
prepared configuration before the provider code is ready, but report it as
configuration-only and unverified.

## Establish the contract

1. Read the target application's repository instructions, framework,
   authentication model, persistence conventions, routes, environment loader,
   tests, and dependency versions.
2. Inspect `tama/contracts/mcp-app-provider-v1.json` when present. Treat it as
   Tama Kit's normalized, non-secret local configuration for provider identity,
   semantic environment bindings, public endpoint paths, lifecycle modes, and
   loader evidence. It is not proof of runtime behavior.
3. Inspect `priv/contracts/tama-mcp-app-bootstrap-v1.json` when present. It is
   application-owned runtime documentation; preserve its declared names and
   paths and never let Tama Kit rewrite it.
4. If an existing project's local contract is missing, diagnose the missing
   configuration and restore or author it from the application's actual binding
   contract. Do not recreate the full scaffold. Fresh generation writes an initial
   local projection after public identities and provider runtime are selected.

Do not invent environment names independently of the current contract. Change
project-owned contracts, fragments, loader and runtime configuration together
when authorized, preserving existing keys. No manifest hashes need updating.

### Tama Kit command contract

Run from the provider application's repository. Use `tama-kit` when installed,
otherwise use `npx @kritama/tama-kit`. For initial generation choose
`--skills local` for repository copies or `--skills manual` for external skills.
Copied skills are project-owned and are not refreshed by bootstrap:

```bash
npx @kritama/tama-kit bootstrap . \
  --mcp-app \
  --provider-name <provider-name> \
  --image ghcr.io/upmaru/tama:<pinned-version-in-intersection>-server \
  --skills <resolved-skill-mode> \
  --dry-run --json
```

Fresh MCP App bootstrap derives the production-compatible local HTTPS topology:
`https://app.localhost` for the provider and
`https://tama.app.localhost/mcp/app` for Tama. Caddy is the public entry point;
the host provider upstream is `host.docker.internal:<provider-port>` and Tama's
is `tama:4000`. For an application-owned Compose provider, add
`--provider-service <service>`; its private upstream becomes
`<service>:<provider-port>`. These routing addresses are never OAuth identities.
The application owns its development image, listener, loader, and restart;
Tama uses the production release image. Read the
[provider runtime requirements](references/mcp-app-oauth.md#local-provider-runtime)
before selecting a Compose service.
Use `--local-domain` and `--provider-port` for deliberate
customization; a non-`.localhost` name also requires
`--acknowledge-local-domain-risk`. With no explicit origins, a fresh HTTPS
setup defaults to the provider origin. Repeated `--allowed-origin` flags supply
the complete list, replacing defaults and recorded values; include the provider
origin if its browser needs access. `--provider-origin` and
`--tama-origin` are migration assertions in this topology.

Existing HTTP or HTTPS configuration is edited directly. Review public OAuth
identities, allowed origins, certificates, proxy routes, and environment bindings
together. Preserve keys and keep both modes prepared during identity changes.
Run `doctor`, then `setup` to verify current configuration. Bootstrap migration
flags do not update existing projects. Custom domains require operator-managed
DNS; Tama Kit does not edit `/etc/hosts`.

Before a write or runtime use, verify Docker Compose. Before `--start`, also
verify the daemon. Before writing local HTTPS certificates, ensure `mkcert` is
installed and explicitly authorize `mkcert -install` when its local CA is
missing. The write creates ignored `tama/tls/` material and a derived local
Tama image that trusts only the public CA certificate.

Supply each browser/MCP client origin with a repeated `--allowed-origin`; at
least one and at most 32 unique origins are allowed. Loopback client origins
may use HTTP, but every non-loopback allowed origin must use HTTPS. If more
than 32 distinct origins are required, stop and narrow the set before running
bootstrap.
Use a concrete pinned version in the intersection of the bundled range
`>= 0.13.2 and < 0.14.0` and `supported_tama_versions` from the
application-owned provider contract when present, then select the official
server image tag `<version>-server`. The floating `latest` tag is unsuffixed
but is not valid for MCP App preparation. If no provider range is present,
`0.13.2-server` is a valid default. Never assume version `0.13.2` is valid when
the provider contract narrows the range; if the ranges have no known pinned
version in common, stop and report the incompatibility before bootstrap.

Review the JSON plan before initial generation. Repeat without `--dry-run` to
stage prepared configuration when authorized. For existing configuration use
`setup --dry-run --json`, `setup`, or authorized `setup --activate`.

After a successful write, verify that `tama/.tama.env`, the provider fragment,
and `tama/tls/`
are ignored and untracked, that the generated local contract exists, and that
the provider loader consumes the reported fragment. Verify both public names
with `curl --cacert tama/tls/rootCA.pem` after Caddy starts; do not test or
advertise the private upstreams as OAuth origins. If the user explicitly
asks for browser root setup, use the HTTPS base URL from the private environment
and the reported private `/setup/root?token=...` URL without echoing its token.
Never ask the user to paste credentials into chat.
If browser control is available, use the in-app browser for the private setup
URL; otherwise direct the user to `tama/README.md` without reproducing its
token.

## Close authorized readiness gaps

Keep generic OAuth mechanics in an established protocol library when one is
available, while retaining application-owned actors, clients, consent, grants,
tokens, persistence, policy, transactions, and lifecycle state. For an Elixir
application, prefer the compatible `tama_oauth` package for protocol parsing,
JWT/JWKS, metadata, private-key JWT, PKCE, and introspection response mechanics;
do not copy Memovee domain policy into another application.

For a ready provider, verify and reuse these capabilities. For a partial or
absent provider, implement them as one coherent slice only after the user has
authorized the prerequisite work:

- configuration loading and validation for all semantic bindings in the local
  contract;
- lifecycle gates for `disabled`, `prepared`, and `enabled`;
- OAuth authorization-server metadata, public JWKS, authorization, token,
  client registration when supported, revocation, and authenticated
  introspection endpoints;
- authorization-code flow with PKCE S256 and exact OAuth resource binding;
- application-owned consent, actor, grant, authorization-code, access-token,
  refresh-token, revocation, replay, and cleanup policy as required by the
  product;
- RS256 access tokens whose issuer, audience, scope, subject, client,
  grant, identifier, lifetime, and signing key match the contract; and
- non-oracular introspection authenticated by Tama with `private_key_jwt`.

The only supported application scope for this integration is `mcp.message`.
The token audience is the complete Tama resource URI ending in `/mcp/app`, not
the provider origin, Tama origin, `/mcp/system`, or an application API. Derive
the token subject from the authenticated application actor; never accept a
caller-supplied actor identifier as authority.

## Preserve ownership and lifecycle

The application owns access-token signing keys and publishes only public
members through its JWKS. Tama owns its separate introspection-client private
key and publishes the corresponding public key through Tama's JWKS. The
application fetches that key only from the configured Tama JWKS URI and uses it
only to authenticate introspection requests.

Gate before detailed request validation so disabled or prepared endpoints do
not become protocol oracles. `prepared` exists for trust and readiness checks;
it must not enable authorization, client registration, token issuance, resource
advertisement, or access to Tama's `/mcp/app` route. Only `enabled` may issue or
advertise usable access.

Never log bearer tokens, authorization codes, refresh tokens, private JWKs,
client assertions, setup URLs, or raw secrets. Bound request sizes, response
sizes, network deadlines, caches, rotation overlap, and rate limits. Treat
unknown keys, remote JWKS failure, replay-store failure, and persistence races
as closed failures.

## Provision the local bridge

Ensure the provider process really loads the private fragment reported by Tama
Kit. For host execution, use the application-owned environment loader. For a
Compose provider, the selected service must reference the fragment in its own
`env_file`; a host `.envrc` or an unrelated service is not loader evidence.
Keep the fragment ignored and untracked. Run `doctor` to inspect current
loader wiring; setup derives current evidence without updating the contract.

Provision in stages:

1. Run `bootstrap --mcp-app --dry-run --json` with explicit non-interactive
   inputs and review the local contract and both owners' planned files.
2. Run the same command without `--dry-run` to write prepared configuration.
3. Start or restart the provider in `prepared`; verify metadata, public JWKS,
   authenticated inactive-token introspection, and the absence of resource
   advertisement and issuance.
4. With activation authority, run `tama-kit setup --activate`. Follow its provider-mode handoff rather than changing
   application state implicitly.
5. Set the reported provider mode to `enabled`, restart the provider, and rerun
   activation. Accept success only when Tama Kit reports live verification of
   both services and the enabled checkpoint.

Do not rotate keys on an ordinary rerun. Do not delete receipts or private
fragments to bypass a conflict. Edit project-owned configuration directly for
identity changes and preserve signing material. Setup only changes Tama's mode;
provider mode changes and restarts remain application-owned. Recovery restores
only this invocation's Tama mode edit, preserving unrelated concurrent changes.

For continuation, read `setup.nextActions` and each entry's `workingDirectory`.
Setup and doctor inspect current configured modes without resetting them.
`provider-restart-required` and `verification-required` describe configuration;
only `setup.phase=enabled` with live verification confirms enabled services.
Check `setup.runtimeHealth` and `setup.runtimeVerified` separately from files.
`setup.foundation=not-verified` means Terraform provisioning and the active
root recipient still need independent evidence. Follow the generated checklist
for browser/provisioner setup, Terraform plan/apply, and OAuth-client connection.

When startup fails, use the sanitized JSON `error.diagnostic` if present to
identify a port conflict, image, health, or dependency problem. Activation
recovery preserves this diagnostic. Follow the reported recovery instructions,
fix the cause, and review a fresh plan before retrying; do not assume a failed
activation left the provider's live mode synchronized with its fragment.

## Verify before handoff

Test the lifecycle matrix and the complete OAuth flow, including negative and
race cases. Verify exact metadata endpoints, public-only JWKS, PKCE, resource
and scope rejection, JWT claims, private-key JWT authentication and replay,
inactive introspection, actor/grant/token revocation, refresh-family behavior
when supported, and redaction. Run the application's repository checks plus a
Tama Kit dry run.

Report separately:

- application code and persistence implemented;
- provider environment loading verified or unverified;
- Tama Kit configuration generated;
- provider and Tama lifecycle modes;
- live verification passed or still pending; and
- any activation, migration, deployment, or restart still owned by the user.
