---
name: graph-builder
description: Bootstrap, design, build, extend, migrate, replace, reprocess, and safely remove Tama Terraform graph networks. Use when starting a Tama Terraform repository or creating or changing Tama global foundations, conversations, routers, direct message handlers, component handoffs, background processors, crawlers, ingestion networks, indexing flows, spaces, classes, chains, nodes, thoughts, tools, paths, directives, listeners, sources, or lifecycle wiring.
---

# Graph Builder

Translate a requested outcome or graph change into a complete, state-aware Tama
network. Follow the target repository's conventions and installed versions. Do
not assume a Memovee, search, movie, or other product domain.

Treat the target graph repository's Terraform source as the source of truth for
the intended graph configuration. A configured Tama MCP may provide runtime
evidence from threads, flows, steps, and artifacts, but it does not replace
inspection of `.tf` files, installed modules, provider locks, state, or plans.
If runtime evidence conflicts with source, report possible deployment or source
drift and resolve that boundary before designing a graph change. Never copy an
MCP graph or configuration projection into Terraform as though it were the
authoritative definition.

## Discover the repository

1. Read repository instructions such as `AGENTS.md` and inspect the closest complete graph.
2. Run `node scripts/inspect-tama-repository.mjs <repository>` to inventory the global foundation, provider locks, installed modules, declared module calls, and Tama block types.
3. Read [global foundation](references/global-foundation.md). Identify the owner and installed version of the global space, schemas, corpora, and validation chain before designing dependent resources.
4. Inspect `.terraform/modules/modules.json` and the installed module source for every helper being added or changed. If modules are not installed, follow the repository's approved `terraform init` workflow.
5. Inspect relevant schemas, actions, specifications, sources, queues, models, prompts, corpora, and external terminals.
6. Read [graph contract](references/graph-contract.md) and record the current path plus the requested delta before editing.

When a user comment or runtime failure motivates the change, use the comment to
scope the symptom and use only bounded MCP runtime evidence to test it. Derive
the current graph and every proposed edit from repository source. Distinguish a
source defect from stale deployment, runtime failure, bad input, and external
system behavior before editing.

## Select the graph shape

Read only the references that match the request:

- For a new repository, a missing global module, or any use of global schemas, corpora, or space IDs, read [global foundation](references/global-foundation.md).
- For routed conversations, shared reply chains, direct forwarding, or action terminals, read [conversation graphs](references/conversation-graphs.md).
- For crawlers, extraction, relations, generation, embeddings, indexing, or batch reprocessing, read [ingestion and indexing](references/ingestion-and-indexing.md).
- For helper-module selection, read [Tama base modules](references/tama-base-modules.md).
- For raw resources and control edges, read [provider primitives](references/provider-primitives.md).
- For replacement, removal, renaming, or schema changes, read [lifecycle and migrations](references/lifecycle-and-migrations.md).

Do not force every conversation through a router. Choose a router only when the
input can validly enter multiple behaviors. Treat an external action, durable
record, task result, or index write as a valid terminal when the product
contract does not require a root reply.

## Implement the graph delta

1. Establish or reuse exactly one owned global foundation before resources that consume its space, schemas, corpora, or validation behavior. Do not create a second foundation when another Terraform state owns it.
2. Preserve stable Terraform addresses unless a deliberate move is required.
3. Add or reuse semantic handoff classes; route thoughts to classes, not directly to chains or spaces.
4. Create every bridge in the direction of its actual cross-space handoff. Do not add an unused reverse bridge.
5. Bind each trigger to the correct reactive, explicit, listener-filtered, lifecycle-state, or path-activated execution mode.
6. Create ordered thoughts plus their contexts, inputs, processors, tools, queues, preloads, pruning, directives, and paths. Consolidate resources that share one thought, initializer anchor class, and reference into a single initializer. For structured model generation, verify that the active contexts materialize a user message carrying the runtime corpora; a system-only context is incomplete even when context inputs exist. For deterministic action callers, render the complete request-argument envelope expected by the installed runtime.
7. Give every branch an intentional terminal, including empty, failure, clarification, and asynchronous outcomes.
8. Keep shared reply generation in the root messaging space when that is the repository architecture. Attach branch-specific prompts with path directives rather than cloning reply chains.
9. For sibling domain graphs, use a parity matrix but preserve independent class IDs, actions, relations, and lifecycle controls.
10. Update prompts, schemas, listener filters, documentation, and tests in the same change as their Terraform edges. Every JSON schema passed to `tama_class.schema_json` must include non-empty top-level `title` and `description` fields; property-level descriptions do not satisfy this class contract. Check the decoded schemas before apply because ordinary Terraform validation may not exercise Tama's remote schema validation.

## Manage existing graphs safely

Before replacing or removing anything, trace all upstream triggers and
downstream consumers. Add a replacement path before withdrawing the old path.
Use Terraform `moved` blocks for address-only renames. Treat replacements of
spaces, classes, specifications, and externally indexed data as destructive
until a reviewed plan proves otherwise.

Do not run `terraform apply` unless the user explicitly requests deployment.

## Verify before handoff

Read [verification](references/verification.md), then:

1. Trace every changed trigger to every terminal.
2. Verify global foundation ownership, required outputs, routing, bridges, handlers, control edges, operational controls, and lifecycle intent.
3. Run repository checks, including a decoded-schema check for every `tama_class`, then run `terraform fmt -check -recursive` and `terraform validate` when available.
4. Review an approved `terraform plan` for destructive changes when the task changes existing addresses or data-bearing resources.
5. Report the graph delta, assumptions, validation, runtime prerequisites, and any unverified external behavior.
