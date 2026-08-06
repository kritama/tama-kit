# Operational invariants

Separate static configuration from deployed execution evidence.

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

## Actions, sources, and identities

- Each action resolves from the intended specification, method, and path.
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

Worker capacity, queue consumption, and processing latency are runtime evidence.

## Preloads and pruning

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
