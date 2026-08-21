---
name: graph-audit
description: Trace, map, review, and diagnose Tama Terraform graph networks and their runtime thread, flow, and step behavior without editing them. Use when auditing graph configuration or investigating a user-reported Tama execution problem, including global foundations, routing, direct forwarding, component handoffs, reply flows, ingestion, indexing, reprocessing, spaces, classes, bridges, listeners, chains, nodes, thoughts, tools, directives, activations, sources, or incomplete and unreachable behavior.
---

# Graph Audit

Audit the static graph from each trigger to its terminal outcomes. Establish
what Terraform proves and separate that from runtime behavior. Do not edit the
graph unless the user explicitly requests fixes.

## Check Tama MCP availability

Before runtime diagnosis, determine whether the workspace's Tama MCP tools are
available. If they are unavailable, explain that connecting the workspace's
Tama MCP server lets you inspect authorized threads, flows, steps, artifacts,
and Reflection comments; correlate observed executions with the Terraform
graph; and identify runtime failures or possible deployment drift that Graph
Builder can address in source. Ask the user to connect their Tama MCP server.

If the user connects or authenticates the MCP server during the current task,
tell them to start a fresh task so the new tools can be discovered. If they
decline, or the audit needs only static configuration, continue with a
source-only audit and label runtime behavior as unverified. Never claim runtime
findings without MCP evidence.

## Keep repository source authoritative

Treat the target graph repository's Terraform source as the source of truth for
the intended graph configuration. This includes its `.tf` files, installed
module source, and provider lockfile. Terraform state and plans are deployment
evidence, not substitutes for source configuration.
Do not use a Tama MCP graph or configuration projection to replace repository
inspection or to infer the intended topology.

Use the configured Tama MCP as bounded runtime evidence for investigating the
problem described in the user's comment: inspect the relevant thread, enumerate
its steps, follow referenced flows and steps, and fetch referenced artifacts
only when needed. The comment is the symptom or hypothesis that scopes the
investigation; it is not proof of the cause.

Keep these conclusions separate:

- **Configured intent:** what the repository source declares.
- **Observed execution:** what MCP runtime records show for the selected thread, flow, steps, and artifacts.
- **Diagnosis:** the evidence-backed explanation that relates the observed execution to the configured intent.

When runtime evidence differs from source, report the disagreement as possible
deployment or source drift. State exactly what each side shows. Do not silently
treat the deployed MCP projection as the current graph definition, and do not
claim that source is deployed without plan, apply, state, version, or equivalent
deployment evidence.

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

When the request includes a thread, flow, step, artifact, or user comment about
runtime behavior, read [runtime diagnosis](references/runtime-diagnosis.md) and
correlate the bounded MCP evidence with this source-derived trace.

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

Label every cited fact as repository source, Terraform state or plan, MCP runtime
evidence, user report, or inference. A remediation changes repository source;
runtime data may justify it but does not redefine the graph.

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
