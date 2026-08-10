---
name: tama-graph-audit
description: Trace, map, review, and diagnose Tama Terraform graph networks without editing them. Use when auditing or debugging Tama global foundations, routing, direct forwarding, component handoffs, reply flows, ingestion, indexing, reprocessing, spaces, classes, bridges, listeners, chains, nodes, thoughts, tools, directives, activations, sources, or incomplete and unreachable behavior.
---

# Tama Graph Audit

Audit the static graph from each trigger to its terminal outcomes. Establish
what Terraform proves and separate that from runtime behavior. Do not edit the
graph unless the user explicitly requests fixes.

## Discover and scope

1. Read repository instructions and locate the smallest Terraform slice that owns the reported behavior.
2. Identify which Terraform state owns the global foundation. Inspect the installed root `upmaru/base/tama` module and every global output consumed by the graph.
3. Inspect `.terraform.lock.hcl`, `.terraform/modules/modules.json`, and the installed helper-module source rather than treating a module call as an opaque complete pipeline.
4. Write the execution trace and the supporting control trace:

```text
execution: trigger -> class -> node -> chain -> thought/tool -> class/action -> terminal
control:   listener/filter | bridge | directive | activation | preload | queue | pruning
```

5. Mark every branch, cross-space edge, external side effect, and lifecycle state.

## Apply graph invariants

Read [graph invariants](references/graph-invariants.md) for topology and
[operational invariants](references/operational-invariants.md) for retries,
queues, preloads, pruning, versioning, and runtime boundaries. Read [finding
examples](references/finding-examples.md) when classifying evidence.

Do not require a router, reverse bridge, listener filter, or root reply unless
the selected architecture needs it. A one-way component flow ending in an
external action can be complete.

## Report findings

For each finding, provide:

- Severity: `blocking`, `high`, `medium`, or `info`.
- Evidence: exact resources and file locations.
- Broken contract: missing or inconsistent trigger, execution edge, control edge, terminal, or lifecycle guarantee.
- Impact: what cannot trigger, route, process, reply, persist, reprocess, or be observed.
- Smallest safe remediation.

Classify the overall path as:

- **Proven complete:** required static execution and control edges exist.
- **Incomplete wiring:** a required static edge is absent or inconsistent.
- **Unsafe lifecycle change:** the graph is reachable but a proposed rename, replacement, or removal risks unintended destruction or orphaned consumers.
- **Runtime unknown:** static wiring exists but credentials, queues, models, APIs, listeners, indexes, or deployed state remain unverified.

## Validate

Run repository checks and the narrowest safe Terraform validation available.
Do not run `terraform apply`. If asked to fix findings, preserve the original
trace, make the smallest change, and audit the repaired path against the same
invariants.
