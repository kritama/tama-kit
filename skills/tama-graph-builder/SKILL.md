---
name: tama-graph-builder
description: Design, build, extend, migrate, replace, reprocess, and safely remove Tama Terraform graph networks. Use when creating or changing Tama conversations, routers, direct message handlers, component handoffs, background processors, crawlers, ingestion networks, indexing flows, spaces, classes, chains, nodes, thoughts, tools, paths, directives, listeners, sources, or lifecycle wiring.
---

# Tama Graph Builder

Translate a requested outcome or graph change into a complete, state-aware Tama
network. Follow the target repository's conventions and installed versions. Do
not assume a Memovee, search, movie, or other product domain.

## Discover the repository

1. Read repository instructions such as `AGENTS.md` and inspect the closest complete graph.
2. Run `python3 scripts/inspect_tama_repository.py <repository>` to inventory provider locks, installed modules, declared module calls, and Tama block types.
3. Inspect `.terraform/modules/modules.json` and the installed module source for every helper being added or changed. If modules are not installed, follow the repository's approved `terraform init` workflow.
4. Inspect relevant schemas, actions, specifications, sources, queues, models, prompts, corpora, and external terminals.
5. Read [graph contract](references/graph-contract.md) and record the current path plus the requested delta before editing.

## Select the graph shape

Read only the references that match the request:

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

1. Preserve stable Terraform addresses unless a deliberate move is required.
2. Add or reuse semantic handoff classes; route thoughts to classes, not directly to chains or spaces.
3. Create every bridge in the direction of its actual cross-space handoff. Do not add an unused reverse bridge.
4. Bind each trigger to the correct reactive, explicit, listener-filtered, lifecycle-state, or path-activated execution mode.
5. Create ordered thoughts plus their contexts, inputs, processors, tools, queues, preloads, pruning, directives, and paths.
6. Give every branch an intentional terminal, including empty, failure, clarification, and asynchronous outcomes.
7. Keep shared reply generation in the root messaging space when that is the repository architecture. Attach branch-specific prompts with path directives rather than cloning reply chains.
8. For sibling domain graphs, use a parity matrix but preserve independent class IDs, actions, relations, and lifecycle controls.
9. Update prompts, schemas, listener filters, documentation, and tests in the same change as their Terraform edges.

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
2. Verify routing, bridges, handlers, control edges, operational controls, and lifecycle intent.
3. Run repository checks, `terraform fmt -check -recursive`, and `terraform validate` when available.
4. Review an approved `terraform plan` for destructive changes when the task changes existing addresses or data-bearing resources.
5. Report the graph delta, assumptions, validation, runtime prerequisites, and any unverified external behavior.
