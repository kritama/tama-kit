# Node CLI cleanup

Tracking: kritama/tama-kit#20; stages #21–#25.

## Baseline and delivery

Start at v0.4.4, commit 6ebbfe6e374a842f619de0a88b11805f66dfbceb.
Use focused commits on feature/cli-cleanup and one PR to develop. Node and npm
remain the runtime and distribution. Related feature work (#15–#19) remains
separate; preserve it when integrating changes from develop.

The review passed lint/type checks and 260 tests with one skipped on macOS,
Node 24, with a canonical temporary root. This is regression evidence, not live
Docker/provider acceptance. Record final validation separately below.

## Current architecture

bin/tama-kit.mjs delegates to cli/index.mjs, which dispatches bootstrap (init
alias), dev setup, and oauth generate-key. Bootstrap owns argument parsing,
interactive choices, terminal rendering, planning, file writes, Compose startup,
MCP verification, activation, and recovery. cli/bootstrap contains filesystem,
Git, environment, RSA/JWK, manifest, Compose, Terraform, contract, and topology
code. Dev imports reusable bootstrap helpers. The transactional writer imports
the OAuth command's exclusive secret writer. Terraform inspection is shared with
the graph-builder skill script. These are the primary dependency boundaries to
improve; graph authoring behavior and application integration features are not
part of this change.

## Target boundaries

- cli/commands: argument parsing, interactive choices, result rendering.
- cli/workflows: plan/write/start and activation/recovery orchestration, with
  injectable process/network/file effects and progress callbacks.
- cli/domain: validated provider contract types and lifecycle decisions. Treat
  untrusted documents as unknown until existing runtime validators accept them.
- cli/shared: file operations and transactions, exclusive secret creation, Git
  safety, reusable environment/crypto primitives, and child-process mechanics.
- cli/bootstrap and cli/dev: their specific configuration planning, migrations,
  templates, and runtime adapters. Do not consolidate different environment
  syntaxes or workflow policies merely because they have similar names.

Shared modules must not import command handlers or workflow-specific modules.
Commands call workflows; workflows call domain/planning modules and adapters.
Move code mechanically first, then improve types and transition boundaries.

## Compatibility inventory

Preserve commands/aliases/options/help, exit codes, human output and progress,
interactive decisions, deterministic JSON envelopes, and secret redaction.
Preserve the npm bin entry, template/skill/contract lookup, all generated paths
and bytes, manifest/contract schemas, hashes, ownership, and existing migrations.
Preserve dry-run behavior, unchanged reruns, ignored/untracked private files,
exclusive writes, canonical-path checks, modes, drift refusal, and rollback.
Keep production crypto validation, accepted algorithms/key formats, and negative
protocol probes unchanged. Never rotate secrets to simplify a migration.

Public output and internal plans have different guarantees: operations can carry
secret content, but public projections cannot. Static loader evidence does not
establish live provider readiness. Observed runtime state is not a desired state.

## Activation and recovery

Provider and Tama have independent disabled/prepared/enabled states. Bootstrap
can prepare configuration without starting services. Activation first verifies
prepared state, then enables and verifies Tama while the provider stays prepared.
The operator changes/restarts the provider and reruns activation; only a verified
pair of enabled services completes activation. Already-enabled reruns verify the
same checkpoint. Keep exact public OAuth identities separate from routing.

File transaction rollback restores pre-write files after validation fails.
Runtime compensation explicitly plans prepared configuration and restarts Tama;
it does not claim to restart the operator-owned provider. Centralize this action
without hiding an original failure if recovery also fails. Exercise failed
startup, failed verification, failed recovery, and the provider-restart handoff.

## TypeScript and packaging

Keep .mjs for existing JavaScript and use .mts for migrated types/workflows/domain
modules. Emit their .mjs counterparts beside source, preserving relative paths
and ESM imports. Generated counterparts are ignored by Git and excluded from
lint/source enumeration. Published npm packages include emitted .mjs and assets
but exclude .mts. No runtime loader, user-side build, or additional runtime
library is required. Typecheck the mixed sources before emitting; build before
tests and packing. Verify a tarball installed without development dependencies.

Validated documents expose precise types at the validator boundary. Keep runtime
validation for external JSON, including semantic cross-field checks. Use tagged
unions for lifecycle decisions and exhaustive switches instead of new combinations
of optional booleans. Preserve internal exports needed during staged migration.

## Commit and verification sequence

1. Design and baseline (#21).
2. Shared infrastructure extraction (#22): existing file/crypto/dev tests plus
   lint/typecheck and dependency-direction checks.
3. Workflow extraction (#23): output compatibility and isolated transition and
   recovery tests, preserving existing live probes.
4. Typed domain/workflows and build wiring (#24): strict typecheck, runtime
   validators, build, and installed-package smoke checks.
5. Test organization/platform/package gates (#25): canonical fixture roots,
   Linux/macOS and minimum/primary Node coverage, full regression suite,
   submission validation, package installation, and applicable isolated runtime
   integration scripts. Keep CI trigger policy intact.

Large suites should split along responsibilities, retaining original assertions.
Use fixtures for environment construction, not mocks that repeat implementation.
Add fault-injection tests where extraction exposes a previously untested recovery
boundary. No release publication or provisioning against user environments.

## Final validation

Pending implementation. Record commands, runtime/platform, skips, live-runtime
outcomes, and remaining limitations here before the final PR.
