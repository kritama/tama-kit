# Private environment recovery review 01

Date: 2026-09-29

Status: partial implementation; blocking safety defects and remaining acceptance work

Issue: [kritama/tama-kit #41](https://github.com/kritama/tama-kit/issues/41)

Review target: `kritama/tama-kit`, branch
`feature/issue-41-env-recovery`, at
`67fdd4900b33fe40aea292dabe92cd76be21a0cb`.

Baseline: `a3f3008722be7fc4e962f002ef4606ab467f849c`.

Reviewed against the implementation plan in
[env-recovery.md](../env-recovery.md).
The findings below describe this snapshot; subsequent changes need verification
before any finding is marked resolved.

## Outcome

The standard core/PostgreSQL recovery path is implemented, along with current
Compose declaration inspection and actionable missing-file preflight diagnostics.
The build and existing validation pass, but issue #41 is not ready to close.
Three persistence defects can permit new vault/JWT/OAuth material to be issued
without establishing that the relevant database is fresh. Additional defects
affect configuration preservation, doctor accuracy, optional files, and selectors.

Complete the P1 findings before relying on new-secret issuance. Then address the
P2 findings and the remaining MCP App, documentation, and acceptance work.

## Accomplished work

| Area | Implemented behavior | Qualification |
| --- | --- | --- |
| Compose inspection | Shared native declaration inspection preserves includes, ordered overrides, required/optional env references, and the existing Compose fallback. | Required interpolated references are still omitted from recovery decisions; see R6. |
| `env doctor` | Read-only file diagnosis, role classification, permissions/Git checks, dotenv parsing, present JWK pair checks, and core/PostgreSQL credential comparison. | It does not yet establish semantic validity or complete inspection; see R5 and R6. |
| `env init` | Creates missing standard core/PostgreSQL files; derives a missing database companion from surviving credentials; supports JSON, noninteractive use, dry-run, and repeat no-op behavior. | Public configuration, optional references, and selectors need correction; see R4, R7, and R8. |
| Write safety | Uses the existing exclusive secret-file writer and transactional rollback, creates private files with mode 0600, preserves existing files, and checks surviving-file digests. | Persistence authorization has gaps; see R1–R3. |
| Setup/doctor preflight | Names missing required paths and supplies recovery commands before full env resolution, including machine-readable error details. | Init's subsequent setup guidance loses part of the selection; see R8. |
| Manual next actions | Applied recovery includes setup, private root/provisioner credentials, and Terraform validation guidance without reporting live readiness. | This is partly implemented despite its unchecked WIP item. |
| Tests | Adds 23 env-focused test cases. | The existing suite does not cover the reproduced failures below. |

The feature is delivered across four commits after the baseline: Compose
inspection extraction, emitted-module ignores, env doctor/preflight, and env init.

## Confirmed findings

### R1 — P1: Unknown persistence bypasses the fresh-runtime assertion

Source: [no-local-data-source branch](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L425).

When `findPostgresDataSources()` returns null, init sets persistence to `unknown`
but never applies the `--fresh` requirement. That requirement exists only in the
other branch. A configuration without a local PostgreSQL data mount therefore
reaches new-secret creation with `fresh: false`.

Reproduced with a temporary standard bootstrap fixture whose selected Compose
file loads `.tama.env` but declares no local database mount. After removing the
core env file, init returned `ok: true`, `persistence: unknown`,
`freshAsserted: false`, no blockers, and created the missing core file.

An external or otherwise unverifiable database may already contain encrypted
material and credentials. New keys can make that state unusable.

Required correction: apply one issuance policy after every persistence observation.
Detected state must refuse issuance; unknown state must require the explicit
fresh-runtime assertion. The no-mount branch must not bypass that policy.

Acceptance: the same fixture without `--fresh` fails before any write; with an
explicit assertion it records `freshAsserted: true`. Detected state remains blocked
even with `--fresh`.

### R2 — P1: Failed persistence probes can be reported as absent

Sources: [Docker error handling](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/bootstrap/persistence.mts#L104),
[bind inspection](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/bootstrap/persistence.mts#L79),
and [transaction recheck](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L495).

Except for a missing executable, the Docker helper converts failures to null.
Volume probes interpret null as a missing volume, while a failed container probe
also falls through. After a successful version check, permission or connection
errors can therefore produce `status: absent`.

Reproduced by injecting a successful `docker version` and permission/connection
errors for the volume and container probes. The observation was `absent` with
the claim that no local PostgreSQL state was found.

Static review found related uncertainty handling: bind-path inspection catches
all filesystem errors and reports no data, and the final transactional recheck
rejects `detected` but accepts `unknown` even when no fresh assertion was supplied.

Required correction: distinguish confirmed nonexistence from unsuccessful
inspection. Preserve unknown state for failed probes and unreadable bind paths.
Apply the same issuance policy during the final recheck, rolling back when a
previously verified observation becomes unverifiable without an accepted assertion.

Acceptance: cover permission errors, daemon loss after the version check,
unreadable binds, and an absent-to-unknown final observation. None may silently
authorize issuance as verified-absent state.

### R3 — P1: Persistence inspection can select an unrelated database

Source: [PostgreSQL data-source selection](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/bootstrap/persistence.mts#L47).

Discovery iterates every service and returns the first service with a PostgreSQL
data mount. It does not establish which database belongs to the selected Tama
runtime.

Reproduced using native Compose parsing with an application PostgreSQL service
ordered before the Tama database. Injected Docker state marked the Tama volume
as existing and the application volume as absent. Init probed only the application
database, reported `absent`, and created the new core secrets.

Required correction: resolve the database associated with the selected Tama
service using current configuration and dependency/connection evidence. Refuse
ambiguous or unverifiable association instead of selecting by service order.

Acceptance: multiple databases and renamed services must inspect the selected
Tama database. Relevant existing state must block issuance regardless of ordering.

### R4 — P2: Core recovery resets current public configuration

Source: [default core rendering](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L680).

The missing-core renderer always calls `newEnvironment(DEFAULTS.port, true)`.
It does not read the project's public env example or reconstruct current public
settings from the selected configuration. The database host is also hard-coded.

Reproduced by bootstrapping a standard project on port 4567, deleting only the
core env file, and running recovery with simulated absent persistence. Init
returned success, but the recovered `TAMA_PORT` and issuer used 4000 while the
public example retained 4567.

Required correction: derive public settings from the current selected Compose
configuration and validated project examples. Preserve port/origin settings and
resolve the current database host. Report conflicts or insufficient public inputs
before generating secrets rather than silently falling back to bootstrap defaults.

Acceptance: cover nondefault ports, renamed database services, relocated env
files, and ordered overrides. Recovery must preserve their effective identities.

### R5 — P2: Doctor accepts empty and stale core env files as valid

Source: [existing-file assessment](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L121).

Assessment validates syntax and any present JWK pair, but does not require the
core variables or validate all runtime secret formats, database URL consistency,
and public configuration agreement. Both members of a required JWK pair can be
absent without triggering an issue.

Reproduced twice: an empty mode-0600 core env file was reported `valid` with zero
variables and overall `ok: true`; a core issuer changed to an incompatible port
was also reported valid.

Required correction: extract/reuse shared semantic environment validators that
respect effective Compose overrides. File presence and valid dotenv syntax must
not imply a complete, usable environment.

Acceptance: empty/missing required variables, invalid secrets, database URL
mismatches, absent required keypairs, and stale public identities must yield
actionable, secret-free failures. Expected empty provisioner credentials remain
manual onboarding work rather than a recovery failure.

### R6 — P2: Required interpolated paths disappear from the success decision

Sources: [init reference filtering](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L630)
and [doctor success calculation](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L322).

Both workflows filter out interpolated declarations. Doctor warns about them
but does not include incomplete inspection in its success calculation. Init
does not convert them into a blocker.

Reproduced with a missing required core env declared through a Compose path
containing `${TAMA_REVIEW_ENV_DIR:-./tama}`. Doctor returned `ok: true` with no
files and an interpolation warning. Init returned `ok: true`, no blockers, and
no changes, leaving the required env file absent.

Required correction: explicitly represent incomplete declaration inspection.
Required unresolved references must prevent a healthy diagnosis and block writes;
do not guess ownership from host-dependent paths.

Acceptance: required interpolated paths cannot yield successful completion.
Keep optional references informational, and cover native/fallback Compose behavior.

### R7 — P2: Optional missing files make write behavior disagree with dry-run

Source: [renderer missing-file selection](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L667).

The workflow initially selects only missing required supported files, but the
renderer recomputes its input from every missing reference. Optional application
files consequently reach the unsupported-role refusal during an actual write.

Reproduced by deleting the required PostgreSQL companion and adding a missing
application env declaration with `required: false`. Dry-run reported success and
planned the companion creation; the actual invocation failed because of the
optional application env file. The required companion remained absent.

Required correction: build one validated recovery plan and pass its eligible
required destinations to both preview and rendering. Optional absent files must
neither be created nor block supported recovery. Validate preview inputs without
materializing keys.

Acceptance: optional missing application and supported-role files remain untouched
while required recovery succeeds. Dry-run and write agree on eligibility/blockers.

### R8 — P2: Selectors are not validated and subsequent commands lose selection

Sources: [init selection handling](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L363),
[selection serialization](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/workflows/environment.mts#L575),
and [command construction](https://github.com/kritama/tama-kit/blob/67fdd4900b33fe40aea292dabe92cd76be21a0cb/cli/domain/environment.mts#L179).

The env workflows accept and echo service/env-file selectors without validating
that the selected service exists or loads the selected file. Reproduced with
`--service does-not-exist` and `--env-file not-loaded.env`: dry-run returned success
and no blockers.

After applied recovery, `selectionFromOptions()` omits the project target and
passes `composeFiles` to a command builder that expects `compose`. Reproduced
with a separate target project and two ordered Compose files: the suggested
command was only `tama-kit setup --service tama`, dropping both the target path
and Compose files. Following it from the original directory selects another
configuration.

Required correction: validate service and loaded-file selectors before recovery;
forward the project target and ordered Compose arguments to follow-up commands.
Use the repository's shell-safe command formatting for paths containing spaces
or shell characters.

Acceptance: invalid selectors fail before writes. Guidance preserves the full
target/Compose/service/env-file/contract/provider selection and remains runnable
for paths with spaces.

## Remaining planned scope

- Implement combined and additive MCP App recovery, including host/Compose
  providers, custom bindings, HTTP/HTTPS layouts, partial loss, independent
  signing material, and preservation of surviving keys and overlap state.
  The current explicit refusal is a known implementation boundary, not completion.
- Add init's incomplete-generation gate. Doctor inspects receipt history, but
  init does not route an incomplete generation to its explicit resume operation
  before issuance. Keep receipts as provenance/progress rather than desired state.
- Update README, generated setup guidance, CLI skill/reference material, and
  public examples. Top-level/env help has already been added, but it should
  accurately describe the supported recovery scope.
- Extend installed-package validation to explicitly exercise env help, doctor,
  dry-run, recovery, and repeated no-op behavior. The existing package validator
  passes but does not directly cover the new commands.
- Add recovery-specific rollback/race, path/Git safety, malformed/missing public
  input, and supported-layout regressions, including the findings above.
- Extend isolated runtime acceptance with missing-env recovery and persisted-data
  refusal, and run the supported Node/macOS/Linux matrix. A passing local suite
  does not establish those runtime/platform cases.
- Reconcile the original WIP status/checklist: its header still says implementation
  has not started; manual next actions and preflight are partly implemented;
  checked persistence/create-only guarantees are broader than this snapshot proves.

## Validation performed

| Check | Result |
| --- | --- |
| `npm test` | Passed; its pretest build/typecheck passed. 376 total tests: 375 passed, 1 skipped, 0 failed. |
| `npm run check` | Passed; Biome checked 130 files without fixes. |
| `npm run validate:submission` | Passed: 22 positive and 3 negative cases; `review_ready=false`. |
| `npm run validate:package` | Passed: isolated installed-package ESM/assets, existing command/help/terminal behavior, additive generation/setup, and private-key output checks. |
| `git diff --check a3f3008..HEAD` | Passed. |
| Additional review reproductions | Ten targeted scenarios across R1–R8; temporary generated projects and native Compose parsing, with Docker persistence observations injected. |

The targeted scenarios were custom-port recovery, no-local-mount issuance,
failed Docker state probes, multiple database selection, optional missing input,
empty core diagnosis, stale issuer diagnosis, required interpolated paths,
invalid selectors, and follow-up selection preservation. R2's bind/recheck
extensions and the incomplete-generation gate were identified by source review.

This review did not perform real Tama/Memovee service startup, database recovery,
or the full platform matrix. No implementation source was modified during review.
The existing untracked `.agents/skills/` and `skills-lock.json` were left intact.

## Completion criteria

- [ ] R1–R3 refuse unsafe or unverifiable new issuance and have focused regressions.
- [ ] R4–R8 preserve current configuration and provide accurate inspection/plans.
- [ ] Incomplete generation is routed to explicit resume before recovery issuance.
- [ ] Standard, combined, and additive recovery pass the planned layout matrix.
- [ ] Public guidance and installed-package env command coverage are updated.
- [ ] Isolated runtime acceptance and supported platform checks pass.
- [ ] The WIP checklist accurately records verified completion and remaining work.
