# Private environment recovery review 03

Date: 2026-09-29

Status: review 02 reproductions and review 03 findings G1–G2 resolved in the current worktree

Original review target: `/Users/zacksiri/Development/_kritama/tama-kit`, branch
`feature/issue-41-env-recovery`, at
`61d890c4326b282560e082a28102d3822ed67fcc`.

Compared against
[review 02](/Users/zacksiri/Development/_kritama/tama-kit/wip/env-recovery/review-02.md)
at `ad92a55716f4f645e7d30e98c070b5c03634dc3b` and the
[implementation plan](/Users/zacksiri/Development/_kritama/tama-kit/wip/env-recovery.md).

## Outcome

The five concrete reproductions from review 02 now behave correctly. The latest
commit adds six regressions, and the full suite passes. At that snapshot,
additional validation of effective env-file precedence and credential
serialization found the two defects recorded below. Both are now fixed in the
worktree, with eleven further regressions. Broader issue #41 acceptance remains
open, so the issue is not ready to close.

## Review 02 verification

| Finding | Verified result at this snapshot | Qualification |
| --- | --- | --- |
| F1: Docker failure hides bind data | Nonempty bind data is detected even during the simulated daemon outage; init refuses issuance with `--fresh`, records no fresh assertion, and creates no core file. | Positive observations now take priority over unknown observations. The new regression also covers an unreadable bind and failed volume probe alongside detectable state. |
| F2: inline external `DATABASE_URL` ignored | The inline override is recognized as external; conflicting example settings block issuance, persistence is unknown, and no core file is created. | Later env-file overrides are still missed; see G1. |
| F3: matching multiple origins rejected | Identical multi-origin settings now pass doctor. Regression coverage accepts reordered/whitespace-varied lists and rejects a missing expected origin. | Resolved for the reported case. |
| F4: preview skips credential refusal | The original dotted username is now supported in preview and write. New regression coverage refuses an unsafe username in both modes before creating the core file. | Serialization of accepted URL-sensitive credentials remains incorrect; see G2. |
| F5: malformed receipt hides later incomplete state | Malformed first history is retained as a warning, the valid incomplete second receipt blocks recovery, and no PostgreSQL companion is created. | Regression coverage also verifies that a complete second receipt permits recovery. |

The existing selector/follow-up fixture was rechecked: the setup command still
preserves the target, ordered Compose files, service, and selected env file, and
an invalid service is refused.

## Follow-up verification

The fixes below were verified against changes based on `61d890c`. The original
reproductions and findings are retained as historical evidence.

| Finding | Corrected behavior |
| --- | --- |
| G1: env-file database overrides ignored | Native Compose resolves the selected service's ordered env files and inline settings. Missing core layers use temporary non-secret variable markers to preserve precedence and detect dependencies on unknown credentials. Later external overrides block both preview and write, including with `--fresh`; doctor rejects conflicting effective settings. Earlier overrides are superseded by recovery, and matching local or inline overrides use the associated local database's persistence checks. Empty/unset inputs, unresolved dependencies, and credential disagreements fail closed. |
| G2: accepted credentials yield an invalid URL | A shared serializer encodes username, password, and database components. Deterministic URL and credential agreement checks run before preview or key generation. Accepted slash/plus credentials round-trip and pass doctor, while database names normalized by URL parsing are refused consistently. Malformed percent encoding produces a safe diagnostic. |

Recovery checks input digests before and after writes. It also validates the
generated core and the final effective Compose environment inside the write
transaction, rolling back if validation fails. Existing private files remain
unchanged. Native resolution captures stdout/stderr privately and never returns
environment values in command results; temporary markers are cleaned up and
contain no generated secrets.

