# MCP App provider bootstrap and setup

Tama Kit generates initial configuration for an application OAuth provider and
Tama's `/mcp/app` resource. The application owns OAuth behavior, access-token
keys, environment loading, provider mode and process lifecycle. Tama has a
separate introspection-client key. Configuration files belong to the developer
immediately after generation.

## Initial generation

From a fresh application's root:

```bash
tama-kit bootstrap --mcp-app --provider-name acme --dry-run --json
tama-kit bootstrap --mcp-app --provider-name acme
```

Use a pinned official `<version>-server` image in the intersection of the
bundled `>= 0.13.2 and < 0.14.0` range and the optional provider contract's range.
The default is `0.13.2-server` when the provider does not narrow the range.
Generation may prepare configuration before provider implementation is ready;
it cannot supply actor, consent, issuance, persistence or revocation behavior.

Fresh generation creates the public identities `https://app.localhost` and
`https://tama.app.localhost/mcp/app`. Caddy forwards privately to
`host.docker.internal:<provider-port>` and `tama:4000`. Use `--local-domain`
and `--provider-port` to customize initial generation. Private upstreams are
not OAuth identities. Custom non-`.localhost` names require explicit
`--acknowledge-local-domain-risk` and operator-managed DNS. Local certificates
need mkcert; installation of CA trust is a separate, explicitly authorized host
operation. Tama Kit does not install Docker or start its daemon.

Allowed client origins default to the provider origin in fresh local HTTPS
configuration. Supply up to 32 unique origins using repeated `--allowed-origin`.
HTTP is permitted only for loopback client origins; other origins require HTTPS.

## Current contracts and private bindings

The optional application contract at
`priv/contracts/tama-mcp-app-bootstrap-v1.json` declares compatibility, exact
semantic bindings, public endpoint paths, limits, and supported Tama versions.
It uses schema version 1 and compatibility `tama-mcp-app-bootstrap-v1`.
Tama Kit reads this contract during generation without creating or rewriting it.
Declared bindings must name declared variables whose constraints permit the
planned modes, RS256 signing algorithm, public identities and key material.

Generation writes a non-secret local projection at
`tama/contracts/mcp-app-provider-v1.json`. It describes the provider identity,
nine semantic bindings, public endpoints and local topology. Without an
application contract it uses conventional bindings derived from the provider
name. This local projection is project-owned and can be edited with its runtime
configuration. It is not an attestation of OAuth implementation or live loading.

The provider fragment, Tama private environment and TLS keys must be ignored,
untracked, and private. Never print their values, assertions or setup URLs.
The application owns its signing key; Tama owns the separate introspection key.
Public JWKS expose only public members. Preserve keys during routine setup and
configuration changes; use a deliberate rotation workflow for key replacement.

Setup and doctor resolve current Compose files, effective environment values,
the selected local contract and current loader wiring. They never derive desired
configuration from receipts or require template hashes. Missing receipts do not
block them. Inconsistent identities or unsafe private files require fixing the
actual configuration, not regenerating the scaffold.

## Provider runtime topology

Fresh generation can reference an existing application-owned Compose provider:

```bash
tama-kit bootstrap --mcp-app --provider-name acme \
  --provider-service acme --provider-port 4000
```

The initial generation selector expects a service in the root Compose file and
rejects unsupported profile/extends/include declarations. The application owns
the image, Dockerfile, listener, health check and loader. Caddy forwards privately
to `acme:4000`; the service must load its reported fragment through `env_file`.
A host `.envrc` is not evidence that a Compose service loads the fragment.
Host-native providers use an application-owned environment loader.

After generation, edit project-owned Compose and proxy configuration directly.
Setup and doctor use the native effective Compose model, including includes,
renamed services and ordered overrides. Select custom layouts explicitly:

```bash
tama-kit doctor --compose deploy/compose.yaml --compose deploy/local.yaml \
  --service engine --proxy-service gateway \
  --env-file private/tama.env --contract config/provider.json \
  --provider-service application --ca-file certs/rootCA.pem --json
```

Use the same selection with setup for validation, startup and runtime probes.
Inspection requires Compose support for `config --format json` and
`--no-env-resolution`; it does not require a running daemon. Current setup does
not infer arbitrary application restart commands from configuration.

## Staged activation and recovery

1. Implement the provider's OAuth contract and load its private fragment.
2. Start it in prepared mode. Complete private root-user setup and Terraform
   provisioning separately. Existing files do not prove an active root recipient.
3. Run authorized `tama-kit setup --activate`. It verifies prepared metadata,
   public JWKS, authenticated inactive-token introspection, protected-resource
   behavior, routing and Tama-container reachability.
4. Tama Kit changes only Tama's mode from prepared to enabled and restarts Tama.
   It reports the provider mode-change and restart handoff.
5. Set the provider's reported mode variable to enabled, restart it through the
   application's workflow, and run `tama-kit setup` to verify both live services.

Prepared `/mcp/app` returns 404 intentionally. Only successful live enabled
verification reports the enabled phase. `setup.runtimeHealth`,
`setup.runtimeVerified` and `setup.foundation` distinguish service health,
integration verification and still-unverified Terraform provisioning.
OAuth clients use authorization code with PKCE; provisioner credentials and
Tama's introspection credentials must never be used as client credentials.

Automatic activation requires one unshadowed, safely editable Tama mode
assignment in its loaded environment file. Inline overrides, conflicting files
or ambiguous sources require a manual edit. The provider fragment is never
rewritten. If verification fails after this invocation enables Tama, recovery
restores only its own mode assignment, preserving unrelated edits. A concurrent
mode edit blocks automatic restoration. Verification of already-enabled
configuration never resets either mode. Sanitized startup diagnostics suppress
raw Compose output that could expose secrets.

## Developer ownership and native tools

All generated Terraform, Compose, contracts, instructions and copied skills are
project-owned. Completed bootstrap reruns preserve edited and deleted output.
Bootstrap migration flags no longer change an existing project. Review public
identities, allowed origins, bindings, certificates and routes together when
making a topology change; preserve keys and use prepared modes during migration.

Version-2 receipts record generation provenance and temporary pending paths for
an unfinished operation. Resume only with its explicit `--resume <id>` and the
original generation options. Existing output is preserved. Version-1 manifests
are historical provenance; hashes and saved topology are not a configuration
source. Do not edit a receipt to bypass a generation conflict.

Use `doctor --json` for read-only configuration diagnostics, or `doctor --runtime`
for probes without startup or writes. Doctor reports absent tooling,
uninitialized Terraform providers or invalid Terraform without running init.
Select a different Terraform directory with `--terraform-root`.
Use `setup --dry-run --json` to inspect the selected runtime, adding `--activate`
to preview the Tama mode edit. JSON and non-TTY invocations never prompt.

Native `docker compose -f … up`, `ps`, and `config`, plus `terraform init`,
`fmt -check`, `validate` and `plan`, remain available without Tama Kit or receipts.
Review plans and authorize apply separately. The generated README documents the
initial layout; update its commands when the project changes.
