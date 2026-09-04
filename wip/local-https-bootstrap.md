# Local HTTPS Bootstrap

Status: proposed on `feature/local-https-bootstrap`

## Summary

Extend `tama-kit bootstrap --mcp-app` with a production-compatible local HTTPS
topology. Tama Kit should generate a Caddy reverse-proxy service, create a
locally trusted certificate with mkcert, and use exact HTTPS origins that are
reachable by browser clients, the host-native provider, and the containerized
Tama runtime.

The supported Memovee topology is intentionally mixed-environment: the
official Tama release container runs with `MIX_ENV=prod`, while the
host-native Memovee application runs with `MIX_ENV=dev`. Planning, generated
environment, health checks, and the release gate must preserve that split
rather than assuming both services use the same Phoenix environment.

This closes a runtime gap released in Tama Kit 0.4.3. That release can generate
a syntactically valid MCP App configuration that the official Tama server image
cannot start: the image runs with the production environment, while the
generated resource and authorization-server endpoints use local HTTP.

## Proven failure

The Memovee bootstrap produced this topology:

```text
provider origin:  http://host.docker.internal:4000
Tama resource:    http://127.0.0.1:4001/mcp/app
Tama image:       ghcr.io/upmaru/tama:0.13.1-server
```

The generated Compose mapping was correct (`4001:4000`), but Tama never kept
the host port open because the container entered a restart loop. Tama 0.13.1
reported:

```text
invalid Tama MCP app configuration: resource
```

The official server image runs in `prod`. Tama 0.13.1 permits HTTP MCP App
endpoints only for loopback hosts in `dev` and `test`; production configuration
requires HTTPS. Even an explicit production opt-in for loopback would not make
the current provider origin valid because `host.docker.internal` is a Docker
transport address, not a loopback OAuth issuer.

The failure is therefore a topology incompatibility, not a port mapping,
PostgreSQL, image-tag, or generated-file-layout problem.

## Goal

A fresh MCP App bootstrap should produce one exact public origin per service:

```text
https://app.localhost                 provider OAuth issuer
https://tama.app.localhost            Tama public origin
https://tama.app.localhost/mcp/app    protected resource
```

The default uses names below `.localhost`, whose address queries are defined
to resolve to the host loopback interface. This avoids public-domain
collisions and normally avoids host-file or local-DNS changes. The exact names
remain configurable for advanced setups, but public suffixes such as `.dev`
and `.build` require operator-managed DNS and can collide with registered
domains. Do not use `.local`; it is reserved for multicast DNS and is not a
reliable host-to-container application namespace.

Both the host and containers must use the same public origins. Docker routing
must not leak into OAuth identifiers.

```text
Browser / host client
        |
        | HTTPS app.localhost or tama.app.localhost
        v
   Caddy container
      |        |
      | HTTP   | HTTP
      v        v
host provider  Tama container
   :4000          :4000
```

When Tama calls provider JWKS or introspection endpoints, `app.localhost`
resolves to Caddy through an explicit Compose network alias. Caddy then reaches
the host-native provider through `host.docker.internal:4000`. The public issuer
remains `https://app.localhost`; the transport-only host-gateway address is
never written into metadata, token claims, or public contracts.

Runtime environment matrix:

| Service | Runtime | Public TLS | Private listener |
| --- | --- | --- | --- |
| Memovee | host-native `MIX_ENV=dev` | Caddy at `https://app.localhost` | Phoenix HTTP on an explicitly Caddy-reachable development bind and port |
| Tama | official release image, `MIX_ENV=prod` | Caddy at `https://tama.app.localhost` | Bandit HTTP on `tama:4000` inside Compose |
| Caddy | generated Compose service | mkcert leaf certificate | Proxies to the two private HTTP upstreams |

## Decisions

1. Use Caddy as the generated local reverse proxy and TLS termination layer.
2. Use mkcert as the local CA and leaf-certificate generator. Do not generate
   an untrusted one-off self-signed leaf certificate.
3. Keep the provider host-native and Tama containerized. This feature does not
   require containerizing the provider application.
