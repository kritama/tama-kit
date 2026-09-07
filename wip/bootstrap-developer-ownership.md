# Bootstrap with developer-owned output

Status: bootstrap/setup/doctor migration, additive `generate mcp-app`, and legacy
planner removal implemented.
Validation and release status are recorded at the end of this plan. Recorded 2026-09-07 after the graph-guidance work on
`feature/progressive-bootstrap-skills` (commit `180e4b0`, PR #32).

## Goal and delivery boundary

Tama Kit generates a working project starting point. Every generated project file
belongs to the developer as soon as it is written. Developers can change provider
versions, Compose services, file locations, environment loading, contracts, prompts
and agent instructions without maintaining generator hashes or obtaining an eject
permission. The resulting project runs with its native tools without Tama Kit.

Finish the current skills PR separately. Start this implementation from develop
after that work lands, on a dedicated branch. Do not add ownership implementation
to the skills PR, provision a new Memovee instance, or reset an existing project.
This plan supersedes prior WIP requirements for permanent generated-file ownership
where they conflict; those documents remain historical records.

## Original implementation and the problem

- `cli/bootstrap/manifest.mjs` stores `managedFiles` digests, rejects changed or
  missing files, adopts legacy marked files and validates persisted topology
  against a canonical derivation.
- `cli/shared/files.mjs` treats a generated marker as authority to update a file.
- `cli/bootstrap/plan.mjs` combines template generation, provider configuration,
  Terraform ownership, secrets, local skills and manifest reconciliation.
- `cli/workflows/bootstrap-plan.mts` and `cli/workflows/mcp-app-runtime.mts` call
  the same generator during setup, activation and recovery. Activation recovery
  can regenerate configuration instead of restoring only its own changes.
- `cli/bootstrap/setup-progress.mjs` and the skills tell developers to rerun
  bootstrap for subsequent runtime operations. Bootstrap manifests consequently
  become mandatory inputs to ordinary application integration work.

Memovee demonstrates the cost: its application-owned provider override avoids
editing a generated versions file, and its customized Compose topology conflicts
with the historical manifest. The override itself is valid Terraform; developers
should simply be free to edit versions.tf when that is clearer.

Removing the digest comparison alone is insufficient. Setup and recovery must
also stop regenerating files from the original topology.

## Ownership contract

1. All generated Terraform, Compose, Caddy, environment examples, private fragments,
   contracts, README, AGENTS, ignore rules and repository-local skills become
   project-owned immediately. Generated comments identify provenance only.
2. Bootstrap must not automatically update, delete or recreate completed output.
   A file intentionally removed from an established project stays removed.
3. Existing credentials remain unchanged. Missing credentials are diagnosed;
   they are not silently replaced to make an old project resemble a fresh one.
4. A requested operation may write only its reviewed destinations. Preserve
   exclusive creation, safe paths, redaction, secret-file checks and rollback.
5. A before-write fingerprint may prevent concurrent edits from being overwritten
   within one operation. It must not become a permanent generation-time ownership
   check. Do not remove transactional safety with managed-file enforcement.
6. Terraform source and state ownership remain authoritative. Do not add a second
   global foundation, rename resource addresses or alter state during migration.

## Proposed command responsibilities

These interfaces are implemented on `feature/bootstrap-developer-ownership`; publishing the release is separate.

| Command | Responsibility | Project writes |
| --- | --- | --- |
| `bootstrap [path]` | Generate the initial selected scaffold | New destinations and explicitly reviewed integration edits |
| `generate mcp-app [path]` | Add MCP App scaffolding to an existing standard project | Only the selected capability's additions and reviewed edits |
| `setup [path]` | Guide runtime startup, private root setup and staged activation | Only explicitly selected configuration changes |
| `doctor [path]` | Inspect present configuration and optionally probe runtime | None |
| Native Terraform/Compose/Mix commands | Normal project development and operation | Controlled by those tools and the developer |

Keep `init` as the existing bootstrap alias. Do not build a general generator
framework or automatic upgrade engine in this change; the MCP App addition is the
one existing capability that needs an explicit post-bootstrap generation path.

### Generation and reruns

- Fresh output uses the existing layout, explicit graph feature-file conventions,
  versions and credential separation. It includes complete native setup/run/check
  instructions, including provider environment loading and CA trust.
- Plan all writes before performing any. Existing identical destinations are
  preserved; differing destinations are conflicts, with no partial writes. The
  default never replaces a developer file because it has a generated comment.
- Existing application integration files, such as root Compose or ignore files,
  may receive a narrowly scoped, previewed edit. Never replace the entire file
  with a template to insert one service/include or ignore rule.
- A completed bootstrap invocation reports that the project already exists and
  makes no generation changes. New `--image`, port or topology values must not
  silently turn a rerun into a project upgrade; explain the requested change and
  direct the developer to edit current configuration or an explicit setup action.
- Separate generation completion from runtime readiness. A configured project
  can still need root-user setup, provider implementation, provisioning or live
  verification; none of those requires regenerating its files.
- Resume incomplete generation only through an explicit resume choice and an
  unfinished receipt identifying the original operation's uncreated destinations.
  Never infer permission to restore a deleted file from an old inventory. Existing
  files are preserved, and absent receipt evidence means inspect/report rather
  than guessing which files to recreate.
- `--dry-run` remains read-only and must not require a running Docker daemon.
  Creation conflicts, requested writes and unsupported actions stay clear in both
  terminal and JSON output. Preserve machine-readable error categories; document
  additions or intentional compatibility changes.

### Setup without regeneration

Extract startup, browser handoffs, verification and activation from the generation
planner. A fresh `bootstrap --start` may invoke setup after generation. Existing
`bootstrap --start` and `--activate` invocations can remain compatibility routes to
the setup workflow, with a deprecation message; they must never replan templates.
Preserve the interactive continuation experience and public status reporting.

Load the actual selected Compose configuration, provider bindings and environment
files. Use the project-owned MCP contract for declared integration bindings, then
verify agreement with effective configuration. Explicit paths override discovery;
ambiguous paths or inconsistent public identities produce a precise diagnostic.
Do not guess secret files or make the old manifest the source of operational truth.
Support the chosen Compose root and overrides consistently through start and probe
operations, rather than assuming the generated default model is still in use.

Continue the existing prepared/enabled protocol. Activation changes only the
selected mode settings after checking the actual provider and Tama endpoints.
If settings cannot be safely edited in their current source, provide exact manual
steps and resume verification afterward. Provider code and restart ownership stay
with the application. Never copy provider keys into Tama or rotate them on resume.

Recovery restores only the fields/files changed by that activation attempt and
checks for intervening edits. It does not rerun bootstrap, revert unrelated developer
changes, delete volumes or claim success after an incomplete recovery. Keep the
original sanitized diagnostic when recovery also fails.

### Read-only diagnosis

`doctor` validates current contracts, not template equality. Use Docker Compose's
configuration parser and Terraform's native validation where applicable. Report
missing tools or uninitialized providers separately from invalid configuration;
do not install providers, initialize Terraform or write files in a read-only check.
Live probes require an explicit runtime option and must be non-mutating.

Report configuration and runtime results separately, including missing variables,
invalid keys, loader wiring, public OAuth identity mismatches, trust failures,
service availability and unverified capabilities. A changed service name, provider
version, comment or file layout is not itself a failure. No output contains secret
values. Removing the bootstrap receipt must not prevent runtime use or diagnosis
when the current configuration can be located explicitly.

## Existing manifests and optional receipts

Retain a small versioned generation receipt only for provenance and incomplete
generation progress. It is not required to run the project or enforce file content.
Do not duplicate the project's live topology or secrets in a second desired-state
document. Generation history and observed setup status are not current desired
configuration.

Read v1 manifests through a dedicated compatibility adapter. Recognize existing
projects even when their files differ from recorded hashes or their valid current
topology no longer matches the original derivation. Read-only commands never
rewrite a legacy manifest. During an explicitly mutating setup/generation operation,
an optional receipt conversion can be included in the displayed write plan.

Preserve every existing project file, credential, Terraform address and volume
during conversion. Hashes may be ignored without deleting the old manifest first.
Do not require an eject command, a special ownership flag, bootstrap recreation or
a database reset. Malformed legacy metadata must not authorize writes; report it
and allow read-only inspection using explicitly selected current configuration.
Never silently prefer stale manifest endpoints over the application's config.

## Scripts and native operation

Do not replace Memovee's development runner with a permanent Tama Kit requirement.
Document direct Terraform and Compose commands and ordinary foreground application
startup. Keep application-specific Actor, API and persistence checks in Mix tasks
or tests. Host Caddy routing is application configuration, not a package script.

Tama Kit's internal `validate-*` scripts remain isolated package acceptance
harnesses. They are not public start/stop commands for an existing checkout. Any
optional shared runtime runner must use `cli/`, support macOS/Linux, preserve
explicit service selection and stop only resources it started. Such a runner is a
separate feature, not a prerequisite for changing file ownership.

## Implementation work packages

1. **Generation and compatibility contracts.** Add generation-result/receipt types
   and the legacy adapter. Replace managed-file planning and marker-based overwrite
   authority with create/preserve/conflict operations. Keep transactional write and
   concurrent-change checks. Cover fresh, existing, interrupted and customized roots.
2. **Current configuration inspection.** Extract project configuration readers from
   bootstrap planning; give setup and doctor the same resolved configuration model.
   Read current Compose and contract bindings without requiring canonical manifests.
3. **Separate setup and recovery.** Move continuation/start/activation off
   `createBootstrapPlan`, preserve command compatibility and sanitized progress,
   and replace whole-project regeneration with narrow activation changes/recovery.
4. **Generation additions and handoff.** Implement the explicit MCP App addition
   path. Update generated native commands, provenance comments and optional receipts.
   Ensure the project works after the Tama Kit package is removed.
5. **Skills, docs and release.** Update graph-builder, graph-audit, tama-kit-cli,
   app-integration, CLI references, setup checklists, templates, tests and package
   verification together. Remove permanent manifest/ownership gates. Describe the
   old command mappings and changed rerun behavior in release notes.

Keep command handling in `cli/commands`, workflows in `cli/workflows`, validated
contracts in `cli/domain`/types, and reusable file/process helpers in `cli/shared`.
Keep `bin/` thin. No second HCL parser or Python graph validator is needed.

## Acceptance criteria

- A fresh standard and MCP App scaffold works using documented native commands
  after Tama Kit is removed; guided setup remains an optional convenience.
- Edit generated versions.tf, Compose services/overrides, Caddy routing, README,
  AGENTS and local skills. Bootstrap rerun preserves their bytes; doctor and setup
  accept valid current configuration without a managed-file drift failure.
- Add application `graph/*.tf` files and reorganize valid runtime configuration.
  No second foundation, resource rename, state migration or global reset occurs.
- Delete a completed generated file. A bootstrap rerun does not restore it.
  Interrupted generation resumes only its explicitly selected unfinished work.
- A destination conflict leaves all existing files untouched. A failed multi-file
  generation rolls back only that operation's writes; concurrent edits are retained.
- Customized v1 manifests/files work without an eject command. Read-only inspection
  changes no files; optional receipt conversion changes no application/secret data.
- Remove the receipt and provide explicit current configuration paths. Ordinary
  runtime operations and doctor still work. Stale/malformed receipt data is never
  used as authority to replace files or change public identities.
- Staged activation and provider-restart continuation preserve keys and unrelated
  content. Injected activation/recovery failures never regenerate the project.
- Host and Compose providers both pass; renamed valid services and custom overrides
  are supported, while real issuer/resource/CA mismatches still fail clearly.
- Secret redaction, safe paths, ignored private files, exclusive key creation and
  transactional guarantees remain covered. Checks run on supported macOS/Linux
  and Node versions, including an installed package without dev dependencies.

Run repository lint/type checks, full tests, submission/package validation and the
existing isolated runtime suites. Add behavioral regression tests for the contracts
above, not assertions that merely match new documentation wording. Use Terraform
fmt/validate/native tests for generated Terraform; keep runtime acceptance separate.

## Current evidence and remaining work

The original plan was based on source inspection of the skills branch and the
reviewed Memovee foundation. The preceding skills
commit passed 307 tests (one expected skip), lint/type checking via the build,
submission validation and installed-package validation. Those checks validate the
preceding guidance release, not this proposed ownership behavior.

### First implementation slice (2026-09-07)

Branch: `feature/bootstrap-developer-ownership` (renamed from the initial
`codex/` branch per Git Flow), created from develop at `65b1b74`
after PR #32 merged. Review confirmed that generation, activation and recovery
still share `createBootstrapPlan`; removing the old manifest checks before
separating those workflows would allow regeneration of developer-owned files.

Implemented foundations for work package 1:

- `cli/domain/generation.mts` defines generation results and a validated v2
  receipt. Completed receipts have no file inventory. Incomplete receipts contain
  an operation identifier and only pending project-relative destinations. Neither
  form stores desired topology, credential values or content hashes.
- `cli/bootstrap/generation-receipt.mjs` reads optional evidence without writes.
  Its dedicated v1 adapter recognizes historical scaffolds without reading their
  recorded destinations, comparing hashes, or deriving operational topology.
  Malformed structural metadata fails with the existing `ownership` category
  (exit 4); JSON parse errors do not disclose source content.
- `cli/workflows/generation.mts` plans create/preserve/conflict operations.
  Existing completed/v1 evidence yields `existing` with no writes, including when
  files have been edited or removed. An explicit matching operation identifier
  permits resume of an incomplete receipt's pending destinations only. Existing
  files encountered during resume remain untouched. Callers must establish fresh
  generation intent separately; absent metadata alone does not authorize writes.
- `cli/shared/files.mjs` adds generation planning that grants no overwrite
  authority to generated comments. Identical files keep their bytes and modes.
  Differing files conflict before any generation writes occur. Destination and
  ancestor checks reject symlinks, including dangling links.
- The existing shared transaction writer now checks the entire plan before writes
  and rechecks files before each change. New files are published exclusively;
  unchanged operations do not chmod files. Rollback visits only successfully
  changed paths, checks content, inode, permissions and directory identities, and
  preserves intervening edits. It continues restoring independent files after a
  recovery conflict and retains the original failure in an aggregate diagnostic.

The shared writer changes are active in existing CLI workflows. The new generation
planner and receipt reader are internal building blocks and are **not yet routed
from bootstrap**. Existing bootstrap still uses v1 manifests, managed-file checks
and marker-based planning. No setup/doctor/generate commands, receipt persistence
or conversion, runtime configuration reader, or activation recovery cutover are
implemented in this slice. In particular, the full developer-ownership acceptance
criteria above are not yet met.

Next: extract current-configuration inspection (work package 2), then separate
setup and activation recovery (work package 3). Wire the generation planner,
receipt progress persistence and command compatibility only once these paths can
no longer regenerate the original scaffold. Keep the prepared/enabled protocol
and provider-owned restarts intact through that cutover.

Validation on macOS with Node 24:

- Lint, TypeScript build/type checking, submission validation and diff whitespace
  checks passed.
- Full suite: 321 passed, one expected POSIX secondary-group skip, zero failures.
  This includes 14 new generation/transaction behavior tests. The HTTP/HTTPS
  socket tests required execution outside the restricted filesystem sandbox.
- Installed-package validation passed without development dependencies; it also
  checks inclusion of the new emitted generation modules.
- Isolated standard bootstrap runtime validation passed (Docker startup, Compose,
  Terraform and package checks).
- Isolated MCP App HTTPS runtime validation passed for both host and Compose
  providers, including the existing staged activation behavior.

No existing Memovee checkout, credentials, state or services were changed. The
Memovee-specific acceptance harness and the Linux/Node 20 CI matrix were not run
in this slice. These results validate the first slice and existing workflows;
they do not establish acceptance of the still-unimplemented command migration.


### Command migration slice (2026-09-07)

Implemented on `feature/bootstrap-developer-ownership`, continuing PR #33:

- Bootstrap and init now route completed v2/v1 projects before the generator or
  questionnaire. Reruns preserve customized and deleted output. Existing runtime
  flags delegate to setup with a deprecation notice. Existing configuration-change
  flags no longer upgrade projects. A newly selected existing project and startup
  retries also leave the generation path before continuation.
- Initial generation uses create/preserve/conflict planning and v2 receipts.
  Progress is journaled transactionally as pending destinations; completion drops
  that inventory. Explicit `--resume <id>` with original options creates only
  remaining destinations and preserves existing output. Receipt writes retain
  reviewed preconditions and roll back only this invocation's successful changes.
- `setup` and `doctor` share current-configuration inspection using native Compose
  JSON, declared/effective environment bindings and the selected local contract.
  They ignore receipts and historical topology/hashes. Explicit root/override,
  service, environment, contract, proxy and CA selections support reorganized
  projects. Existing contracts can name relocated provider fragments and endpoint
  paths outside generation defaults. Private keys, overlap sets, identities,
  origins, mode sources and loader wiring are validated without exposing values.
- Setup starts and verifies current configuration without template planning.
  `--activate` verifies prepared services, edits only an unshadowed Tama mode
  assignment, restarts Tama and returns the application provider handoff. Recovery
  restores only that assignment while preserving unrelated edits; concurrent mode
  edits require manual resolution. Already-enabled verification does not reset
  configuration. Native Compose startup excludes the selected application provider
  and uses `--no-deps`, leaving its start/restart to the application.
- Doctor never writes, starts services, initializes Terraform or installs providers.
  Optional `--runtime` enables probes; `--terraform-root` selects native Terraform
  validation. Missing tools, uninitialized providers, invalid configuration and
  runtime evidence are distinct. Setup dry runs preview mode edits without writes.
- Generated provenance comments, native-operation instructions, setup checklists,
  CLI/app-integration/graph-builder guidance, command reference and package checks
  now describe developer ownership and the command mappings. Removed obsolete
  documentation assertions that required a permanent bootstrap/manifest gate.

Validation on macOS / Node 24:

- Full suite: 333 passed, one expected POSIX secondary-group skip, zero failures.
  Command tests cover edited/deleted files, v1 history, absent/malformed receipts,
  custom Compose roots/overrides, renamed services, moved private fragments,
  custom endpoints, explicit resume, narrow recovery, provider exclusion and
  concurrent receipt protection. Runtime workflow tests cover failure recovery.
- TypeScript build, Biome checks, submission validation, skill validation and
  diff whitespace checks passed. Skill validation used a temporary PyYAML venv.
- Installed-package verification passed without development dependencies and
  checks emitted setup/doctor/activation/current-inspection modules.
- Isolated standard runtime acceptance passed with Compose, Terraform and package
  checks. Host-provider HTTPS setup/activation passed. Compose-provider HTTPS
  setup/activation passed with provider container identity preserved. One earlier
  Compose run reported an unhealthy service; an instrumented retry passed, then
  the final provider-ownership scenario also passed.

Validation correction (2026-09-07): the complete previous migration matrix passed
on commit `02c834f` in GitHub Actions run
[34084244747](https://github.com/kritama/tama-kit/actions/runs/34084244747).
All four Ubuntu/macOS and Node 20.12/24 combinations, bootstrap runtime integration,
and isolated Memovee local HTTPS integration were green. The earlier statement
that Memovee/Linux/Node 20 acceptance remained pending was stale. That evidence
applies to the migration commit, not automatically to subsequent additions.

## Additive generation and final command cleanup (2026-09-07)

Implemented work package 4 as `tama-kit generate mcp-app [path]`:

- Reads current Compose configuration with ordered `--compose`, `--service`, and
  `--env-file` selection. Does not re-enter the bootstrap/template reconciliation
  planner or recover desired topology from a legacy manifest.
- Generates a separate `tama/compose.mcp-app.yaml` override, private MCP environment
  fragment, provider fragment, local bridge contract, and `tama/MCP_APP.md` handoff.
  Existing runtime keys, Terraform, Compose files, instructions and bootstrap receipt
  stay intact. Only missing secret-ignore lines are appended to the ignore file.
- Requires a compatible pinned image. An existing compatible image is reused;
  floating tags and custom builds need an explicit `--image` selection. Local HTTPS
  uses a derived CA image, removes old Tama host-port publications through the
  override, and requires Docker Compose 2.24.4 or newer.
- Local HTTPS creates a dedicated `tama/mcp-app-tls/` public root and atomic private
  certificate/key PEM bundle. Interrupted generation cannot split a certificate
  from its private key. Resume validates existing certificate/key/CA/name agreement.
- Uses a separate v2 capability receipt at `tama/.tama-kit-mcp-app.json`. Completed
  reruns preserve edits/deletions. Explicit unfinished `--resume <id>` is limited
  to pending destinations; concurrent writes and conflicting files fail closed.
- Both terminal review and JSON output expose paths/actions and exact setup/native
  commands without private contents. Generation reports configuration only and
  never starts the provider or activates a runtime. Setup retains provider restart
  ownership. The override must stay last in the emitted Compose selection.

Command cleanup removed the retired existing-project migration questionnaire,
manifest-based lifecycle replanning, and the workflow's managed-write fallback.
Fresh bootstrap always uses the developer-owned writer and reads current configuration
before runtime actions. At this slice, low-level v1 planner fixtures still remained for regression
coverage; they were removed in the cleanup below. CLI routing, package
checks, README and the packaged CLI skill/reference now document the additive command.

Validation for this addition:

- Full local suite: 343 passed, one expected POSIX secondary-group skip, no failures.
  TypeScript build, Biome, submission validation, CLI skill validation, installed
  package checks and whitespace checks passed. The host HTTPS fixture also verified
  interrupted public-CA recovery while preserving the existing certificate/private key.

- Isolated host-provider and Compose-provider local HTTPS generation, prepared
  verification, Tama activation, provider-owned enable/restart, and enabled
  verification passed locally. The Compose-provider container identity was preserved.
- Regression coverage includes unchanged/customized/deleted initial output, renamed
  services, moved private environments, ordered overrides, conflict refusal, inline
  environment shadowing, explicit interrupted resume, private-key preservation,
  ignored-secret rollback, and JSON/noninteractive behavior.
- The CI integration job now exercises additive host and Compose providers in
  addition to the original bootstrap runtime scenarios. The current additive
  commit is tracked by the check suite on PR #33; the previous green run above
  is historical migration evidence, not a substitute for those checks.

No existing Memovee checkout, credentials, Terraform state, volumes or services
were changed. Publishing/tagging a release remains a separate release action.

## Legacy planner removal (2026-09-07)

Removed `cli/bootstrap/manifest.mjs` and its managed-file planner, marker adoption,
permanent digest inventory, saved image/Compose settings, saved skill selection,
and canonical provider-topology reconstruction. Initial generation now has one
file planner: exclusive creation/preservation with a v2 receipt. The `developerOwned`
switch and manifest write fallback no longer exist.

Provider preparation reads the selected contract and explicit inputs. It does not
read saved manifest identities, bindings, domains, runtime services or origins.
Removed the provider identity/topology/HTTPS migration implementations and their
obsolete internal lifecycle inputs. Deprecated command flags remain recognizable
only to return an actionable refusal. Generation always prepares MCP App; setup
owns staged activation. Removed the duplicate, unreachable skill-choice prompt.

Terraform planning preserves existing foundation/version files and no longer has
an adoption or version-rewrite callback. Retired System OAuth signing variables
produce a manual-migration diagnostic; even a generated marker cannot authorize
replacement keys. Cryptographic validation, secret-ignore checks, canonical path
checks, write preconditions, rollback and explicit interrupted resume remain.

The only v1 manifest support retained is the read-only history adapter in
`generation-receipt.mjs`. Existing v1 projects are still recognized by bootstrap;
setup/doctor continue to use current configuration without receipts.

Tests for retired upgrades, saved settings and manifest-only state were removed
or replaced with current-contract, preservation and conflict-refusal assertions.
Fresh generation, key/overlap validation, safe paths, Terraform ownership, current
configuration, v1 history, additive generation and activation/recovery coverage
remain. The installed-package check explicitly excludes the deleted planner.

Validation for this cleanup is reported separately from the fully green additive
commit `a7a0c6c` ([run 34087836664](https://github.com/kritama/tama-kit/actions/runs/34087836664)).
The current cleanup commit's CI checks are attached to PR #33. No real Memovee
runtime, credentials, Terraform state or volumes were changed.

Local cleanup validation: 312 tests passed, one expected POSIX secondary-group
skip, no failures. TypeScript build, Biome, submission validation, installed-package
validation and whitespace checks passed. All six cleanup CI jobs passed at
`1f7bb72` in [run 34089393205](https://github.com/kritama/tama-kit/actions/runs/34089393205).


## Review corrections (2026-09-07)

Current-configuration inspection recognizes every declared MCP App mode,
including disabled, and the default local contract. Disabled integrations cannot
bypass provider bindings, key, origin or topology validation. Additive generation
inspects the original standard runtime separately from its pending contract and
validates the complete MCP composition before committing output.

Interrupted generation compares preserved runtime configuration with the resumed
plan. Changed options that disagree with existing files fail before pending files
are written or the receipt is completed. Documentation and copied skills remain
preserved; private additive environments preserve formatting and validated overlap
keys only after expected values agree. Final effective environment checks also
apply to resumed additions.

Local validation: 316 tests passed, one expected platform skip, no failures;
TypeScript build, Biome, submission, installed-package and whitespace checks passed.
Regression tests cover disabled and missing-mode contracts, changed port/image
resumes, unchanged failed-resume snapshots, and successful original-option recovery.
The review-fix commit's runtime checks are tracked on PR #33.


## Dry-run progress and provider-path review (2026-09-07)

Setup passes its actual dry-run state into progress reporting. Preview takes
precedence over enabled/restart phases, reports no runtime verification, and
returns only a review action. Activation previews preserve both mode files.

The reported out-of-scope provider-fragment ignore failure is blocked by the
existing generation contract: flags and contracts must select fragments inside
`tama/`. Command-level regressions now verify that `config/acme.env` is rejected
before any writes in both normal and dry-run invocation. No path restriction or
ignore scope was changed. Current-configuration inspection still supports
application-owned relocated fragments after generation.

Local validation: 319 tests passed, one expected platform skip, no failures.
Build, Biome, installed-package, submission and whitespace checks passed.
The current commit's CI is tracked on PR #33.


## Optional Compose environment files (2026-09-07)

Current inspection retains `env_file.required` and skips absent declarations
only when explicitly optional. Missing optional files cannot become selected
environment or activation sources. Existing optional files retain regular-file,
permissions, Git and content validation; required files still fail when absent.

Regression coverage exercises doctor, setup preview and additive generation,
explicit selection of an absent optional file, existing optional-file permissions,
and missing required files. Local validation: 323 tests passed, one expected
platform skip, no failures. Build, Biome, installed-package, submission and
whitespace checks passed. The current commit's CI is tracked on PR #33.


## Independent activation source selection (2026-09-07)

`--env-file` selects the reported private environment without overriding discovery
of the sole `TAMA_MCP_APP_MODE` assignment. Additive setups can select core secrets
and still activate through their separate MCP fragment. Duplicate assignments and
inline shadowing continue to require manual edits.

Regression coverage verifies activation preview, isolated mode writes and recovery,
core/provider-file preservation, duplicate sources and inline shadowing. Local
validation: 324 tests passed, one expected platform skip, no failures. Build,
Biome, installed-package, submission and whitespace checks passed.

The previous CI failure was a GitHub 504 fetching Terraform provider checksums;
its retry passed the previously failing bootstrap/Compose/Terraform runtime step.
The latest commit's complete CI results remain tracked on PR #33.

No extra Compose 2.24.4 gate was added for HTTP `!reset`: Compose 2.20.0 uses
compose-go 1.16.0, whose reset processor already handles that tag. The documented
2.24.4 requirement applies to `!override`, used by the existing HTTPS path.
