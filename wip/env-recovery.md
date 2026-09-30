# Private environment recovery for issue #41

Status: partial. Standard core/PostgreSQL recovery was merged in
[PR #42](https://github.com/kritama/tama-kit/pull/42). Combined and additive
MCP App HTTP/HTTPS environment recovery is implemented on
`codex/issue-41-mcp-app-env-recovery`, including both-sided persistence checks,
prepared-only new signing material, and public integration examples. See the
[MCP App increment](env-recovery/mcp-app-increment.md) for scope and verification.
Public recovery documentation, installed-package env acceptance coverage, and
isolated runtime/platform fixtures remain open. Issue #41 is not ready to close.

Inspected `kritama/tama-kit` develop at
`a3f3008722be7fc4e962f002ef4606ab467f849c` on 2026-09-29, and
[issue #41](https://github.com/kritama/tama-kit/issues/41).

1. **Keep the proposed commands, and use current project configuration.**

   Proposed interface:

   ```sh
   tama-kit env doctor
   tama-kit env init --dry-run
   tama-kit env init
   tama-kit setup
   ```

   Support the existing project path and relevant setup selectors: ordered,
   repeatable `--compose`, `--service`, `--env-file`, `--contract`, and
   `--provider-service`. Support `--json`, `--non-interactive`, help and color
   conventions; init also supports `--dry-run` and the narrowly defined
   `--fresh` assertion described below. JSON and noninteractive use never prompt.
   Print subsequent setup/doctor commands with the same Compose order and selectors.

   The receipt-driven proposal needs adjustment. Current
   `cli/domain/generation.mts` defines a v2 receipt with only provenance and
   incomplete-generation progress. It deliberately excludes topology, bindings,
   settings and completed-file inventories. The v1 adapter treats legacy metadata
   as history. Keep those contracts: do not restore `managedFiles`, compare
   private files against generation hashes, or make receipts desired configuration.

   Sources of current recovery inputs are:

   - Selected native Compose declarations: services, required env paths, inline
     settings, ordered overrides, database dependencies and data mounts.
   - Project-owned `.tama.env.example` and corresponding integration examples:
     current public settings and explicit secret placeholders.
   - Selected local MCP App contract: exact provider file, role bindings, prefix,
     endpoints and optional HTTPS topology.
   - Surviving private files, read locally: existing database credentials and
     validated key material where needed to derive a missing companion file.

   Receipts may supply a history warning or legacy filename hint, but never
   authorize writing a no-longer-referenced destination. Without a receipt,
   current supported configuration must still work. An incomplete generation
   receipt is a distinct state: route it to explicit generation resume before
   issuing a new environment set; do not silently mark it complete. Malformed
   metadata does not prevent read-only current-file diagnosis.

2. **Extract declaration inspection before effective environment resolution.**

   `cli/bootstrap/current-config.mts` already performs native Compose rendering
   with `config --format json --no-env-resolution`, with a `--no-interpolate`
   fallback for Compose versions that discard declarations. Extract that stage
   into a reusable module, such as `cli/bootstrap/compose-inspection.mts`.
   Preserve native includes, override order, path semantics and Compose tags.
   Do not implement an independent Compose merger.

   Normalize and deduplicate required env paths before calling fully resolved
   Compose config. Track declaring service/source and `required: false`.
   Include host-loaded provider fragments declared by the current contract even
   when no Compose service consumes them. The env inspector checks all selected
   required references; it distinguishes supported Tama files from unrelated
   application files it cannot generate.

   Optional absent env files are informational and are never auto-created.
   Unresolved interpolated paths, missing include-level inputs and unsupported
   native parsing are reported explicitly as incomplete inspection. A bounded
   source scan may identify literal missing-file hints, but those hints cannot
   authorize init or claim to be the merged effective configuration.

   `doctor` and `setup` should stop at this preflight with a safe diagnostic such as:

   ```text
   Missing required private environment files:
     tama/.tama.env
     tama/.tama.postgres.env
     tama/.memovee.integration.env
   Run tama-kit env doctor, then tama-kit env init for a fresh local runtime.
   ```

   Preserve selected flags in suggested commands. Unknown application env files
   get their own project-template/manual instructions. Do not suggest env init
   as a solution for arbitrary Compose syntax failures. Keep stderr and resolved
   Compose environments suppressed; project only filenames, variable names and
   allowlisted failure facts into human and JSON output. Setup currently exposes
   only `details.diagnostic`, so place the structured missing-file details there
   or deliberately extend its public error serializer.

3. **Define env doctor independently of runtime readiness.**

   Add `cli/domain/environment.mts` for typed inspection/recovery results and
   `cli/workflows/environment.mts` for policy. `cli/commands/env.mts` handles
   argument parsing/output; `cli/index.mjs` routes the command.

   Each discovered file should report its role, source and one of: valid,
   missing, invalid, public-configuration conflict, optional-absent, or unsupported
   for automatic creation. Diagnose required variable names, duplicate dotenv
   assignments, JWK/kid pairing, permissions, tracked/unignored secrets, unsafe
   paths, public origins/contract mismatches and core/PostgreSQL consistency.
   Do not compare secrets against example placeholders or old receipt hashes.
   User edits and valid rotations are not inherently stale.

   Empty provisioner credentials are expected after env init. Report them as
   remaining manual work, independently of environment syntax/secret validity.
   Environment completion does not imply healthy services, OAuth activation or
   Terraform provisioning. Docker daemon failure is an unknown persistence
   observation, not proof of a fresh machine; env doctor can still report files.

   Use existing error categories: ownership (4) for missing/invalid required
   private files or blocked replacement secrets, ambiguity (3) for ambiguous
   selections, prerequisite (5) for required unavailable tooling. Optional files
   and pending manual provisioner setup do not make valid environments fail.

   JSON should have a stable result schema, selected configuration, sanitized
   `files`, `persistence`, `changes` and `nextActions`. It must never include env
   contents, private JWKs, secret values, secret-content hashes or setup tokens.

4. **Render a missing environment set without planning other project files.**

   Supported roles include:

   - Core runtime `.tama.env`, including System OAuth and runtime secrets.
   - Derived `.tama.postgres.env`, containing the matching database credentials.
   - Provider fragment at the path declared by the current local contract.
   - Separate `.mcp-app.env` used by additive MCP App generation, as well as the
     combined initial-bootstrap layout.

   The source modules to reuse/refactor are `cli/bootstrap/environment.mjs`,
   `cli/bootstrap/mcp-app.mjs`, `cli/shared/environment.mjs` and
   `cli/shared/oauth-key.mjs`. Extract pure role renderers and validators rather
   than invoking the whole bootstrap or MCP App generator: those workflows plan
   Compose, contracts, public examples and other output, and can propose updates.

   Generate the same material as bootstrap: PostgreSQL password, secret key base,
   vault key, JWT secret, setup token, System OAuth private JWK/kid, and independent
   provider-access-token and Tama-introspection key pairs when MCP App is present.
   Use existing cryptographic generators and quoting/Compose serializers.
   Generate database credentials once and derive every dependent assignment from
   them. Preserve surviving database credentials when reconstructing a companion
   file; conflicting surviving sources stop the operation.

   For newly issued MCP App environments, use prepared mode. Existing files,
   including their modes and key overlap sets, remain byte-for-byte untouched.
   If a surviving enabled/disabled configuration conflicts with the required new
   prepared fragment or shadows it inline, explain the necessary manual mode or
   configuration change and stop instead of modifying the surviving file.

   Reconstruct public identity only from coherent current inputs. Older additive
   HTTP layouts can lose both provider origins when both private fragments are
   absent: their local contract may have no topology, and the core example does
   not contain the additive public settings. Report the missing public inputs;
   never silently use localhost, default ports, prefix guesses or saved v1 topology.

   Going forward, fresh bootstrap/additive generation should emit complete,
   secret-free examples for each non-derived integration fragment, including
   `.mcp-app.env.example` and the provider fragment's `.example` counterpart.
   They contain public values and explicit key placeholders. Preserve existing
   project-owned examples. For older projects, use validated current contract
   topology/surviving files where sufficient; otherwise require a project-owned
   example supplying the missing settings. No receipt schema expansion is needed.

5. **Guard secret issuance against persisted data.**

   Classify each proposed missing file as either derivable from surviving secrets
   or requiring newly issued secrets. A missing PostgreSQL fragment can be derived
   from a valid surviving core environment even with an existing database. A lost
   core env cannot be recovered merely from the PostgreSQL fragment: vault and
   token/signing keys may be irrecoverable.

   Inspect persistence through read-only Docker queries using the selected current
   context/project identity and actual normalized data-volume names. Respect
   explicit/external names and bind mounts. Account for running/stopped containers
   and anonymous/writable-layer data where applicable. Restrict checks to relevant
   Tama/provider database state rather than treating every application or TLS
   mount as runtime data. Named-volume labels alone are insufficient.

   | Observation | Init behavior |
   | --- | --- |
   | All required files already present | No-op; diagnose problems without edits. |
   | Missing file fully derivable from surviving valid secrets | Create the missing derived file; issue no new secrets. |
   | Relevant local runtime data verified absent | Allow fresh issuance for missing supported files. |
   | Relevant persisted runtime data detected | Refuse new secret issuance; explain which files/keys require restoration. |
   | Persistence unknown: daemon unavailable, external DB or unobservable host-provider state | Refuse new issuance by default; allow an explicit `--fresh` assertion only for a known new local runtime, recording that persistence was not verified. |

   `--fresh` is an assertion about unobservable state, not a force-overwrite,
   rotation or destructive-reset option. It never overrides detected data or
   existing files. A new clone directory alone proves nothing about database
   freshness. Existing volumes are conservatively treated as potentially used.

   Diagnostics should explain the concrete consequences: changed PostgreSQL
   credentials can prevent connections; a new `TAMA_VAULT_KEY` can make stored
   encrypted material unreadable; JWT/System OAuth/provider signing keys can
   invalidate stored credentials or issued tokens. Never create placeholders
   claiming lost secrets were recovered. Restore from private backups or follow
   a separately authorized runtime-reset process outside this command.

   To avoid surprising partial success, block the whole invocation when any
   requested required file needs unsafe issuance. A derived-only missing set is
   allowed; do not quietly create some files and leave a blocked signing set.

6. **Apply only exclusive, transactional env-file creates.**

   Preflight the complete set before generating real keys or writing. Dry-run
   performs no secret generation, writes, permission changes, startup or volume
   mutation. It reports the same planned destinations and blockers.

   Check that targets are safe regular-file destinations inside the project and
   effectively ignored/untracked. Refuse symlinks, path escapes, tracked secrets
   and unignored targets; report the necessary manual ignore fix without editing
   `.gitignore`. Existing files are never updated, chmodded, deleted or rewritten.

   Reuse `cli/shared/write.mjs` transactional exclusive-create machinery and
   Git/path checks, retaining the secret-file protections from the OAuth command.
   Every operation passed by this workflow must be `create`, sensitive and mode
   0600. A late-arriving existing file is a conflict, never overwritten. Recheck
   inputs/persistence immediately before commit. A failed write or validation
   rolls back only files created by this invocation, without removing replacements.

   After creates, validate dotenv/key consistency and selected Compose resolution
   without exposing raw output. Do not use the entire current-runtime inspector as
   the only commit validator: missing machine-local CA material is an independent
   blocker on a fresh HTTPS clone. Report missing HTTPS certificates separately
   with native mkcert/recovery instructions. Env init never installs trust,
   starts services, activates OAuth, writes Terraform or changes receipts.

   Return created/preserved paths and next actions: prepare local TLS if missing;
   load the provider env using its application-owned workflow; run setup with the
   same selectors; complete private root/provisioner onboarding; store
   `TAMA_CLIENT_ID`/`TAMA_CLIENT_SECRET` locally; review Terraform init/validate/plan;
   then use the existing staged MCP App activation flow. Never mint provisioner
   credentials or report runtime verification as completed by env init.

7. **Deliver and verify in three increments.**

   - First: extract declaration inspection, add precise setup/doctor preflight
     diagnostics and env doctor. This resolves the opaque-error problem without
     granting new write behavior. Prefer shipping together with init so the
     suggested command exists; a standalone diagnostic release should suggest
     the currently available manual remedy until init ships.
   - Second: implement core/PostgreSQL recovery, persistence policy and
     transactional create-only init; then combined/additive MCP App recovery
     through the same workflow. Complete public integration examples and old-layout
     missing-input diagnostics before considering issue #41 finished.
   - Third: update README, generated setup guidance, `skills/tama-kit-cli/SKILL.md`,
     its CLI reference, command help, installed-package validation and CI fixtures.
     Keep compiled `.mjs` distribution/build conventions intact.

   Add focused `test/cli/env.test.mjs` coverage plus shared Compose/current-config
   regressions. Required cases:

   - A bootstrap fixture cloned with all ignored private env files omitted;
     reconstruct a valid set while tracked-file snapshots remain unchanged.
   - Standard runtime, combined MCP App, additive HTTP/HTTPS, host/Compose provider,
     custom bindings, moved files, renamed services and ordered overrides/includes.
   - Missing optional and unsupported application files; unresolved interpolation;
     missing/stale public inputs; absent/malformed/v1/v2/incomplete receipts.
   - Database URL/password agreement; independent valid keypairs and stable
     JWK/kid pairs; surviving keys/modes/overlap sets retained unchanged.
   - One missing derived DB fragment with persisted data succeeds without new
     secrets; missing core/provider signing material with data fails before writes.
   - Named/custom/external/anonymous volumes, relevant bind data, stopped containers,
     unavailable daemon and host-provider unknown state; `--fresh` cannot bypass
     detected data. Test these with injected observations, then isolated Docker
     integration fixtures.
   - Repeat init no-op; invalid existing files never rewritten; dry-run creates no
     keys; JSON/noninteractive never prompt; errors/output expose no secret values.
   - Symlinks/path escapes, tracked/unignored files, mode 0600, late destination
     races, changed inputs and mid-transaction failure/rollback.
   - Setup/doctor name the actual missing references and carry actionable commands;
     unrelated config errors remain correctly classified; missing TLS is separate.

   Run the repository's build/typecheck, Biome, full test suite, submission and
   installed-package checks. Extend bootstrap runtime CI with isolated missing-env
   recovery plus persisted-volume refusal; do not exercise recovery against a real
   Memovee database. Validate the existing macOS/Linux and Node support matrix.

   Completion maps directly to all five issue criteria: current required-file
   diagnosis, create-only generation, persisted-data refusal, manual credential
   next actions, and actionable setup/doctor errors. Update the issue's receipt
   wording to current-configuration wording when implementation is reviewed.

Acceptance checklist:

- [x] `env doctor` reports missing required private environment files from current
  Compose declarations and the selected MCP App contract, with actionable details.
  Empty, semantically invalid, and stale public identities fail. Required
  unresolved interpolation prevents a healthy result.
- [x] `env init` creates only missing supported files, preserving every existing
  file and keeping database credentials consistent across generated companions
  across standard core/Postgres and combined/additive MCP App HTTP/HTTPS layouts.
  Public port, origin, and database host come
  from the project example and effective Compose configuration, or issuance stops.
- [x] Secret issuance is refused when relevant persisted data is detected, when
  the Tama database cannot be associated, or when a probe fails. Unknown
  persistence, including no local mount, requires `--fresh`. `--fresh` never
  overrides detected data or an ambiguous database association. An unverifiable
  recheck rolls the write back.
- [x] Output includes the remaining private setup and provisioner-credential steps
  without exposing secrets or claiming runtime readiness. Follow-up commands keep
  the target path and ordered Compose/service/env-file selection.
- [x] `doctor` and `setup` identify missing files and suggest the appropriate env
  recovery command while retaining the caller's configuration selection. Required
  unresolved interpolation is named instead of guessed.
- [x] Standard, combined and additive MCP App layouts pass recovery regressions,
  including partial loss, repeat invocations, dry-run and transactional failure.
  New integration signing material requires prepared peers and safe persistence;
  older layouts without enough public inputs get actionable blockers.
- [ ] Public examples, CLI help, skills, package validation and isolated runtime
  checks are updated and pass the repository's supported platform matrix.
