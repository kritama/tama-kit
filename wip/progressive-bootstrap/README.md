# Progressive bootstrap

Deliver issues #15–#18 and #27–#30 on `feature/progressive-bootstrap` in one
PR to `develop`. Issue #19 remains the end-to-end Memovee acceptance tracker.
Baseline: `471fb41` (current develop). No application repositories are edited
as part of the CLI implementation.

## Implementation sequence

1. Add explicit host/Compose provider topology inputs. Validate the selected
   application-owned service, record effective routing and dependencies, and
   generate all Tama-owned output reproducibly. This is the smallest extension
   interface for #15/#16; no arbitrary Caddy overlays or manifest hash editing.
2. Preserve bounded, sanitized startup diagnostics and expose shared setup
   phases/next actions (#17/#18).
3. Add a terminal input resolver and preview/edit/execute flow (#27/#28), then
   conditional MCP App configuration and migration questions (#29).
4. Reuse persisted configuration and existing activation workflows for
   continuation (#30). Keep external provider/browser/Terraform steps explicit.
5. Validate unit/workflow behavior, installed package, and isolated runtime
   scenarios; report live Memovee acceptance separately from fixture evidence.

## Contracts

Keep flag and JSON automation compatible; an explicit non-interactive option
bypasses questions. TTY bootstrap/init use questions, with supplied flags
authoritative and valid recorded choices reused. Questions and previews have
no writes, key generation, CA installation, or service starts. Cancelling is
a normal exit. Revalidate before execution and retain transactional writes.

Public OAuth identities remain HTTPS provider/Tama origins. Docker service
names are private routing only. Provider code, Dockerfiles, listener settings,
and lifecycle restarts remain application-owned. Managed-file drift, secret
custody, foundation ownership, and activation verification remain enforced.
No automatic Terraform apply, credential creation, publication, or user-runtime
modification is part of implementing this feature.

## Progress and validation

- Git Flow feature created from current develop.
- Initial #15/#16 implementation: explicit Compose provider selection, shared
  default-network validation, generated Caddy routing/dependencies, persisted
  reruns, prepared-only migration, and selected-service loader evidence.
- Tests cover host/Compose planning, clean reruns, drift, missing/symlinked
  services, provider/Tama enabled-mode refusal, preserved signing material,
  health-check changes, and transactional rollback.
- Both generated topologies pass real `docker compose config --quiet` using
  isolated temporary projects.
- Terminal questions now cover project/Compose selection, setup mode, skills,
  ports, images, contracts, provider identity, HTTPS origins, provider topology,
  and explicit migrations. A secret-free review offers edit, prepare, start,
  staged activation, and cancellation. Flag and JSON callers share the planner.
- Bare reruns reuse saved Compose/image/topology/identity/skills and preserve
  configured lifecycle modes. Status distinguishes configured state from live
  verification; shared next actions and the generated checklist cover external
  browser, provider-loader/restart, Terraform, and OAuth client steps.
- Plans are revalidated before execution, after CA consent, and immediately
  before transactional writes. Changed contracts and ownership evidence are
  re-read before execution. Prerequisite/startup failures can be retried with
  a fresh review in the same session.
- Initial #17 implementation: bounded stderr capture with an allowlisted
  diagnostic projection and a stable single JSON startup-error envelope.
- Local checks: build/typecheck, Biome, submission and skill validation,
  installed-package validation, and `git diff --check` pass. Full suite:
  300 passed, one existing root-only test skipped. HTTP/TLS tests require
  loopback access. Installed-package validation now uses Python 3's standard
  library PTY support on macOS/Linux to test preview, Ctrl-C, and EOF without
  project writes or development dependencies in the installed consumer.
- Real isolated Docker runs pass for both host-native and Compose-managed
  fixture providers, including prepared verification, Tama activation, the
  provider-owned restart handoff, and verified enabled state. Test CAs use an
  isolated CAROOT; host trust stores and application repositories are unchanged.
  The Compose-provider runtime scenario is included in CI.
- Draft PR #31 is the single delivery PR. Clean Memovee adoption, Terraform
  provisioning, and a complete OAuth MCP-client connection remain #19 acceptance
  work; fixture runtime evidence does not claim those steps are complete.
