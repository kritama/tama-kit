# Bootstrap with developer-owned output

Status: approved direction; implementation plan only. CLI behavior is not changed
by this document. Recorded 2026-09-07 after the graph-guidance work on
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

## Current implementation and the problem

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

These interfaces describe the target release; they are not currently available.

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

This document is based on source inspection of the skills branch and the reviewed
Memovee foundation. No ownership implementation, migration, new command, service
operation or deployment has been performed for this plan. The preceding skills
commit passed 307 tests (one expected skip), lint/type checking via the build,
submission validation and installed-package validation. Those checks validate the
preceding guidance release, not this proposed ownership behavior.
