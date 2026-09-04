# MCP App provider bootstrap

Tama Kit can prepare a host-native application as the OAuth provider for
Tama's exact `/mcp/app` protected resource. The provider owns its application
configuration, process lifecycle, access-token signing key, and OAuth policy.
Tama owns its resource policy and introspection client key. Tama Kit only plans
and verifies the shared local-development contract.

## Local bootstrap contract

Every `bootstrap --mcp-app` run resolves one normalized, non-secret local
contract and manages it at `tama/contracts/mcp-app-provider-v1.json`. The
contract records the accepted provider identity, exact nine semantic variable
bindings, public provider endpoint paths, source provenance, and statically
verified environment-loader evidence. The same in-memory document is validated
before key generation and then drives provider and Tama environment planning.

This file configures the local bridge; it does not certify that the provider
implements OAuth metadata, JWKS, introspection, authorization, or lifecycle
behavior. It never contains private JWKs, tokens, passwords, assertions, or
environment values. Tama Kit writes it in the same managed transaction as the
environment fragments, Compose files, Terraform root, and manifest. An
identical rerun leaves it unchanged, while a user edit or identity/binding drift
stops bootstrap instead of being overwritten.

When no application-owned contract exists, the local contract records
`source.type: "generated"` and uses conventional bindings derived from the
accepted provider prefix. This generated projection is immediately usable for
local file generation and does not require a separate promotion step.

## Application-owned provider contract

A contract-aware provider commits
`priv/contracts/tama-mcp-app-bootstrap-v1.json`. The contract must use schema
version `1` and compatibility identifier `tama-mcp-app-bootstrap-v1`. Tama Kit
validates the lifecycle, every semantic environment binding, public endpoint
paths, local topology, loader declaration, limits, and supported version ranges
before generating secrets or planning files.

The application-owned contract remains optional and authoritative only for
the provider declarations it contains. Tama Kit reads it but never creates or
rewrites it. A matching contract added after a conventional bootstrap changes
the local contract provenance to `provider-contract` without renaming bindings
or rotating keys. A mismatching identity or binding remains drift and requires
an explicit migration.

Every contract that declares a provider identity is cross-checked against its
declared `variables`: each role is bound either by the contract's `bindings`
map or, when that map is omitted, by the conventional names derived from the
declared environment prefix. Every variable a role resolves to must be
declared, and a declared constraint must be satisfiable by the values the
planner writes — the lifecycle mode variable must accept both `prepared` and
`enabled`, and the signing-algorithm variable must accept the hard-coded
`RS256`. This runs before secrets are generated, so a binding to an undeclared
variable or an unsatisfiable constraint fails the contract instead of silently
writing over the provider's configuration. The planned values themselves are
held to the remaining declared constraints before any file is written —
`format`, `exact_path`, `same_origin_as`, `max_bytes`, and `max_items` — so a
resource variable declared with `exact_path: "/different"` or an issuer with
`max_bytes: 1` is rejected rather than violated once the planner's origins and
paths are known.

Providers without a contract use conventional variables derived from
`--provider-name` and must supply `--provider-origin`. Environment prefixes are
limited to 24 characters and may not use reserved Tama, database, Docker, or
Compose namespaces. A contract's `provider.environment_file` must be inside
`tama/` and must not collide with bootstrap-managed files such as
`tama/.tama.env`, `tama/.tama.postgres.env`, `tama/.gitignore`, Compose,
contracts, or Terraform files, because the fragment write would overwrite that
content.

## Exact topology

For the generated local HTTPS profile, Caddy publishes the provider at
`https://app.localhost` and forwards to the provider's selected host-native
port. The application owns that development listener and its external URL
configuration; Tama Kit only supplies the semantic OAuth bindings and does
not generate provider-specific proxy, bind-address, or upstream-port flags.

`--provider-origin` is both the public OAuth issuer and the origin used by Tama
for provider metadata, JWKS, and introspection. It must be reachable from the
host and the Tama container. Any loopback provider origin is rejected —
`localhost`, the full `127.0.0.0/8` range, `::1`, and IPv4-mapped loopback
forms — because those names resolve inside the Tama container rather than to
the host-native provider. Unspecified addresses
(`0.0.0.0`, `::`) are rejected for the same reason: the host can reach a
locally bound provider through those names, but from inside the container they
name the container's own interface. An `https://host.docker.internal` origin is
also rejected because the gateway name resolves only inside the container, so
host-side TLS probes could not validate the certificate for that name; use
`http://host.docker.internal:<port>` for the container-gateway topology. If its
hostname is `host.docker.internal`, Tama Kit adds the Compose host-gateway
mapping and keeps it on ordinary reruns. On Linux hosts the verification also
inspects the host's listening sockets for the effective provider port (80 or
443 when the origin names none): a provider bound to loopback only — including
IPv4-mapped binds such as `::ffff:127.0.0.1` — passes every host-side probe
yet is unreachable from the Tama container through the gateway, so
verification fails with a `provider_host_listener` probe until the
provider binds `0.0.0.0` or the Docker bridge interface. Provider metadata,
JWKS, and introspection probes use the exact host-gateway address installed in
the running Tama container rather than assuming loopback, so a provider bound
only to the Docker bridge can still pass verification. Independently of the
host bind diagnostic, Tama Kit also requests the provider metadata endpoint
from inside the running Tama container. The required
`provider_container_reachability` probe therefore covers container DNS,
network-namespace routing, and host firewall policy rather than inferring
reachability from host state.

