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

## Missing structured user context

```text
blocking — generate-summary uses tama/agentic/generate with structured output,
but every active thought context has role system. The installed structured
context builder requires a user message and calls message_to_map on the missing
message before provider inference. Add a user context that carries the runtime
corpora according to the installed Tama context contract.
```

## Raw payload used as action arguments

```text
blocking — submit-analysis uses tama/actions/caller for an OpenAPI JSON POST,
but its module-input corpus renders the entity directly instead of nesting it
under body. The installed request builder reads arguments["body"], so the call
is sent without a JSON payload or Content-Type and the server rejects it. Add
an action-specific corpus that renders {"body": <payload>} and retain the raw
JSON corpus for model contexts.
```

## Queue provisioned after worker startup

```text
high — The entity job targets inference-work and the reactive node exists, but
the running worker resolved its queue subscriptions before that queue was
provisioned. The entity can remain processing without a Flow. Restart or reload
the worker, then verify queue subscription and job consumption before changing
the graph topology.
```

## Duplicate initializer anchor

```text
blocking — generate-plan declares three tama/initializers/import initializers
with the same thought and handoff class. Tama uniquely identifies an
initializer by thought, class, and reference, so the second update fails even
though its index and requested resource differ. Keep the initializer whose
Terraform address already owns the handoff anchor and combine all three
requests into its resources list.
```
