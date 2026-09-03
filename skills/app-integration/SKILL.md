---
name: app-integration
description: Assess, implement, and provision an application's OAuth 2.1 authorization-server integration for Tama's protected `/mcp/app` endpoint. Use when checking whether an app's existing OAuth is Tama-ready, identifying or closing provider gaps, consuming a Tama Kit MCP App contract, or completing provider-side work after `tama-kit bootstrap --mcp-app`. Do not use for ordinary Tama graph construction or for Tama's provider-independent `/mcp/system` authorization.
---

# Tama MCP App integration

Make the application the OAuth authorization server for one exact protected
resource owned by Tama: `/mcp/app`. Implement the provider-side vertical slice
and use Tama Kit to provision the cross-service local configuration. Do not
implement `/mcp/app` inside the application; Tama owns that endpoint.

Read [the OAuth contract](references/mcp-app-oauth.md) before changing provider
authorization, tokens, introspection, lifecycle, or persistence.

## Assess provider readiness first

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
4. If the local contract is absent, run the current Tama Kit MCP App bootstrap
   as a JSON dry run and then an approved write to generate it. Establish the
   provider name, container-reachable provider origin, exact Tama origin,
   allowed client origins, and pinned compatible Tama image first. Use the
   installed `tama-kit --help` as the flag authority.

Do not invent environment names independently of the resolved contract. If the
application uses custom names, express them in an application-owned provider
contract or explicit bootstrap flags, regenerate the local contract, and make
the runtime consume the resulting bindings.

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