`--tama-origin` is the exact public Tama origin. It defaults from an accepted
contract or to loopback at the selected Tama port. A fresh run without
`--port` selects the Tama port the accepted contract documents (normally
`4001`), and a selected port that collides with a `host.docker.internal`
provider origin is rejected because both host-native services would share the
same host port. Origins are persisted and compared on reruns. A
`bootstrap --mcp-app --port <new-port>` rerun updates the Tama origin, resource,
introspection client id, and both owner-specific environment files atomically
without renaming bindings or rotating keys. Changing `localhost` to
`127.0.0.1`, changing to `::1`, or changing the public scheme or host remains
an explicit topology migration. An ordinary bootstrap without `--mcp-app`
still rejects a Tama port change because it cannot safely update the provider
fragment as part of that plan.

Pass at least one repeatable `--allowed-origin` for the actual browser or MCP
client. Tama Kit never infers client origins from either service origin.

## Tama image

The MCP App integration writes trust material before the runtime starts, so
`--mcp-app` requires a Tama image pinned to a stable release inside the bundled
contract's supported range. Floating tags such as `latest` are rejected: they
can move outside the range after secrets are written, leaving a runtime Tama
Kit cannot hold to the contract. Prerelease and build tags are rejected as
well: SemVer orders a prerelease below the stable version it decorates, and the
range grammar cannot express prerelease bounds, so such a tag cannot be held to
the range. While an integration is persisted, ordinary reruns without
`--mcp-app` must pass the same pinned, supported `--image`: the floating
default tag would otherwise silently replace the pinned runtime. Ordinary
reruns also keep the managed MCP App example in `tama/.tama.env.example` and the
README section in sync with the persisted integration, so the public
documentation is not dropped by a rerun.

## Private files

Bootstrap manages `tama/.tama.env`, `tama/.tama.postgres.env`, and the provider
fragment such as `tama/.memovee.integration.env` as mode `0600` secret files.
Exact rules in `tama/.gitignore` are written before the files, and tracked or
staged secret files cause bootstrap to stop — including a persisted provider fragment on an
ordinary rerun, because the fragment holds the provider's private signing key.
Existing keys and valid public overlap sets are
preserved. A fresh overlap set is `[]`; the current public key is published by
the runtime and must not be duplicated in its rotation set. Persisted overlap
members are republished by the runtime as trusted `RS256` material, so each
must be an RSA public key at least 2048 bits with a sane public exponent and
no cheaply detectable small factor — the same strength the private signing
key is held to — or the re-bootstrap fails. Key identifiers use the portable
dotenv-safe alphabet documented by `tama-kit oauth generate-key`.

Dry-run does not generate keys or write files. It still renders and validates
the local contract in memory, reports its planned operation in the
`providerContract` result block, and uses it for the rest of the plan. Repeated
JSON dry-runs with the same inputs are deterministic and contain no private
material.

An `environment_loading` declaration in an application-owned contract is not
loader evidence by itself. Tama Kit reports loading as verified only when an
exact active `.envrc` `dotenv`/`dotenv_load` directive or a Compose service
`env_file` entry consumes the provider fragment. Otherwise bootstrap can
prepare the files, but reports the integration as not yet runnable until the
application owner wires the loader.

## Identity migration

A normal rerun refuses provider identity or binding drift. To migrate an
identity, keep the provider in prepared mode, update its loader and committed
contract (when present) to the new derived fragment filename, then pass
`--migrate-provider-identity --provider-name <new-name>`. An optional
`--provider-prefix` selects a different bounded prefix, and
`--provider-env-file` selects a different fragment path (both require
`--provider-name` and `--mcp-app`).

Migration preserves the private access-token signing JWK, key identifier,
valid overlap keys, and unrelated provider-owned fragment entries. It renames
the managed bindings, writes the new fragment before removing the old managed
fragment, updates exact rules in `tama/.gitignore`, and changes the manifest in the
same transaction. Migration and `--activate` cannot be combined; verify the
new prepared identity before activating it.

## Activation and recovery

Run bootstrap with `--start --activate`. Tama Kit first writes and starts both
sides as prepared, then verifies provider metadata, both JWKS documents, the
inactive-token introspection — first proving the provider rejects a
structurally valid client assertion signed by an unrelated key (negative
control), then requiring the authenticated request to answer exactly as an
inactive token must — plus a provider-metadata request issued inside the
running Tama container. Every probe is read-only. On Linux, host-side provider
probes use the exact gateway address installed in the container while the
container probe uses the configured origin itself; the advertised issuer and
JWKS URI remain bound to the exact planned origin. Each JWKS must publish an
RSA signing member (compatible `RS256`
metadata, no private members) whose modulus and exponent match the persisted
private JWK, so a stale or misloaded key under the expected identifier fails
the probe. The prepared checkpoint also requires provider metadata not to
advertise a protected resource; this catches a provider process that has not
been restarted after an enabled-state rollback. Only after that checkpoint
does it enable and restart Tama and
verify protected-resource metadata and `/mcp/app`; the protected route must
reject the deliberately anonymous probe with `401` or `403`, so a publicly
accessible `/mcp/app` fails verification.

Tama Kit cannot control a host-native provider process. It leaves the provider
prepared and reports the exact provider mode variable to set to `enabled`.
Restart the provider yourself, then rerun the same bootstrap command. The
second run verifies the provider's exact resource advertisement before
reporting the integration activated.

If enabled-state verification fails, Tama Kit restores the prepared files and
restarts Tama in prepared mode while preserving trust material. If the provider
had already consumed enabled configuration, its owner must restart it after
the fragment is restored.
