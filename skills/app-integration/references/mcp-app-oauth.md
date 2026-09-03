# Tama `/mcp/app` OAuth contract

This contract is provider-independent. Adapt it to the target application's
framework and domain model. Repository source and the generated local contract
remain authoritative for exact names and versions.

## Ownership boundary

| Owner | Responsibility |
| --- | --- |
| Application | OAuth authorization server, actor authentication and consent, clients, grants, authorization codes, access and refresh tokens, access-token signing key, public JWKS, authenticated introspection, revocation, persistence, cleanup, and lifecycle policy |
| Tama | Exact protected resource `/mcp/app`, protected-resource metadata, offline access-token validation, authenticated introspection client, introspection signing key, MCP session principal, and `mcp.message` enforcement |
| Tama Kit | Local provider/Tama environment provisioning, key generation for both owners, normalized local contract, loader evidence, managed-file safety, Compose wiring, and staged live verification |
| Protocol library | Reusable OAuth/JWT/JWKS/PKCE/private-key-JWT parsing and cryptographic mechanics; it must not own application actors, grants, consent, persistence, or lifecycle policy |

Never reuse Tama's `/mcp/system` local authorization for this integration. It
has a different issuer, audience, credentials, and trust boundary.

## Provider readiness gate

An application is **ready** only when repository and runtime evidence show all
of the following:

- an OAuth 2.1 authorization server using authorization code with PKCE S256;
- metadata and a public-only JWKS at the fixed probe paths;
- RS256 access tokens bound to the exact Tama `/mcp/app` audience and
  exactly the `mcp.message` scope;
- subjects derived from authenticated application actors;
- application-owned grants, consent, token persistence, revocation, replay
  handling, and atomic mutable-authorization checks;
- `disabled`, `prepared`, and `enabled` behavior matching the lifecycle matrix;
- introspection authenticated by Tama using `private_key_jwt` and Tama's public
  JWKS;
- configuration that consumes the generated semantic bindings without leaking
  either owner's private keys;
- one provider origin that preserves the advertised issuer while remaining
  reachable by host probes and the Tama container; and
- a host-native provider listener bound to a bridge-reachable interface rather
  than loopback only when using the managed host-gateway topology.

Existing OAuth is **partial or incompatible** until every missing item is
identified. OAuth used only to protect the application's own API does not prove
the Tama resource, scope, lifecycle, or introspection contract.

When the application has no OAuth provider, communicate the prerequisite
plainly before proposing activation. Use language equivalent to:

> This application cannot yet act as Tama's MCP App authorization provider.
> Before `/mcp/app` can be provisioned for use, it needs an OAuth 2.1 provider
> integration covering authorization code with PKCE, authorization-server
> metadata, public JWKS, exact `/mcp/app` audience and `mcp.message` tokens,
> lifecycle gates, and Tama-authenticated introspection. Tama Kit provisions
> configuration and trust material; it does not add this application behavior.

Ask whether to implement that prerequisite unless the user already authorized
it. Configuration may be staged in `prepared` only when explicitly requested;
it is not provider readiness and must not be activated.

## Required provider bindings

Read the exact variable names from
`tama/contracts/mcp-app-provider-v1.json.bindings`. The semantic roles are:

- `mode`
- `issuer`
- `resource`
- `access_token_signing_algorithm`
- `access_token_signing_key_id`
- `access_token_private_signing_key`
- `access_token_public_overlap_keys`
- `introspection_client_id`
- `introspection_jwks_uri`

When configured, validate all values at startup. Require an HTTP(S) issuer
origin without a path, an exact resource path of `/mcp/app`, an exact Tama JWKS
path of `/.well-known/jwks.json` on the resource origin, bounded identifiers,
the contract's RS256 signing algorithm, a valid private signing JWK, and a
bounded public-only overlap set. Production defaults to `disabled` when mode is
omitted.

The generated local contract is safe to commit. The provider fragment and
`.tama.env` contain private keys and must remain ignored and untracked.

## Public endpoints

The provider exposes the exact contract paths for:

- authorization-server metadata:
  `/.well-known/oauth-authorization-server`
- public signing keys: `/.well-known/jwks.json`
- token introspection: `/auth/introspections`

Metadata must identify the exact issuer and declare the actual authorization,
token, registration when supported, revocation, introspection, and JWKS
endpoints. It supports `mcp.message`, authorization code with PKCE S256, and
the provider's real client-authentication methods. Advertise the Tama protected
resource only in `enabled` mode.

JWKS contains the current access-token public key plus bounded public overlap
keys needed during rotation. It never contains `d`, `p`, `q`, `dp`, `dq`, `qi`,
or symmetric key material. Serve metadata with `Cache-Control: no-store`; a
short bounded public cache such as `public, max-age=300` is appropriate for
JWKS.