Native parsing follows Docker's documented
[env-file precedence and formats](https://docs.docker.com/reference/compose-file/services/#env_file).
The resolver also removes one layer of Compose's
[rendered dollar escaping](https://github.com/docker/compose/blob/v2.24.0/cmd/compose/config.go#L132)
so literal dollars in raw files remain intact.

Regression coverage includes ordered Compose overrides, earlier/later env-file
layers, inline precedence, quoted and raw env-file parsing, empty/unset values,
dependencies on missing secrets, local persistence detection, credential
conflicts, encoded URL components, invalid encoding, and changing source inputs.

Independent review 03 reproductions now confirm:

- Later external `DATABASE_URL`: init fails, persistence is `unknown`, no local
  volume is treated as authoritative, no core is created, and doctor fails.
- Surviving password containing `/`: preview and write succeed, the recovered
  URL parses, and doctor succeeds.

Review 02's five reproductions and selector guidance were also rerun successfully.

## Confirmed findings at the original snapshot (now resolved)

### G1 — P1: Later env-file database overrides still authorize issuance against the wrong database

Original source: [effective input selection](https://github.com/kritama/tama-kit/blob/61d890c4326b282560e082a28102d3822ed67fcc/cli/workflows/environment.mts#L958).

`publicIdentityFor()` now includes the selected service's inline `environment`,
but not the effective settings from its ordered `env_file` declarations. A
surviving file loaded after the missing core file can override `DATABASE_URL`
without participating in public identity or persistence association.

Reproduction:

1. Create a standard bootstrap fixture and leave its example and local database
   declarations unchanged.
2. Add a mode-0600 `runtime.env` containing a fixture `DATABASE_URL` pointing to
   `external.example`.
3. Declare Tama's env-file order as `.tama.env`, then `runtime.env`.
4. Remove the core env and run init without `--fresh`, with simulated absent local
   Docker persistence.
5. Resolve full native Compose configuration after recovery and run env doctor.

Observed results: init returns `ok: true`, persistence `absent`,
`freshAsserted: false`, and creates new core secrets. It inspects only the local
Tama volume. Full native Compose confirms that the effective Tama connection
still points to `external.example`, while env doctor also returns `ok: true`.

The external database was never inspected. Absence of the local database cannot
authorize new vault/JWT/OAuth material for an unverified effective external
database. The inline fix does not cover the equivalent env-file configuration.

Required correction: derive effective settings using every loaded env-file layer
in native Compose order, followed by inline settings. Preserve Compose parsing
and override semantics; refuse issuance when authoritative settings or their
agreement with public inputs cannot be established. Doctor must assess those
effective settings as well. An example must not stand in for a later surviving
override file.

Acceptance: cover later local/external database overrides in env files, ordered
Compose overrides, and inline settings overriding those files. The database
actually used by the selected service must control persistence authorization;
conflicts or unverifiable effective settings must block writes before issuance.

### G2 — P2: Accepted surviving credentials can produce an invalid database URL

Original sources: [credential eligibility](https://github.com/kritama/tama-kit/blob/61d890c4326b282560e082a28102d3822ed67fcc/cli/workflows/environment.mts#L744)
and [database URL construction](https://github.com/kritama/tama-kit/blob/61d890c4326b282560e082a28102d3822ed67fcc/cli/workflows/environment.mts#L827).

`SAFE_CORE_VALUE` permits `/`, but the renderer interpolates the username,
password, and database name directly into `DATABASE_URL` without URL encoding.
Characters that are safe in a dotenv assignment are not necessarily safe in
the URL's authority or path components.

Reproduction: in a standard fixture, change the surviving PostgreSQL password
to the synthetic value `abc/def`, remove the core env, and run preview and write
with simulated absent persistence. Both invocations report success, and the
write creates a core file. Its database URL cannot be parsed by `new URL()`;
subsequent env doctor returns failure with `DATABASE_URL is not a valid URL`.

Required correction: use shared component-aware URL serialization for the
username, password, and database name. Validate the deterministic rendered URL
and its decoded credential agreement before both preview and issuance. Do not
report successful completion for a file that the semantic validator immediately
rejects. If a credential cannot be supported, refuse it consistently in both
modes before generating keys.

Acceptance: cover `/` and other supported URL-sensitive credential characters.
Every accepted recovered URL must parse, decode to the surviving credentials,
and pass doctor; refused cases must agree between preview and write.

## Original review validation and limits

| Check | Result |
| --- | --- |
| `npm test` | Passed, including pretest build/typecheck: 394 total, 393 passed, 1 skipped, 0 failures. |
| `npm run check` | Passed: 130 files checked, no fixes applied. |
| `npm run validate:submission` | Passed: 22 positive and 3 negative cases; `review_ready=false`. |
| `npm run validate:package` | Passed: existing installed-package checks. |
| `git diff --check ad92a55..HEAD` | Passed. |
| Independent reproductions | Review 02's five cases and selector guidance rerun; both additional cases above confirmed in temporary fixtures. |

The independent fixtures used native Compose parsing with injected Docker
persistence results. G1's effective database host was also confirmed with a full
native Compose render after recovery. No external database was contacted and no
real Tama/Memovee runtime was started by these reproductions. They do not establish
live runtime or platform-matrix acceptance. Implementation source was left unchanged
during that original review; the follow-up above now includes source fixes.

## Follow-up validation and limits

| Check | Result |
| --- | --- |
| `npm test` | Passed, including build/typecheck: 405 total, 404 passed, 1 skipped, 0 failures. Eleven new env regressions. |
| `npm run check` | Passed: 130 files checked, no fixes applied. |
| `npm run validate:submission` | Passed: 22 positive and 3 negative cases; `review_ready=false`. |
| `npm run validate:package` | Passed: existing installed-package checks. |
| `git diff --check` | Passed. |
| Independent reproductions | Both review 03 cases and all review 02 cases verified against the fixes. |

These checks use native Compose parsing and injected Docker persistence results.
They do not establish live runtime or platform-matrix acceptance.

The remaining planned scope is still open: combined/additive MCP App recovery,
public README/generated/skill guidance, explicit installed-package env command
coverage, isolated recovery/persistence runtime acceptance, and supported platform
checks. The WIP accurately retains an overall partial status.

## Follow-up checklist

- [x] Review 02's concrete F1–F5 reproductions behave correctly.
- [x] G1 uses all effective env-file/inline layers for identity and persistence decisions.
- [x] G2 serializes and validates accepted credentials as URL components before issuance.
- [ ] Remaining issue #41 layout, documentation, package, runtime, and platform acceptance passes.
