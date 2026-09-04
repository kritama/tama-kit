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

## Check Docker before continuing

Before running MCP App bootstrap, starting Compose, guided setup, or
activation, verify the local Docker prerequisites:

```bash
docker --version
docker compose version
docker info --format '{{.ServerVersion}}'
```

The first check confirms the Docker client, the second confirms the Compose
plugin, and the third confirms that the daemon is initialized and reachable.
If any check fails, pause and tell the user to install or start/initialize
Docker first. Do not run bootstrap, Compose, the private setup URL, or
activation until all three checks pass. After the user confirms Docker is
ready, rerun the complete preflight. Never install or start Docker on the
user's behalf.

## Validate Tama Kit bootstrap state first

For any request to set up, adapt, provision, or activate an MCP App, make the
Tama Kit bootstrap state the first repository gate. Do this before assessing or
changing provider OAuth behavior:

1. Read the repository instructions and Git status, then inspect the presence
   and ownership of `tama/.tama-kit.json`, `tama/AGENTS.md`, `tama/README.md`,
   `tama/contracts/mcp-app-provider-v1.json`, `.tama.env*`, and the optional
   application-owned `priv/contracts/tama-mcp-app-bootstrap-v1.json`. Also
   inspect the intended Compose file and `.gitignore` entries for managed and
   private files.
2. Classify the bootstrap state as complete, incomplete, or absent. The
   application-owned contract is not a substitute for Tama Kit's generated
   local projection, and private environment files must be checked only for
   safe presence, ignore status, and loader wiring; never print their values.
3. If bootstrap is absent or incomplete, stop provider implementation work and
   run `tama-kit bootstrap --mcp-app --dry-run --json` with explicit
   non-interactive inputs. Review the plan, then run the same command without
   `--dry-run` when the setup request authorizes the local write.
4. After the write, verify the generated manifest, `tama/` instructions, local
   contract, private environment-file safety, and provider loader boundary
   before proceeding. Stop on managed-file drift, tracked secrets, unsafe
   paths, or conflicting topology.

For a read-only compatibility assessment, perform the same state inspection but
do not write files. Always report missing bootstrap artifacts before reporting
provider readiness.

## Assess provider readiness after the bootstrap gate

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

Never run `bootstrap --mcp-app --activate` until the readiness evidence in the
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
4. If the local contract is absent, run the Tama Kit MCP App bootstrap command
   as a JSON dry run and then an approved write to generate it. Establish the
   provider name, container-reachable provider origin, exact Tama origin,
   allowed client origins, and pinned compatible Tama image first. Use the
   exact command contract below; do not inspect Tama Kit source code.

Do not invent environment names independently of the resolved contract. If the
application uses custom names, express them in an application-owned provider
contract or explicit bootstrap flags, regenerate the local contract, and make
the runtime consume the resulting bindings.

### Tama Kit command contract

Run from the provider application's repository. Use `tama-kit` when installed,
otherwise use `npx @kritama/tama-kit`:

```bash
npx @kritama/tama-kit bootstrap . \
  --mcp-app \
  --provider-name <provider-name> \
  --provider-origin http://host.docker.internal:<provider-port> \
  --tama-origin http://127.0.0.1:<tama-port> \
  --allowed-origin http://127.0.0.1:<client-port> \
  --port <tama-port> \
  --image ghcr.io/upmaru/tama:0.13.1 \
  --skills manual \
  --dry-run --json
```

Replace placeholders with repository evidence. The provider origin is the
public issuer and must be reachable by both host probes and the Tama container;
do not use `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, or `::` for it. The Tama
origin must be HTTP loopback and match `--port`. Supply every browser/MCP
client origin with a repeated `--allowed-origin`; at least one is required.
Use a pinned image in `>= 0.13.1 and < 0.14.0`.

Review the JSON plan before writing. If accepted, repeat the exact command
without `--dry-run` to stage prepared configuration. Add `--start` only when
the user requests that Tama start. `--activate` requires both `--mcp-app` and
`--start`; do not add it during preparation. `--provider-prefix`,
`--provider-env-file`, `--mcp-app-contract`, repeated `--allowed-origin`, and
`--migrate-provider-identity` are the only provider-specific overrides.

After a successful write, verify that `.tama.env` and the provider fragment
are ignored and untracked, that the generated local contract exists, and that
the provider loader consumes the reported fragment. If the user explicitly
asks for guided Tama setup, start the managed Compose runtime if necessary,
wait for its health endpoint, load `.tama.env` without echoing it, and open the
reported private `/setup/root?token=...` URL in the in-app browser. Walk the
user through creating the root user, signing in, and creating provisioner
credentials. If browser control is unavailable, use `tama/README.md` without
reproducing the token. Never ask the user to paste credentials into chat.

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
Kit, using an application-owned `.envrc` source or Compose `env_file` entry.
Keep the fragment ignored and untracked. Rerun `tama-kit bootstrap --mcp-app`
after adding loader evidence so the local contract records verified loading.

Provision in stages:

1. Run `bootstrap --mcp-app --dry-run --json` with explicit non-interactive
   inputs and review the local contract and both owners' planned files.
2. Run the same command without `--dry-run` to write prepared configuration.
3. Start or restart the provider in `prepared`; verify metadata, public JWKS,
   authenticated inactive-token introspection, and the absence of resource
   advertisement and issuance.
4. Only with explicit activation authority, run the same bootstrap with
   `--start --activate`. Follow its provider-mode handoff rather than changing
   application state implicitly.
5. Set the reported provider mode to `enabled`, restart the provider, and rerun
   activation. Accept success only when Tama Kit reports live verification of
   both services and the enabled checkpoint.

Do not rotate keys on an ordinary rerun. Do not delete the manifest or private
fragment to bypass drift. Provider identity changes require an explicit,
prepared-mode migration.

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
