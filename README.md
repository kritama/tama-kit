# Tama Kit

Tama Kit is a domain-neutral ChatGPT and Codex plugin for building, changing,
and auditing Tama Terraform graph networks. It combines focused graph skills
with a workspace-specific Tama MCP connection. The skills cover routed
conversations, direct forwarded actions, shared replies, ingestion, enrichment,
embeddings, indexing, batch reprocessing, the required global foundation, and
Terraform-safe graph migration.

## Installation

Tama Kit is distributed as a plugin containing the
`graph-builder` and `graph-audit` skills. The plugin is downloaded
from npm through the Upmaru marketplace; installing the npm package by itself
does not enable the plugin in ChatGPT or Codex.

This installation path requires the Codex CLI with plugin support, Node.js 20
or newer, and an npm CLI available on your system.

Add the marketplace and install the plugin:

```bash
codex plugin marketplace add upmaru/tama-kit
codex plugin add tama-kit@upmaru
```

Start a new Codex session after installation so Codex can load the bundled
skills. You can then invoke either skill explicitly:

```text
$graph-builder
$graph-audit
```

For example:

```text
Use $graph-builder to add a routed support-search component with plain and
artifact replies, then verify every trigger-to-terminal path.
```

To confirm the plugin is installed:

```bash
codex plugin list
```

## Included skills

`graph-builder` designs, implements, extends, migrates, and removes graph
slices. It models execution edges, control edges, operational policy, terminals,
and Terraform lifecycle impact before editing.

`graph-audit` traces existing graphs without editing them. It reports
incomplete topology, missing control edges, unsafe lifecycle changes, and
runtime unknowns with exact evidence.

## Development

The bundled maintenance utilities and Terraform inspector are dependency-free
Node.js ES modules; no Python runtime is required.

Memovee-derived forward-test cases live in `evals/cases.json`; public skill
references remain domain-neutral. Validate the public-directory metadata,
Template MCP scaffold, and review cases with:

```bash
npm run validate:submission
```

The public Template MCP connection is intentionally not represented by a fake
local endpoint. Configure the review materials with a concrete, working example
endpoint:

```bash
npm run configure:mcp -- \
  --example-url "$TAMA_KIT_EXAMPLE_MCP_URL"
```

The example URL must be publicly reachable and must match the committed
`https://{host}/mcp` template. Tama deployments expose Streamable HTTP at
`/mcp`; their OAuth discovery metadata remains owned by each deployment.
The OpenAI Platform draft identifier shown as `asdk_app_v_...` belongs to the
draft URL and is not an MCP app ID, package setting, or `.app.json` value.

After configuration, run the review-readiness gate and build the distributable
plugin ZIP:

```bash
npm run validate:review
npm run build:submission
```

The archive is written to `dist/tama-kit-<version>.zip`. In the OpenAI Platform
draft, enter the Example and Template MCP Server URLs directly and upload the
final skill bundles from `skills/`. Portal test cases remain in
`evals/cases.json` because they are review materials rather than plugin runtime
files. Copy-ready listing URLs, selected review cases, and release notes live in
`submission/portal.json`.

Template MCP URLs are available only to trusted OpenAI developers with an
established relationship. The OpenAI review also requires a verified publisher,
Apps Management write access, and a public non-test example MCP endpoint. See
the official [plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [submission requirements](https://developers.openai.com/plugins/deploy/submission).

## License

Tama Kit is licensed under the [Apache License 2.0](LICENSE).
