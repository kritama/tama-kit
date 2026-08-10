# Tama Builder

Tama Builder is a domain-neutral Codex plugin for building, changing, and
auditing Tama Terraform graph networks. It covers routed conversations, direct
forwarded actions, shared replies, ingestion, enrichment, embeddings, indexing,
batch reprocessing, the required global foundation, and Terraform-safe graph
migration.

## Installation

Tama Builder is distributed as a Codex plugin containing the
`tama-graph-builder` and `tama-graph-audit` skills. The plugin is downloaded
from npm through the Upmaru marketplace; installing the npm package by itself
does not enable the skills in Codex.

This installation path requires the Codex CLI with plugin support and an npm
CLI available on your system.

Add the marketplace and install the plugin:

```bash
codex plugin marketplace add upmaru/tama-builder
codex plugin add tama-builder@upmaru
```

Start a new Codex session after installation so Codex can load the bundled
skills. You can then invoke either skill explicitly:

```text
$tama-graph-builder
$tama-graph-audit
```

For example:

```text
Use $tama-graph-builder to add a routed support-search component with plain and
artifact replies, then verify every trigger-to-terminal path.
```

To confirm the plugin is installed:

```bash
codex plugin list
```

## Included skills

`tama-graph-builder` designs, implements, extends, migrates, and removes graph
slices. It models execution edges, control edges, operational policy, terminals,
and Terraform lifecycle impact before editing.

`tama-graph-audit` traces existing graphs without editing them. It reports
incomplete topology, missing control edges, unsafe lifecycle changes, and
runtime unknowns with exact evidence.

## Development

Memovee-derived forward-test cases live in `evals/cases.json`; public skill
references remain domain-neutral. Before public npm publication, choose a
license and add final repository, homepage, and publisher metadata to the
plugin manifest.
