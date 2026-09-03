# MCP App provider bootstrap

Tama Kit can prepare a host-native application as the OAuth provider for
Tama's exact `/mcp/app` protected resource. The provider owns its application
configuration, process lifecycle, access-token signing key, and OAuth policy.
Tama owns its resource policy and introspection client key. Tama Kit only plans
and verifies the shared local-development contract.

## Provider contract

A contract-aware provider commits
`priv/contracts/tama-mcp-app-bootstrap-v1.json`. The contract must use schema
version `1` and compatibility identifier `tama-mcp-app-bootstrap-v1`. Tama Kit
validates the lifecycle, every semantic environment binding, public endpoint
paths, local topology, loader declaration, limits, and supported version ranges
before generating secrets or planning files.

Providers without a contract use conventional variables derived from
`--provider-name` and must supply `--provider-origin`. Environment prefixes are
limited to 24 characters and may not use reserved Tama, database, Docker, or
Compose namespaces.

## Exact topology

`--provider-origin` is both the public OAuth issuer and the origin used by Tama
for provider metadata, JWKS, and introspection. It must be reachable from the
host and the Tama container. Loopback provider origins are rejected: every
verification probe runs on the host, so a loopback provider would pass them
while the Tama container can never reach it. If its hostname is
`host.docker.internal`, Tama Kit adds the Compose host-gateway mapping and
keeps it on ordinary reruns.

`--tama-origin` is the exact public Tama origin. It defaults from an accepted
contract or to loopback at the selected Tama port. A fresh run without
`--port` selects the Tama port the accepted contract documents (normally
`4001`), and a selected port that collides with a `host.docker.internal`
provider origin is rejected because both host-native services would share the
same host port. Origins are persisted and compared on reruns. Changing
`localhost` to `127.0.0.1`, changing to `::1`, or changing any accepted origin
is a topology migration, not a normal rerun.

Pass at least one repeatable `--allowed-origin` for the actual browser or MCP
client. Tama Kit never infers client origins from either service origin.

## Private files

Bootstrap manages `.tama.env`, `.tama.postgres.env`, and the provider fragment
such as `.memovee.integration.env` as mode `0600` secret files. Root-anchored
ignore rules are written before the files, and tracked or staged secret files
cause bootstrap to stop. Existing keys and valid public overlap sets are
preserved. A fresh overlap set is `[]`; the current public key is published by
the runtime and must not be duplicated in its rotation set.

Dry-run does not generate keys or write files. Repeated JSON dry-runs with the
same inputs are deterministic and contain no private material.

## Identity migration

A normal rerun refuses provider identity or binding drift. To migrate an
identity, keep the provider in prepared mode, update its loader and committed
contract (when present) to the new derived fragment filename, then pass
`--migrate-provider-identity --provider-name <new-name>`. An optional
`--provider-prefix` selects a different bounded prefix.

Migration preserves the private access-token signing JWK, key identifier,
valid overlap keys, and unrelated provider-owned fragment entries. It renames
the managed bindings, writes the new fragment before removing the old managed
fragment, updates root-anchored ignore rules, and changes the manifest in the
same transaction. Migration and `--activate` cannot be combined; verify the
new prepared identity before activating it.

## Activation and recovery

Run bootstrap with `--start --activate`. Tama Kit first writes and starts both
sides as prepared, then verifies provider metadata, both JWKS documents
(against the exact public keys planned from the persisted private JWKs, so a
stale or misloaded key under the expected identifier fails the probe), and an
authenticated inactive-token introspection. Only after that checkpoint does it
enable and restart Tama and verify protected-resource metadata and `/mcp/app`.

Tama Kit cannot control a host-native provider process. It leaves the provider
prepared and reports the exact provider mode variable to set to `enabled`.
Restart the provider yourself, then rerun the same bootstrap command. The
second run verifies the provider's exact resource advertisement before
reporting the integration activated.

If enabled-state verification fails, Tama Kit restores the prepared files and
restarts Tama in prepared mode while preserving trust material. If the provider
had already consumed enabled configuration, its owner must restart it after
the fragment is restored.
