# MCP App environment recovery increment

Branch: `feature/issue-41-mcp-app-env-recovery`, based on the merge of
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

## Review follow-up on 2026-10-01

Recovery activation guidance now prints `tama-kit setup ... --activate` and
preserves the selected project, ordered Compose files, services, environment
file, and contract. Paths with spaces are quoted. The regression also checks
that the actual CLI accepts the suggested command and flags.

`env doctor` now shares `env init`'s environment-reference deduplication. A
provider fragment declared by both Compose and its contract has one report,
retaining contract ownership, required status, and all declaring services. The
regression covers both present and missing fragments and confirms doctor leaves
project files unchanged.

The [CodeRabbit finding on PR #43](https://github.com/kritama/tama-kit/pull/43#discussion_r4153492543)
identified recovery-only checks running when no files needed creation. MCP App
recovery and destination-ambiguity inspection now run only when supported
required files are missing. Healthy shared-provider and multiple-integration
layouts retain successful no-op behavior in write and dry-run modes, while
missing-file recovery still refuses ambiguous selections. Exceptions from MCP
App effective-environment inspection become actionable, sanitized blockers;
raw diagnostics remain suppressed and no files are created. Three regressions
reproduced these failures before the fix and passed afterward.

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
matrix and existing runtime checks subsequently passed for `aa866e4` in
[this CI run](https://github.com/kritama/tama-kit/actions/runs/36825640306).
Recovery-specific runtime acceptance remains a separate item below.

Validation of the review follow-up on 2026-10-01 passed:

- `npm test`: 438 passed, one intentional skip, zero failures (439 tests total).
- `npm run check` and the build/typecheck: passed.
- `npm run validate:submission`: passed (22 positive and three negative cases).
- `npm run validate:package`: existing installed-package checks passed.
- Focused activation-guidance and doctor regressions: three passed on both
  Compose 5.1.2 and Compose 2.38.2.

Validation of the PR #43 CodeRabbit follow-up on 2026-10-01 passed:

- `npm test`: 441 passed, one intentional skip, zero failures (442 tests total).
- Build/typecheck, Biome, submission validation, and existing installed-package
  checks passed.
- Four focused tests passed with Compose 5.1.2 and 2.38.2, covering healthy
  no-op layouts, missing-file ambiguity, sanitized inspection failures, and
  invalid surviving public inputs during actual recovery.

## Remaining issue #41 work

- Public README, generated setup guidance, CLI skill/reference, and help updates
  for the complete recovery workflow.
- Explicit installed-package acceptance tests for `env doctor` and `env init`.
- Isolated Docker runtime recovery and persisted-volume refusal fixtures in CI,
  across the supported Node and macOS/Linux matrix.

This increment does not close issue #41. Recovery is environment completion,
not live runtime, OAuth, or Terraform verification.