Authorization, token, registration, and revocation paths may follow the
application's established routing, but metadata must report them exactly. The
three bootstrap contract paths above are fixed because Tama Kit probes them.

## Lifecycle matrix

Apply the lifecycle gate before parsing detailed request content.

| Capability | `disabled` | `prepared` | `enabled` |
| --- | --- | --- | --- |
| Metadata | 404 | Available, without protected-resource advertisement | Available, resource advertised |
| JWKS | 404 | Available | Available |
| Introspection | 401 `invalid_client` | Available | Available |
| Authorization | 503 `temporarily_unavailable` | 503 `temporarily_unavailable` | Available |
| Client registration | 503 `temporarily_unavailable` | 503 `temporarily_unavailable` | Available when supported |
| Revocation | 503 `temporarily_unavailable` | Available | Available |
| Token issuance | 400 `invalid_grant` | 400 `invalid_grant` | Available |

Prepared introspection must authenticate Tama and may return an inactive
response for a deliberately invalid token. It must not make authorization or
issuance reachable.

## Authorization and issuance

Bind the complete flow to one exact resource and scope:

- `resource`: the configured absolute Tama URI ending in `/mcp/app`
- `scope`: exactly `mcp.message`

Require authorization code with PKCE S256 for every client, including
confidential clients; client authentication does not replace the code challenge
and verifier. Validate redirect URIs exactly and bind the request, consent,
code, grant, access token, and any refresh family to the same actor, client,
redirect URI, resource, and scope. Consume codes once under a lock or equivalent
atomic operation.

Issue short-lived RS256-signed JWT access tokens with at least:

- `iss`: exact provider issuer
- `aud`: exact Tama `/mcp/app` resource URI
- `sub`: stable authenticated application actor identifier
- `client_id`: authorized OAuth client
- `scope`: `mcp.message`
- `grant_id`: durable grant identifier
- `jti`: unique persisted access-token identifier
- `iat` and `exp`: bounded lifetime

Publish the matching public key under the token's `kid`. Never place provider
API scopes or a generic application audience in this token, and never forward
the incoming bearer token to unrelated provider APIs.

If refresh tokens are supported, store only digests, rotate on every exchange,
enforce both idle and absolute family expiry, revoke the active family on
replay, and bind each exchange to the active actor, grant, client, resource,
and scope.

## Authenticated introspection

Authenticate Tama before looking up the supplied access token so the endpoint
does not become a token oracle. Tama uses `private_key_jwt`; validate:

- the form `client_id` equals the configured introspection client ID;
- assertion `iss` and `sub` equal that same client ID;
- assertion `aud` equals the exact introspection endpoint;
- `iat` and `exp` fit the bounded lifetime and clock-skew policy;
- `jti` is present and atomically claimed against replay until expiry;
- the assertion algorithm and `kid` are allowed; and
- the signature resolves against the configured Tama JWKS URI.

Fetch only the configured JWKS URI, require the expected same-origin and exact
path relationship to the Tama resource, enforce HTTPS outside explicitly
allowed loopback development, and bound redirects, response size, deadlines,
cache lifetime, and unknown-key refresh. Never trust a client-supplied JWKS
location.

After client authentication, malformed, unknown, expired, revoked, or
incorrectly bound access tokens return the standard inactive introspection
document rather than revealing which check failed. An active response must
agree exactly with the verified JWT and persisted reference for issuer,
audience, subject, client, scope, grant, token identifier, and expiry.

Check mutable authorization atomically. Use the application's equivalent of
this lock order to avoid revocation races:

1. lock or consistently read the actor as active;
2. lock the grant;
3. lock/read the access-token reference and family;
4. compare all persisted bindings to the verified claims; and
5. update usage only after every check passes.

Actor deactivation, grant revocation, token revocation or expiry, refresh-family
replay, and authorization-policy withdrawal must make subsequent introspection
inactive.

## Verification matrix

Cover at least:

- every lifecycle response in disabled, prepared, and enabled modes;
- metadata exactness and prepared-mode non-advertisement;
- public-only JWKS, current key matching, overlap limits, and unknown `kid`;
- PKCE downgrade/reuse, redirect mismatch, wrong resource, wrong scope, and
  caller-supplied actor attempts;
- JWT signature, algorithm, issuer, audience, subject, client, scope, grant,
  identifier, and expiry;
- missing, malformed, wrong-client, wrong-audience, expired, replayed, and
  wrongly signed introspection assertions;
- authenticated unknown-token introspection returning inactive;
- actor, grant, token, and refresh-family revocation races;
- request-size, timeout, remote JWKS failure, rate-limit, and redaction paths;
  and
- an end-to-end enabled token reaching Tama `/mcp/app`, plus anonymous and
  wrong-audience rejection.

Generation and static tests prove configuration and code behavior. Only the
Tama Kit activation probes prove the selected local provider and Tama processes
are mutually reachable and ready at that moment.
