# Private environment recovery review 02

Date: 2026-09-29

Status: original reproductions corrected; two P1 and three P2 follow-ups remain

Review target: `/Users/zacksiri/Development/_kritama/tama-kit`, branch
`feature/issue-41-env-recovery`, at
`ad92a55716f4f645e7d30e98c070b5c03634dc3b`.

Reviewed fix commit: `ad92a55 Fix unsafe issuance and inaccurate environment recovery`.

Compared against
[review 01](/Users/zacksiri/Development/_kritama/tama-kit/wip/env-recovery/review-01.md)
at `67fdd4900b33fe40aea292dabe92cd76be21a0cb` and the
[implementation plan](/Users/zacksiri/Development/_kritama/tama-kit/wip/env-recovery.md).

## Outcome

The original failure scenarios now behave as intended. The fix commit adds
12 env regression tests, including unknown persistence, failed probes, final
recheck rollback, multiple databases, nondefault ports, semantic core checks,
interpolation, optional files, selectors, and incomplete generation.

The broader acceptance requirements are still only partly satisfied. Additional
temporary fixtures reproduced two unsafe issuance paths and three correctness
gaps. Issue #41 is not ready to close, and the new-secret issuance path needs
the P1 corrections below before it can be considered safe.

## Review 01 verification

| Finding | Verified correction | Remaining qualification |
| --- | --- | --- |
| R1: no local mount bypasses `--fresh` | Without a local mount, init now refuses issuance without `--fresh`; an assertion is recorded when supplied. | Fixed for the original case. |
| R2: failed probes become absent | Failed volume probes now report unknown, unreadable binds have an unknown state, and an absent-to-unknown recheck without `--fresh` rolls back. | Early unknown returns still skip available positive evidence; see F1. |
| R3: first database selected by order | The two-database reproduction now inspects the Tama database and refuses when its simulated volume exists. | Effective inline database settings remain ignored; see F2. |
| R4: default port resets configuration | A project bootstrapped on port 4567 now recovers that port and issuer, preserving its example. | Current Compose environment overrides are not incorporated; see F2. |
| R5: empty/stale core accepted | Empty core files and stale issuers now fail with semantic/public-configuration diagnostics. | Matching origin lists can be rejected; see F3. |
| R6: required interpolation omitted | Required interpolated references now fail doctor and block init; optional references remain informational. | Fixed for the original case. |
| R7: optional files block recovery | Missing optional application files no longer block required companion recovery; preview and write agree for that case. | Other renderer-only validation still makes preview inaccurate; see F4. |
| R8: selectors/guidance lose selection | Invalid service/env-file selections fail, and setup guidance retains the target, ordered Compose files, service, and env-file selection. Quoting coverage includes a path with spaces. | Fixed for the original cases. |

The previously missing incomplete-generation gate is also present and has a
positive regression. It still skips later receipts when an earlier receipt is
malformed; see F5. The original WIP header/checklist has been updated to acknowledge
partial implementation and the remaining MCP App/docs/package/platform scope.

## Remaining confirmed findings

### F1 — P1: `--fresh` can bypass existing bind-mounted data during a Docker failure

Source: [early unknown returns in persistence inspection](/Users/zacksiri/Development/_kritama/tama-kit/cli/bootstrap/persistence.mts:226).

`inspectPersistence()` returns unknown immediately when Docker is unavailable,
or when a volume/container probe fails. Bind paths are checked only afterward.
An available, nonempty local database directory therefore goes uninspected,
and the unknown-state policy permits issuance with `--fresh`.

Reproduction: a standard runtime with its PostgreSQL data bind-mounted from
`./data`; that directory contains a fixture `PG_VERSION` file. Remove the core
env, inject a Docker version failure, and run init with `fresh: true`. Init
returns `ok: true`, `status: unknown`, `freshAsserted: true`, an empty checked
list, and creates a new core env despite the existing bind data.

Required correction: inspect filesystem binds independently of daemon availability
and collect positive observations before settling on unknown. Continue other
available probes when one fails. Any observed data must produce detected state,
which `--fresh` cannot override.

Acceptance: cover a nonempty bind with daemon failure, a failed volume probe with
a detectable container/bind, and an unreadable bind preceding a nonempty bind.
Every available positive observation must block issuance, including with `--fresh`.

### F2 — P1: Effective inline database settings are ignored by issuance authorization

Sources: [public identity inputs](/Users/zacksiri/Development/_kritama/tama-kit/cli/workflows/environment.mts:918)
and [database association](/Users/zacksiri/Development/_kritama/tama-kit/cli/bootstrap/persistence.mts:121).

Public identity comes from the example, port publication, and services loading
the PostgreSQL companion. It does not incorporate the selected Tama service's
inline Compose environment. The persistence association consequently uses the
example's database host even when Compose overrides `DATABASE_URL`.

Reproduction: retain a standard bootstrap example and local PostgreSQL declarations,
but add inline `DATABASE_URL` on Tama pointing to `external.example`. Remove the
core env and inject absent local Docker persistence. Init without `--fresh`
reports verified-absent state and creates new vault/JWT/OAuth material after
checking only the local Tama volume. The recovered file names `tama-postgres`,
while the effective service still connects to the external database.