4. Give the provider and Tama distinct HTTPS hostnames under one configurable
   local base name.
5. Use the same public origins from the host and from containers. Docker-only
   transport names are upstream details, not OAuth identities.
6. Keep Caddy-to-provider and Caddy-to-Tama upstream traffic on the local host
   or Compose network. TLS is required at the public boundary; internal proxy
   hops may remain HTTP.
7. Install the mkcert root certificate into the Tama container trust store so
   provider JWKS and introspection requests succeed through HTTPS.
8. Preserve existing Tama and provider key material during an ordinary 0.4.3
   topology upgrade. Changing domains must not rotate OAuth or introspection
   keys implicitly.
9. Require explicit authority before modifying a host trust store. The default
   `.localhost` topology does not require a hosts-file edit. Bootstrap may
   generate and validate the required artifacts, but it must not silently
   invoke privilege escalation.
10. Keep standard non-MCP bootstrap unchanged unless local HTTPS is explicitly
    requested. MCP App bootstrap must use a topology accepted by the selected
    production Tama image.
11. Do not weaken Tama's production URL policy as part of this feature.
12. Add an MCP App runtime gate. The existing generic runtime gate does not
    exercise `prepared` configuration and therefore did not catch this issue.
13. Update the bundled agent skills, generated repository instructions, and
    post-bootstrap handoff together with the CLI. No supported guidance may
    continue recommending the incompatible local HTTP topology.
14. Treat the runtime environments independently. Do not require Memovee to
    run a production release merely because Tama correctly runs in production,
    and do not validate Tama with a development process that permits loopback
    HTTP.

## Bootstrap and code simplification

Adding Caddy, certificate generation, and container trust introduces new
infrastructure code, so this release is not expected to reduce total lines of
code immediately. It should still reduce conceptual complexity: the common
MCP App path gets one canonical topology instead of asking callers to assemble
public OAuth identities from Docker transport addresses and host ports.

Resolve one immutable local HTTPS topology early in planning and pass it to
environment, Compose, contract, verification, documentation, JSON, and prompt
renderers. It should own at least:

```text
provider public origin          https://app.localhost
Tama canonical host             PHX_HOST=tama.app.localhost
Tama public origin              https://tama.app.localhost
protected resource              https://tama.app.localhost/mcp/app
allowed client origins          https://app.localhost by default
provider private upstream       http://host.docker.internal:<provider-port>
Tama private upstream           http://tama:4000
public health URL               https://tama.app.localhost/
certificate names               app.localhost, tama.app.localhost
```

Public origins and private upstreams must have different fields and types.
`host.docker.internal` must never satisfy a public-origin input merely because
it is container-reachable. The manifest and local contract persist public
identity and non-secret topology metadata; Caddy configuration owns private
routing.

The normal interactive command should be able to use the defaults:

```bash
tama-kit bootstrap . --mcp-app --provider-name memovee --start
```

The provider name may still be confirmed interactively when safely detected.
Default the allowed client origin to the provider public origin; retain
repeated `--allowed-origin` only for additional real clients. Use focused
advanced inputs such as `--local-domain` and `--provider-port` instead of
requiring callers to provide `--provider-origin`,
`--tama-origin`, and a matching Tama host port for the standard local case.
Existing explicit origin flags may remain for deliberate custom topology and
the 0.4.3 migration, but they must not drive Caddy's private upstream routing.

For this first implementation, keep the public HTTPS port fixed at 443 so
Tama's production `PHX_HOST` is sufficient to derive its complete public
origin. A later custom HTTPS-port feature would require a separate canonical
public-origin input; it must not reintroduce several independently editable
Tama URLs.

For MCP App mode, Caddy reaches Tama through the Compose network, so Tama does
not need a published host port. Keep `--port` and direct HTTP access for the
standard non-MCP bootstrap profile; do not make Caddy and mkcert prerequisites
for users who only need that simpler runtime. Model the two profiles explicitly
and have shared output code consume a planned public health URL rather than
constructing `http://localhost:<port>`.

