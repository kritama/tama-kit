# Tama Builder

Tama Builder is a domain-neutral Codex plugin for building, changing, and
auditing Tama Terraform graph networks. It covers routed conversations, direct
forwarded actions, shared replies, ingestion, enrichment, embeddings, indexing,
batch reprocessing, the required global foundation, and Terraform-safe graph
migration.

## Included skills

`tama-graph-builder` designs, implements, extends, migrates, and removes graph
slices. It models execution edges, control edges, operational policy, terminals,
and Terraform lifecycle impact before editing.

`tama-graph-audit` traces existing graphs without editing them. It reports
incomplete topology, missing control edges, unsafe lifecycle changes, and
runtime unknowns with exact evidence.

## Development

Install the plugin from a local or Git-backed Codex marketplace, start a new
task, and invoke the relevant skill. For example:

```text
Use $tama-graph-builder to add a routed support-search component with plain and
artifact replies, then verify every trigger-to-terminal path.
```

Memovee-derived forward-test cases live in `evals/cases.json`; public skill
references remain domain-neutral. Before public npm publication, choose a
license and add final repository, homepage, and publisher metadata to the
plugin manifest.
