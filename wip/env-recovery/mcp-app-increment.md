# MCP App environment recovery increment

Branch: `codex/issue-41-mcp-app-env-recovery`, based on the merge of
[PR #42](https://github.com/kritama/tama-kit/pull/42) into `develop`.
Related issue: [#41](https://github.com/kritama/tama-kit/issues/41).

## Implemented scope

`env init` supports combined bootstrap and separate additive MCP App fragments
for HTTP and local HTTPS. Current Compose declarations, the selected local
contract, project-owned public examples, and surviving private files supply the
inputs. Recovery creates only missing private environment files with mode 0600;
existing files, keys, overlap sets, modes, Compose, Terraform, TLS, and receipts
remain unchanged.

New provider and Tama introspection keys are independent RS256 pairs. A new core
also receives its own System OAuth pair and runtime secrets. Newly issued
integration fragments use `prepared`. A conflicting surviving or effective mode
blocks the entire operation. Derived-only PostgreSQL recovery can preserve an
enabled integration and existing database state without issuing keys.

Before issuing secrets, recovery inspects the associated Tama database plus the
Compose provider's associated database, relevant direct data mounts, and running
or stopped provider containers. Detected data blocks issuance even with `--fresh`.
External databases, host providers, failed probes, and unobservable associations
require an explicit fresh-runtime assertion. Ambiguous associations remain
blocked. Persistence and current sources are rechecked inside the transaction;
late data, changed included Compose declarations, or effective signing shadows
roll back newly created files.

Fresh generation now emits a provider fragment's `.example` and additive
`.mcp-app.env.example`. Public examples use explicit variable allowlists and key
placeholders, excluding unrelated application secrets. Existing project-owned
examples are preserved. Older interrupted generation receipts can resume without
creating example destinations absent from their original pending list.

Older HTTP projects with insufficient public inputs get actionable blockers.
In particular, a surviving provider fragment cannot reconstruct the browser
origin list after losing the Tama fragment; that list needs its own public
example. Missing or invalid selected contracts cannot authorize standard-only
reissuance of an otherwise declared MCP App project.

Local HTTPS recovery preserves the distinction between the Tama upstream port
and Caddy's public port 443. Environment recovery never creates certificates,
installs trust, starts services, activates integration modes, or provisions
Terraform. It reports the remaining provider loading, TLS, setup, private
credential onboarding, and staged activation work.

## Verification

Focused regressions cover full and partial private-file loss; combined/additive
HTTP and HTTPS; prepared and conflicting modes; derived-only recovery; host and
Compose providers; positive database-volume, provider-bind, and stopped-container
evidence; unknown persistence; late data and effective signing shadows; changed
included declarations; stale or missing public inputs; custom bindings, relocated
fragments and contracts, renamed services; repeat no-op; dry-run; independent
valid keys; permissions; private-file preservation; public example redaction; and
older generation resume compatibility.

Native Compose environment resolution is exercised with Docker state injected
for deterministic persistence checks. No real provider or Tama database was
changed. Validation on 2026-09-30 passed:

- `npm test`: 436 passed, one intentional skip, zero failures (437 tests total).
- `npm run check`: passed with no warnings.
- `npm run validate:submission`: passed (22 positive and three negative cases).
- `npm run validate:package`: installed-package checks passed without development
  dependencies.
- Focused recovery/resume regressions on Compose 2.38.2: 28 passed.

Local validation used macOS, Node 26.3.0, and Compose 5.1.2; the older Compose
binary was selected through an isolated Docker config. The supported CI platform
matrix remains a separate acceptance item.

## Remaining issue #41 work

- Public README, generated setup guidance, CLI skill/reference, and help updates
  for the complete recovery workflow.
- Explicit installed-package acceptance tests for `env doctor` and `env init`.
- Isolated Docker runtime recovery and persisted-volume refusal fixtures in CI,
  across the supported Node and macOS/Linux matrix.

This increment does not close issue #41. Recovery is environment completion,
not live runtime, OAuth, or Terraform verification.