Once the 0.4.3 topology is detected and explicitly migrated, remove these from
the normal MCP App path rather than preserving them alongside the new design:

- accepting `host.docker.internal` as the advertised provider issuer;
- rejecting loopback provider origins and then suggesting a Docker hostname as
  the public replacement;
- host-side HTTP requests that connect to a resolved Docker gateway while
  rewriting the `Host` header;
- Linux-specific provider-listener inspection used only to explain the old
  host-gateway topology;
- rewriting the public Tama origin when the published host port changes;
- deciding whether Tama needs `extra_hosts` by scanning current and persisted
  public origins; and
- hard-coded direct-port health URLs in startup, README, human output, and the
  copy/paste agent prompt.

The Caddy service alone receives the host-gateway mapping for its private
provider upstream. Tama reaches both public names through Caddy's Compose
aliases. Verification can therefore use the exact HTTPS URLs from both the host
and Tama container without a special host-mapped fetch transport.

Do not collapse security boundaries in the name of cleanup. Provider contract
validation, lifecycle transitions, transactional secret writes, trust-store
approval, activation rollback, and live provider/Tama verification remain
separate responsibilities.

## Domain and DNS model

The command resolves one stable domain value from which it derives both hosts.
It defaults to `app.localhost`; `--local-domain` is needed only for a deliberate
custom name. The exact advanced flag names will be finalized during
implementation; a customized invocation has this shape:

```bash
tama-kit bootstrap . \
  --mcp-app \
  --provider-name memovee \
  --local-domain memovee.localhost \
  --provider-port 4000 \
  --image ghcr.io/upmaru/tama:0.13.1-server \
  --start
```

Default derived values:

```text
provider origin                  https://app.localhost
Tama origin                      https://tama.app.localhost
Tama MCP App resource            https://tama.app.localhost/mcp/app
Tama introspection client ID     https://tama.app.localhost/mcp/app/introspection
provider JWKS                    https://app.localhost/.well-known/jwks.json
provider introspection           https://app.localhost/auth/introspections
Tama JWKS                        https://tama.app.localhost/.well-known/jwks.json
```

Render `PHX_HOST=tama.app.localhost` once, then derive every Tama-owned public
value from `https://${PHX_HOST}`: endpoint origin, `/mcp/app` resource,
introspection client ID, public JWKS URL, protected-resource metadata, health,
setup, and Caddy host. Do not independently persist or prompt for those values.
If a retained 0.4.3 input or contract field supplies one, treat it as a
migration assertion and reject it when it differs from the derived value.

Provider-owned values remain separate: `https://app.localhost`, its JWKS and
introspection endpoints, and the allowed browser/MCP client origins cannot be
derived from Tama's `PHX_HOST`. Tama Kit writes the Tama-derived resource,
introspection client ID, and Tama JWKS URL into the provider fragment so
Memovee does not need to know or load the `PHX_HOST` variable itself.

The existing explicit `--provider-origin`, `--tama-origin`, and repeated
`--allowed-origin` inputs remain available for migration or deliberate custom
topology. A supplied Tama origin is an assertion against the origin derived
from `PHX_HOST`, not a second independently authoritative value.

Preflight must prove that both default names resolve to IPv4 or IPv6 loopback
on the host. If the host resolver does not honor subdomains of `.localhost`,
fail with structured remediation rather than silently editing `/etc/hosts`.

The Caddy service receives Compose network aliases for the same names so Tama
resolves `app.localhost` to Caddy rather than to its own loopback interface.
Before writing, fail on domain collisions, invalid DNS names, unsupported IP
literals, duplicate hostnames, or a selected domain that resolves somewhere
outside the intended local topology. A custom non-`.localhost` domain requires
operator-managed host DNS or hosts-file entries and explicit acknowledgement
of public-name collision risk.

A feasibility probe against `ghcr.io/upmaru/tama:0.13.1-server` confirmed both
sides of the resolver behavior: without a Docker alias, `app.localhost`
resolved to container loopback; from a second container on an isolated Docker
network, the same name resolved to the peer container carrying the
`app.localhost` network alias. The production runtime gate must retain this
cross-container assertion so an image or Docker resolver change cannot silently
route Tama back to itself.