The external database was never inspected. Its existing encrypted material and
credentials may depend on the lost keys, so an empty unrelated local volume
cannot authorize new issuance.

Required correction: incorporate native Compose's effective inline settings and
precedence into public identity and database association. Refuse conflicting
example/current settings before issuing secrets. Explicit external connection
settings must not be treated as verified local absence because stale dependency
or companion declarations remain present.

Acceptance: exercise external/local `DATABASE_URL` overrides and public identity
overrides through ordered Compose files. The selected effective database must
control the persistence decision; unresolved conflicts block writes.

### F3 — P2: Identical multi-origin settings are rejected by doctor

Source: [allowed-origin comparison](/Users/zacksiri/Development/_kritama/tama-kit/cli/domain/environment.mts:476).

The core origin setting is split into individual origins, but the example's
whole comma-separated string is used as a single expected origin. `includes()`
cannot find that combined string in the parsed list.

Reproduction: set both the private core and its example to
`TAMA_MCP_ALLOWED_ORIGINS=http://localhost:4000,http://localhost:5173`. All other
settings remain healthy. Doctor returns `ok: false` and
`public-configuration-conflict` although the two origin lists match.

Required correction: parse and normalize both lists, then apply the intended
origin agreement rule to individual entries. Do not compare a serialized list
to one list member.

Acceptance: matching multiple origins and insignificant whitespace are accepted;
missing required origins still produce an actionable failure.

### F4 — P2: Dry-run still skips validation performed only by the renderer

Sources: [write-only rendering](/Users/zacksiri/Development/_kritama/tama-kit/cli/workflows/environment.mts:546)
and [surviving credential validation](/Users/zacksiri/Development/_kritama/tama-kit/cli/workflows/environment.mts:782).

Optional eligibility is corrected, but renderer validation still runs only during
the write invocation. A successful preview therefore does not guarantee that the
same inputs are eligible to be rendered.

Reproduction: use `custom.user` as the surviving PostgreSQL username and in the
public example, then remove the core env. Dry-run returns success with no blockers.
The write invocation throws that the surviving credentials cannot be re-emitted
safely, because its renderer uses a narrower character rule. It creates no file.

Required correction: run shared input/renderability validation before both preview
and write, without generating keys in preview. Either support the credential
through safe serialization or consistently report its refusal in both modes.

Acceptance: every deterministic renderer refusal must also appear in dry-run.
Include surviving credential formats and missing supported-but-unrenderable roles.

### F5 — P2: A malformed first receipt suppresses a later incomplete-generation gate

Source: [receipt error branch](/Users/zacksiri/Development/_kritama/tama-kit/cli/workflows/environment.mts:937).

The receipt loop returns null when the first receipt cannot be parsed. It does
not continue checking the second receipt slot. A malformed bootstrap receipt
can therefore suppress a valid incomplete additive receipt.

Reproduction: place malformed JSON in `.tama-kit.json` and a valid v2 receipt
with incomplete progress in `.tama-kit-mcp-app.json`. Independently reading the
second receipt confirms its incomplete state. Remove the PostgreSQL companion
and run init: it returns success with no blocker and creates the file instead
of requiring generation resume.

Required correction: malformed optional history must not stop inspection of the
remaining receipt slots. Continue the loop while retaining a warning, and honor
any valid incomplete receipt before recovery writes.

Acceptance: malformed/legacy/absent first receipts cannot hide an incomplete
second receipt. Valid complete receipts continue to permit supported recovery.

## Validation and limits

| Check | Result |
| --- | --- |
| `npm test` | Passed, including pretest build/typecheck: 388 total, 387 passed, 1 skipped, 0 failures. |
| `npm run check` | Passed: 130 files checked, no fixes applied. |
| `npm run validate:submission` | Passed: 22 positive and 3 negative cases; `review_ready=false`. |
| `npm run validate:package` | Passed: existing installed-package checks. |
| `git diff --check 67fdd49..HEAD` | Passed. |
| Independent reproductions | Original eight fixture scenarios rerun; selector/guidance cases rechecked; five additional failure cases confirmed. |

Fixtures were temporary generated projects using native Compose configuration
parsing with injected Docker persistence results. F1 used a real temporary
nonempty bind directory, with a simulated daemon outage. No real external database
was contacted, and these results do not establish live runtime or platform-matrix
acceptance. No implementation source was changed by this review.

Remaining planned scope is unchanged: combined/additive MCP App recovery, public
README/generated/skill guidance, explicit installed-package env command coverage,
isolated recovery/persistence runtime acceptance, and supported platform checks.

## Follow-up checklist

- [ ] F1 detects available positive persistence evidence before allowing `--fresh`.
- [ ] F2 uses effective database/public settings and refuses uninspected conflicts.
- [ ] F3 compares allowed origins as lists.
- [ ] F4 validates the same inputs in dry-run and write without preview key generation.
- [ ] F5 checks all receipt slots even when one is malformed.
- [ ] The remaining issue #41 layout, documentation, package, and runtime acceptance work passes.
