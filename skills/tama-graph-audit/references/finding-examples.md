# Finding examples

Use exact resource names and file locations. Do not assert deployment failure
when the static graph only proves a risk or unknown.

## Missing router path

```text
blocking — The router prompt can emit catalog-search, but no thought path from
module.app-chat-router.routing_thought_id targets
module.catalog-search-forwardable.class.id. The downstream handler exists but
is unreachable from routed user messages.
```

## Missing path directive

```text
high — catalog-search-to-artifact reaches the shared response-with-artifact
class, but no directive attaches the catalog artifact prompt to the shared
artifact thought. The branch is reachable, but it can render with only generic
instructions or instructions inherited from another path.
```

## Invalid directive target

```text
blocking — catalog-results-artifact targets a thought in a chain that does not
handle the path's target class. The directive cannot control the execution
reached by this path.
```

## Complete one-way action terminal

```text
info — app-search forwards user-message into catalog-search, whose tooling
action creates the UI artifact. The external action is the declared terminal;
no component-to-root bridge or root reply chain is required by this topology.
```

## Await relation has no producer

```text
blocking — generate-catalog-description awaits create-catalog-keywords, but no
crawler or thought in the selected graph emits that relation. The first
enrichment thought can exhaust its attempts without becoming executable.
```

## Missing batch activation

```text
high — regenerate-class-entities has a path to catalog-item, and an explicit
catalog enrichment chain exists, but no thought_path_activation connects them.
The class-level request does not statically select the enrichment chain.
```

## Unsafe address rename

```text
high — tama_chain.catalog_enrichment replaces the former Terraform address
tama_chain.generate_catalog_enrichment without a moved block. The requested
change appears to be a label-only rename but can plan as destroy/create.
```

## Runtime unknown

```text
info — The processed indexing path includes its source class, corpus, preload,
queue, action, external bridge, and pruning policy. Elasticsearch credentials,
index mapping compatibility, and worker execution require plan or runtime
evidence and are not proven by Terraform source.
```