Do not automatically edit `/etc/hosts` or manage a machine-wide wildcard DNS
resolver in this release.

## Certificate and trust model

Preflight must establish:

- mkcert is installed and executable;
- its local CA exists or the user explicitly authorizes `mkcert -install`;
- the requested provider and Tama names are present in the leaf certificate;
- generated private-key destinations are new, ignored, untracked,
  non-symlink paths with owner-only permissions;
- Caddy can read the mounted certificate without broadening host permissions;
  and
- the Tama container trusts the mkcert root certificate.

Suggested generated layout:

```text
tama/
├── Caddyfile                         # managed and safe to commit
├── compose.yaml                     # includes Caddy and Tama services
├── tls/
│   ├── local.pem                    # local leaf certificate; ignored
│   ├── local-key.pem                # private leaf key; ignored, mode 0600
│   └── rootCA.pem                   # public local CA certificate; ignored
└── ...existing Tama files
```

Do not copy mkcert's root CA private key into the repository or any container.
Only the public root certificate may be mounted or copied into a derived local
Tama image. Leaf private keys must never appear in JSON output, logs, generated
documentation, diagnostic commands, or agent prompts.

The implementation must determine and test the supported trust mechanism for
the pinned Tama server image. Prefer a small generated local image layer that
installs the public CA with the image's native CA update mechanism. Do not
assume that mounting a PEM file or setting a generic environment variable makes
Erlang/OTP, Req, and Finch trust it.

Caddy's internal CA is not the default design. It still requires explicit host
and container trust distribution, while mkcert gives Tama Kit a known local CA
workflow. Supporting `tls internal` may be considered later as a separate
backend.

## Caddy behavior

Generate a minimal managed Caddy configuration with two exact hosts:

```caddyfile
app.localhost {
  tls /etc/tama-kit/tls/local.pem /etc/tama-kit/tls/local-key.pem
  reverse_proxy host.docker.internal:4000
}

tama.app.localhost {
  tls /etc/tama-kit/tls/local.pem /etc/tama-kit/tls/local-key.pem
  reverse_proxy tama:4000
}
```

The actual template must also:

- preserve the incoming `Host` and HTTPS forwarding information expected by
  the provider and Tama;
- reject unintended hostnames rather than serving a catch-all route;
- avoid an admin interface exposed on the host;
- use a pinned supported Caddy image rather than an unconstrained tag;
- mount certificate material read-only;
- bind published proxy ports only to local interfaces unless the user
  explicitly chooses broader exposure;
- include bounded health checks; and
- avoid logging authorization headers, cookies, query strings containing setup
  tokens, or request bodies.

Check the selected host HTTPS port before startup. Publish only port 443 by
default; port 80 and HTTP-to-HTTPS redirects are not required for this local
topology. Do not stop, replace, or reconfigure an unrelated local proxy that
already owns the selected port. Defer configurable public HTTPS ports; the
canonical Tama origin in this release is `https://${PHX_HOST}` on port 443.

## Provider requirements

The provider must advertise and issue tokens from the exact external issuer,
for example `https://app.localhost`, while continuing to listen on its existing
host port for Caddy's upstream connection.

For the Memovee integration, the provider command remains `MIX_ENV=dev` (or
the normal development command whose effective environment is `dev`). Tama Kit
must not set or imply `MIX_ENV=prod`, require release-only database and secret
inputs, or depend on Memovee's production-only endpoint configuration.
Memovee's generated MCP App variables are loaded by `config/runtime.exs` in
development, but its Caddy-reachable bind, external HTTPS URL, WebSocket
origin, and trusted-proxy behavior require an explicit development-only proxy
mode owned by Memovee.

Caddy terminates TLS. Memovee continues serving private HTTP and must not be
configured with the leaf key. The development proxy mode must preserve the
ordinary loopback-only `MIX_ENV=dev` behavior when Tama Kit is not active and
must not copy the entire production endpoint profile into development.

