# Operational invariants

Separate static configuration from deployed execution evidence.

## Global foundation

- Identify exactly one Terraform-state owner for the global space, schemas,
  corpora, and validation behavior.
- Treat `upmaru/base/tama` without a `//modules/...` suffix as the root
  foundation module; do not confuse helper-module calls with the foundation.
- Verify every `module.global` reference resolves to a declared module and an
  output present in the installed root-module version.
- Verify global schema keys and corpus outputs consumed by helpers and raw
  resources rather than assuming every base-module version exports them.
- Treat a missing declaration referenced as `module.global` as blocking
  incomplete configuration.
- Treat multiple states attempting to create the same global foundation as a
  blocking ownership and lifecycle risk.
- When an explicitly documented external state owns the foundation, classify
  deployment order and remote availability as runtime prerequisites rather
  than recommending a duplicate module.

## Versions and module interfaces

- Read `.terraform.lock.hcl` for the locked provider version.
- Read `.terraform/modules/modules.json` for installed helper versions and source directories.
- Inspect installed variables, outputs, and resource implementations for changed helpers.
- Do not assume a nearby base-module checkout matches the installed version.
- Treat uninitialized or missing modules as an inspection limitation, not a graph defect by itself.

## Models and processors

- Each model-backed thought has a processor using an available model ID.
- Tooling behavior specifies compatible tool choice and retry parameters.
- Router output properties match the class schema expected by its module.
- Temperature and model parameters match the deterministic or generative role.
- Each structured generation thought materializes a user message when required by the installed runtime.
- Runtime corpora reach the final provider messages; context inputs alone do not prove payload insertion.
- For Tama versions using the `Contexts.Corpus` marker contract, the user prompt contains `{{ corpus }}` on a standalone line.

## Actions, sources, and identities

- Each action resolves from the intended specification, method, and path.
- Each `tama/actions/caller` module input renders the complete runtime request-argument envelope rather than only the intended HTTP payload.
- For runtimes that extract top-level `path`, `query`, and `body`, verify those exact keys against the action's OpenAPI parameters and request body.
- Treat a JSON POST that reaches the server without `Content-Type` as evidence that the rendered caller arguments may lack `body`; inspect the persisted action-call parameters before changing the server.
- Source identity validation is configured without committed secrets.
- Source rate limits match the intended API and are not silently shared across different quotas.
- Action modifiers preserve identifiers consumed by downstream relations and indexes.

Credentials, API availability, and successful validation are runtime evidence.

## Queues, retries, and awaits

- Faculty queue IDs exist and priorities match the workload.
- Retry codes and limits are bounded.
- Non-idempotent side effects are not retried without a deduplication contract.
- Awaited relations have real producers and bounded attempts/time windows.
- Failure to produce an awaited relation has an intentional outcome.
- Inspect whether the installed runtime resolves faculty queues only at boot. If a queue was provisioned after worker startup, require reload or restart evidence before concluding that its jobs can be consumed.

When an entity remains `processing` and no Flow or Step appears, inspect the
entity job, its queue, the worker's subscribed queues or node roles, and the
relative provisioning and worker-start timestamps. A declared reactive node
proves graph topology, not that the running worker has loaded a newly
provisioned queue.

Worker capacity, queue consumption, and processing latency are runtime evidence.

## Preloads and pruning

- Initializers are unique by `(thought_id, class_id, reference)`; multiple resource requests for one import anchor share one initializer.
- Initializer class IDs select resources present before initialization rather than the resources being imported.
- Preloader class IDs match the triggering entity.
- Requested concept relations, parents, and children exist.
- Merge locations match the downstream corpus template.
- Rejection filters do not remove stable identifiers.
- Pruning and retained-version counts are deliberate for repeated processing.

## Terraform lifecycle

- Address-only renames use `moved` blocks.
- Removed resources have no remaining upstream or downstream references.
- Replacements of spaces, classes, specifications, identities, and indexes are treated as destructive until plan proves otherwise.
- Route replacement adds and verifies the new path before withdrawing the old path when coexistence is possible.
- Schema changes account for prompts, corpora, actions, relations, preloads, and indexed documents.

## Validation boundary

Static source can prove topology and declared policy. It cannot prove:

- valid credentials;
- deployed listener registration;
- worker availability;
- model responses;
- remote API payload compatibility;
- external index existence or mapping compatibility;
- runtime ordering under concurrency; or
- successful historical migration of Terraform state.

Report those as runtime unknowns unless logs, plans, state, or execution traces
are available.
