# MCP App environment recovery increment

Branch: `feature/issue-41-mcp-app-env-recovery`, based on the merge of
[PR #42](https://github.com/kritama/tama-kit/pull/42) into `develop`.
Merged into `develop` in [PR #43](https://github.com/kritama/tama-kit/pull/43)
at `747165148da19ed361b68d025e9bfa5aa727baa7`; all six CI jobs passed for its
reviewed implementation head `db88d12`.
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

## Documentation increment on 2026-10-01

Branch: `feature/issue-41-env-recovery-docs`, based on the merged PR #43.

The [README](../../README.md#recover-private-environment-files-after-cloning)
links to a complete [environment recovery guide](../../docs/environment-recovery.md).
The guide covers supported/optional/application files, current selection and
Compose precedence, public inputs and older layouts, persistence refusal and
explicit `--fresh`, derived recovery, prepared MCP App keys, local HTTPS, private
onboarding, JSON/exit codes, and setup/activation/Terraform follow-up boundaries.

The public MCP App guide, packaged CLI skill/reference and discovery metadata,
env/setup/doctor help, generated README/agent instructions, copy-ready setup
prompt and additive `MCP_APP.md` now describe the same recovery workflow.
Generated recovery commands preserve the selected Compose files and services
and quote paths. Existing project-owned documentation is not refreshed by reruns.

Validation on 2026-10-01 passed: build/typecheck, Biome, the full suite (441
passed, one intentional skip, zero failures), submission validation (22 positive,
three negative cases), and existing installed-package checks. Eleven local
Markdown links and three generated commands with a quoted Compose filename
were checked; the actual CLI accepted every generated command via help.
Manual review compared the guidance and supported
flags with current CLI and recovery policy. An optional CodeRabbit CLI review
was rejected by automatic approval because it would transmit the staged diff to
an external service without specific authorization; no diff was submitted.

## Final acceptance increment on 2026-10-01

`validate:package` now exercises the installed executable's `env doctor` and
`env init` against disposable standard and additive MCP App projects. It covers
missing-file diagnosis, dry-run without changes, unknown-persistence refusal and
explicit `--fresh`, derived database companions, complete private-file recovery,
repeat no-op, mode 0600, unchanged surviving files, prepared integration modes,
independent signing keys, and secret-free JSON. Recovery assets are required in
the tarball and no development dependencies are installed in the consumer.

`validate:env:runtime` runs these checks with real Docker persistence probes,
then starts uniquely named disposable PostgreSQL fixtures, writes a test row,
and verifies derived companion recovery preserves authentication/data. Missing
core or integration secrets are refused with and without `--fresh`; the row
survives and volume-only refusal is checked after removing the containers.
Cleanup addresses only each fixture's UUID-scoped resources.
The SQL-only fixture uses PostgreSQL 15 Alpine, with image pulling separated
from the bounded startup check; a cached official bootstrap database image may
be selected locally through `TAMA_ENV_ACCEPTANCE_POSTGRES_IMAGE`. SQL checks use
TCP password authentication. macOS CI sets explicit loopback preview names and
an isolated Docker client configuration for public fixture images.

CI adds Docker acceptance on Ubuntu and macOS Intel with Node 20.12 and 24.
The existing macOS matrix also retains installed-package checks. Intel runners
allow Colima to run the Docker daemon; the standard macOS ARM runners keep native
Compose and non-daemon package coverage. Publication reruns Docker acceptance
before npm publish.

Local real-Docker installed-package acceptance passed on 2026-10-01. CI platform
results must be green before the remaining checkbox and issue are completed.

## Remaining issue #41 work

- Verify the new isolated Docker runtime recovery and persisted-volume refusal
  CI jobs across the supported Node and macOS/Linux matrix.

This increment does not close issue #41. Recovery is environment completion,
not live runtime, OAuth, or Terraform verification.