Provider loader verification must prove that the application loads the managed
fragment containing the HTTPS issuer and resource. Framework-specific proxy
settings remain application-owned. Tama Kit may report required trusted-proxy
or external-URL configuration, but must not edit arbitrary application source.

The provider must never derive its OAuth issuer from an untrusted incoming
`Host` or `X-Forwarded-*` header. The generated issuer remains explicit.

## Generated files and ownership

Continue to keep Tama assets below `tama/`:

- `tama/Caddyfile` and any generated local-image Dockerfile are non-secret,
  managed files;
- `tama/tls/` is machine-local and ignored;
- `tama/.tama.env` retains Tama-owned secrets;
- `tama/.<provider>.integration.env` retains provider-owned secrets; and
- `tama/contracts/mcp-app-provider-v1.json` records only non-secret public
  topology and loader evidence.

Extend `tama/.tama-kit.json` with enough non-secret state to make reruns
deterministic: selected domains, HTTPS port, certificate SAN set, proxy image,
and trust mechanism. Do not store certificate private keys, CA private keys,
passwords, tokens, or private JWK members in the manifest.

All managed writes remain transactional and drift-aware. A failure after
certificate creation must clean up only files created by that transaction and
must never delete an unrelated replacement.

## Existing 0.4.3 projects

Tama Kit 0.4.3 has been published, so this feature requires an explicit safe
upgrade path rather than pretending the HTTP topology never existed.

For a manifest that records the 0.4.3 HTTP MCP App topology:

1. Detect and report the incompatible public origins before attempting to
   start Tama.
2. Plan the HTTPS domains, Caddy files, certificate files, trust installation,
   Compose changes, provider fragment changes, Tama environment changes, local
   contract changes, and generated documentation as one reviewable operation.
3. Preserve valid OAuth signing keys, overlap sets, Tama introspection keys,
   setup credentials, database credentials, and unrelated environment entries.
4. Treat the domain change as an explicit public-identity migration. Do not
   silently change an issuer or resource during an ordinary rerun.
5. Require the provider loader and external URL configuration to be ready
   before marking the migration prepared.
6. Recreate affected containers after the environment and trust changes; a
   process restart alone does not reload Compose `env_file` values.

Projects without MCP App configuration do not need migration.

## Secret-safe diagnostics

Diagnostics must use allowlisted fields. Never print all of
`docker inspect .Config.Env`, dump dotenv files, or include complete container
configuration in errors. Safe diagnostics include service state, exit code,
health status, published ports, image reference, and selected non-secret mode
or origin variables.

Redact generated values from bounded Compose logs before returning them. Test
redaction against setup tokens, database passwords, signing keys, private JWKs,
TLS private keys, client credentials, and values embedded inside longer log
lines.

## CLI behavior

Dry-run JSON remains deterministic and secret-free. It may report:

- requested and resolved public hostnames;
- HTTPS and upstream ports;
- whether mkcert, host trust, host resolution, container trust, and Docker are
  ready;
- planned managed and private paths;
- whether privileged host actions still require operator approval; and
- whether the result is configuration-only, prepared, or live-verified.

A dry run must not install a CA, edit the hosts file, generate reusable private
keys, start Caddy, or start Tama.

A write may generate repository-local certificates after prerequisites and
permissions are accepted. Host trust-store or hosts-file mutation requires a
separate explicit confirmation immediately before the privileged action. JSON
and non-interactive runs fail with structured prerequisites rather than
prompting or invoking `sudo`.

`--start` starts the generated Caddy, Tama, and Tama PostgreSQL services only
after host resolution and trust checks pass. `--activate` retains its existing
authority boundary and cannot bypass HTTPS or readiness failures.

## Skills and post-bootstrap handoff

Update the bundled `tama-kit-cli` and `app-integration` skills, their CLI and
OAuth references, and the generated `tama/AGENTS.md` and `tama/README.md` so
agents and operators use the same HTTPS topology as the command. Review
`graph-builder` and `graph-audit`; change them only where their instructions or
examples refer to runtime origins. With `--skills local`, an ordinary managed
rerun must refresh installed copies under `.agents/skills/` without requiring
manual deletion and while retaining the existing drift and symlink checks.

The human success output and copy/paste agent prompt must be generated from the
resolved plan rather than containing fixed localhost ports. They must state:

- the public provider, Tama, and MCP App URLs;
- that Caddy is the public entry point and direct container ports are upstream
  details, not OAuth identities;
- whether mkcert is installed, the local CA is trusted, both hostnames resolve,
  Caddy is healthy, and Tama passed its lifecycle-specific readiness gate;
- the exact Compose start, status, and safe HTTPS verification commands;
- any remaining provider-owned external-URL, trusted-proxy, loader, restart,
  preparation, or activation step; and
- where to read `tama/README.md`, `tama/AGENTS.md`, and the installed skills.

Do not tell the user to open the old `http://localhost:<port>` Tama URL after
an MCP App bootstrap. Do not report configuration generation as a successful
runtime start. Human output may retain the existing private guided-setup
handoff only when requested; JSON, non-interactive output, logs, and the agent
prompt must not disclose setup tokens, credentials, certificate private keys,
or private JWK material.

Test human output, JSON output, and the agent prompt separately for dry-run,
write-only, started/prepared, activation-required, enabled, and prerequisite-
failure states. Tests must reject stale HTTP URLs and ensure every printed
command uses the selected Compose path and resolved HTTPS names.

## Verification

Static verification must cover:

- domain parsing, normalization, derivation, collision handling, and manifest
  persistence;
- exact HTTPS issuer, resource, JWKS, introspection, client-ID, and allowed
  origin rendering;
- Caddyfile and Compose rendering with safe quoting;
- network aliases and host-gateway upstream wiring;
- mkcert discovery, SAN inspection, renewal/reuse, failure behavior, and
  command-argument safety;
- TLS private-file permissions, ignores, tracked-file refusal, symlink and
  ancestor replacement races, and rollback identity checks;
- CA public-certificate installation without copying the CA private key;
- 0.4.3 HTTP-topology migration with all application secrets preserved;
- managed-file drift and conflicting existing proxy services;
- dry-run determinism and absence of secret material; and
- allowlisted, redacted failure diagnostics.

The runtime gate must use the official pinned Tama server image and a minimal
provider fixture. In addition, the cross-repository release gate must use a
real Memovee checkout running with `MIX_ENV=dev`; neither gate may substitute a
development Tama process or a production Memovee release. Together they must
prove:

1. Caddy serves a certificate valid for both public names.
2. The host trusts both HTTPS endpoints.
3. Tama in `prepared` mode starts successfully under the production release
   environment.
4. The provider remains in development, loads the generated fragment before
   `mix phx.server` starts, and is reachable by Caddy without exposing a second
   public OAuth identity.
5. Tama reaches the provider's HTTPS metadata, JWKS, and authenticated
   introspection endpoints through Caddy.
6. Prepared mode publishes Tama's public key but does not advertise or expose
   `/mcp/app`.
7. Enabled verification succeeds only after the provider is enabled.
8. The protected resource rejects anonymous and wrong-audience requests.
9. No private key, token, assertion, password, setup URL, or client secret is
   emitted by bootstrap or diagnostics.

This new MCP App runtime gate is required in CI and in the npm publishing
workflow. A generic standard-bootstrap runtime test is not sufficient.

## Non-goals

- Public production certificate issuance or ACME automation.
- Managing public DNS, wildcard DNS daemons, Kubernetes ingress, or cloud load
  balancers.
- Turning Caddy into a general-purpose proxy for unrelated application routes.
- Editing `/etc/hosts`, installing system packages, or silently invoking
  privilege escalation.
- Weakening Tama's production HTTPS validation.
- Combining provider and Tama credentials.
- Rotating existing OAuth/JWK or application secrets merely because the local
  domain changes.
- Supporting multiple TLS backends in the first implementation.

## Implementation outline

### Phase 1: Model the topology

1. Add explicit bootstrap profiles and one immutable local-domain/HTTPS
   topology type.
2. Separate public provider and Tama identities from Caddy's private upstream
   addresses.
3. Render one Tama `PHX_HOST`, derive every Tama-owned public URL from
   `https://${PHX_HOST}`, and derive the separate provider URLs and default
   allowed origin from the provider hostname.
4. Make the common MCP App command default-driven while keeping explicit
   custom origins isolated from private routing.
5. Persist only non-secret topology state in the manifest and local contract.

### Phase 2: Certificates and host prerequisites

1. Add mkcert discovery and version/capability checks.
2. Plan certificate SANs and private paths without creating them during dry
   run.
3. Generate leaf material safely and copy only the public root CA certificate.
4. Detect host trust and hostname resolution; produce explicit remediation or
   an approved privileged step.

### Phase 3: Caddy and container trust

1. Add managed Caddyfile and Compose templates.
2. Add exact Compose network aliases and host-gateway upstream routing.
3. Install the public local CA into a derived Tama runtime layer using a method
   verified against the selected image.
4. Add health and readiness checks for Caddy and Tama HTTPS endpoints.

### Phase 4: MCP App integration and migration

1. Render all Tama and provider variables from HTTPS public origins.
2. Add an explicit 0.4.3 HTTP-to-HTTPS topology migration that preserves
   secrets.
3. Update the local contract, manifest, bundled `tama-kit-cli` and
   `app-integration` skills, any affected graph skills, generated README and
   AGENTS guidance, post-bootstrap agent prompt, CLI reference, help, and human
   and JSON output.
4. Keep provider preparation and activation as separate checkpoints.

### Phase 5: Verification and delivery

1. Add unit, integration, security, migration, and diagnostic-redaction tests.
2. Add a production-image MCP App runtime gate to CI and npm publishing.
3. Reproduce the original Memovee failure, apply the new bootstrap, and prove
   host and container HTTPS access with Memovee in `MIX_ENV=dev` and the
   official Tama image in `MIX_ENV=prod`.
4. Stop accepting changes at the release candidate cutoff; only confirmed
   blockers found by the agreed review round enter the release branch.

## Acceptance criteria

- A fresh Memovee MCP App bootstrap starts Caddy, Tama PostgreSQL, and the
  official Tama server image without a restart loop.
- Memovee continues running host-native in `MIX_ENV=dev`; the bootstrap does
  not require a production release or production-only configuration.
- `https://tama.app.localhost/` is reachable from the host with a trusted
  certificate.
- Tama accepts `https://tama.app.localhost/mcp/app` in prepared mode and can
  reach the provider through `https://app.localhost`.
- OAuth metadata, token claims, resource metadata, JWKS, and introspection use
  exact public HTTPS origins; no Docker-only hostname appears in public
  identity.
- An existing 0.4.3 generated project can explicitly migrate without rotating
  valid provider or Tama signing material.
- Dry-run, JSON, logs, and diagnostics disclose no secrets.
- Human output and the copy/paste agent prompt use the resolved HTTPS topology,
  accurately distinguish written, started, prepared, and enabled states, and
  provide actionable next commands without stale direct-port guidance.
- A `--skills local` rerun refreshes affected managed skills and generated
  repository instructions for the new topology.
- The ordinary MCP App bootstrap does not require callers to manually align
  provider origin, Tama origin, allowed origin, and a published Tama port.
- Every Tama-owned public URL and the Caddy Tama host derive from one
  `PHX_HOST`; a conflicting retained `--tama-origin` or contract value fails
  validation instead of creating configuration drift.
- No normal-path verifier rewrites the Host header or resolves
  `host.docker.internal` as a public OAuth authority; host and container probes
  both use the exact HTTPS origins.
- Standard non-MCP bootstrap behavior remains unchanged.
- Full tests, package validation, the generic runtime gate, and the new MCP App
  mixed-environment runtime gate (`Memovee=dev`, `Tama=prod`) pass on the exact
  review head.
