# Provider primitives

Use this reference when helper modules do not expose a required graph or
control edge.

## Contents

- Execution resources
- Routing and handoff resources
- Context and control resources
- External integration resources
- Supporting graph resources
- Operational semantics

## Execution resources

### `tama_node`

Bind a class to a chain in a space.

- `type = "reactive"`: run automatically for the configured class event.
- `type = "explicit"`: expose an intentional on-demand entrypoint.
- `on = "processed"` or another supported state: restrict reactive execution to that lifecycle state.

It is valid for the same class and chain to have both reactive and explicit
nodes when automatic processing and manual regeneration are both required.

### `tama_chain`

Own an ordered sequence of thoughts in one space. Confirm that the node and
chain belong to the intended space and that thought indexes are unique and
ordered.

### `tama_modular_thought`

Execute a module such as:

- `tama/agentic/tooling`
- `tama/agentic/router`
- `tama/agentic/generate`
- `tama/agentic/reply`
- `tama/actions/caller`
- `tama/concepts/forward`
- `tama/concepts/embed`
- `tama/classes/process`

Treat `relation` as part of the graph contract. Thread focus, await behavior,
preloads, prompts, and downstream consumers frequently depend on exact relation
names.

### `tama_delegated_thought`

Delegate execution to a shared thought instead of duplicating reply or tooling
logic. Verify the target thought exists and produces a class compatible with
the delegating chain's output.

## Routing and handoff resources

### `tama_thought_path`

Connect a thought output to a semantic target class. A path is incomplete when
its target has neither a downstream handler nor an intentional persisted or
external terminal.

### `tama_space_bridge`

Permit a handoff from `space_id` to `target_space_id`. Bridges are directional.
Create only the directions the execution graph uses.

### `tama_thought_path_directive`

Attach branch-specific instructions to a path and a downstream thought:

```hcl
resource "tama_thought_path_directive" "results-artifact" {
  thought_path_id   = tama_thought_path.results-to-artifact.id
  prompt_id         = tama_prompt.results-artifact.id
  target_thought_id = tama_modular_thought.root-artifact.id
}
```

Use directives when several domain chains share a root reply or artifact
thought but require different rendering instructions. Verify that the path
actually reaches the class handled by the target thought's chain.

### `tama_thought_path_activation`

Activate a specific chain for entities selected by a class-processing path:

```hcl
resource "tama_thought_path_activation" "regenerate-catalog-item" {
  thought_path_id = tama_thought_path.process-catalog-items.id
  chain_id        = tama_chain.generate-catalog-enrichment.id
}
```

Use activation for batch or class-level reprocessing. A thought path by itself
does not select which explicit entity chain should run.

## Context and control resources

### Prompts, contexts, and inputs

Use `tama_prompt`, `tama_thought_context`, and
`tama_thought_context_input` together. Match the input type to the corpus:

- `metadata` for invocation or thread metadata;
- `entity` for source-record renderings;
- `concept` for generated or extracted concept content.

For a structured `tama/agentic/generate` thought, provide separate system
instructions and a user prompt that receives the runtime data. Context inputs
prove only that corpora are available to context construction; they do not by
themselves prove that the final provider messages contain that data.

Inspect the installed Tama version to determine its corpus-insertion contract.
When it uses the `Contexts.Corpus` marker contract, put `{{ corpus }}` on a
standalone line in the user prompt. An inline marker does not select the corpus
insertion point. For example:

```hcl
resource "tama_prompt" "generation_input" {
  space_id = tama_space.component.id
  name     = "Generation Input"
  role     = "user"

  content = <<-EOT
    Use the following runtime inputs to produce the requested structured result.

    {{ corpus }}
  EOT
}

resource "tama_thought_context" "generation_input" {
  thought_id = tama_modular_thought.generate.id
  prompt_id  = tama_prompt.generation_input.id
  layer      = 1
}
```

Trace the complete active context set for the thought. It must materialize at
least one user message after corpus rendering. A system-only prompt set is a
blocking graph defect for runtimes whose structured generation path requires a
user message and can fail before the model is called, for example while mapping
a `nil` user message.

### `tama_thought_module_input`

Pass a corpus into deterministic modules such as callers and embedders. Do not
substitute a prompt context when the module requires an entity or concept input.

For `tama/actions/caller`, render the complete action-argument envelope, not
only the eventual HTTP payload. Match the action's OpenAPI contract and include
the applicable top-level keys:

- `path` for path parameters;
- `query` for query parameters; and
- `body` for a request body.

For a JSON POST whose entire entity or concept becomes the request body, use a
class corpus such as:

```hcl
resource "tama_class_corpus" "submit_request" {
  class_id = tama_class.request.id
  name     = "Submit Request"
  template = <<-EOT
    {
      "body": {{ data | json }}
    }
  EOT
}
```

Inspect the installed `Tama.Actions.Request` implementation when diagnosing
request construction. In runtimes that extract `arguments["body"]` before
calling the HTTP client, a raw `{{ data | json }}` corpus produces no JSON body
and therefore may omit `Content-Type` even though the action is a POST.

### `tama_thought_initializer`

Load records, concepts, parents, children, or samples before a thought runs.
The initializer `class_id` selects the existing resource on which the
initializer executes; it does not identify a resource that the initializer
will import. For a forwarded handoff, anchor the initializer to the handoff
entity class, then describe imported entities and concepts in `parameters`.

Tama permits only one initializer for each
`(thought_id, class_id, reference)` tuple. When one anchored import must load
several resources, put every request in the same `resources` list instead of
declaring several `tama/initializers/import` resources with the same thought
and anchor. The same thought and class can use distinct references, such as an
ordered `import` followed by `merge`, when both operations are required.

For preload initializers, verify:

- the class matches the triggering entity;
- requested relations have producers;
- child and parent class names exist;
- merge locations match the corpus template; and
- rejection filters do not remove required identity fields.

After imports, verify that each deterministic module can select its intended
input. In Tama versions with class-aware caller selection, an imported entity
used by `tama/actions/caller` must have the same class as the caller's entity
module-input corpus. Do not change the initializer anchor to that imported
class; keep the anchor on a resource that exists before the initializer runs.

### `tama_thought_processor`

Attach the intended model and completion behavior. Check model availability,
temperature, parameters, tool choice, and whether deterministic work should use
a model at all.

### `tama_thought_tool`

Attach an action to a thought. Confirm the action's specification, method, path,
input corpus, output handling, and owning space bridge when it causes an
external side effect.

### `tama_thought_pruning`

Control retained thought versions for repeated processing. Indexing and other
idempotent replacement flows often set `previous_versions_count = 0`; preserve
the repository's retention policy rather than omitting it accidentally.

## External integration resources

### `tama_specification`

Register an external API schema in its owning space. Treat schema completion or
failure waits as deployment prerequisites.

### `tama_source_identity`

Bind credentials to a specification and define their validation request. Never
embed secrets in examples or committed Terraform.

### `tama_source_limit`

Declare source rate limits explicitly. Keep rate limits separate for sources
with different provider quotas.

### Actions and modifiers

Use `data "tama_action"` to resolve actions from specifications. Use action
modifiers only when the graph deliberately transforms a request or response;
verify that modifiers preserve identifiers used by downstream relations.

## Supporting graph resources

### `tama_class` and `tama_class_operation`

Use a class for a durable semantic handoff or stored record. Use a class
operation when behavior depends on an operation contract beyond a node's basic
`on` state. Before changing a schema or operation, trace every corpus, prompt,
action, path, relation, preload, and external index that consumes it.

### `tama_thought_tool_input` and `tama_thought_tool_initializer`

Use tool inputs and tool initializers when an individual action requires data
or preparation different from the thought's general context. Verify their
action/tool target and ordering; do not assume a thought-level initializer also
configures every attached tool.

### `tama_space_processor`

Use space processors for execution behavior shared by a space. Treat changes
as cross-cutting: inventory every chain in the space before modifying one.

### `tama_queue`

Declare queues as operational graph resources and attach them through faculty
blocks. Keep conversational, indexing, system, or other workloads separate when
their capacity and priority policies differ.

### `tama_model`

Register models through the repository's inference-service convention. Model
IDs, capabilities, and provider credentials are runtime dependencies even when
the Terraform resource is statically present.

### `tama_source`

Use a source to represent an external execution endpoint associated with a
specification. Source identity, validation, limits, and actions must agree on
the same specification contract.

## Operational semantics

### Faculty and queues

Use `faculty` blocks to bind expensive or asynchronous work to the correct
queue and priority. Queue existence is statically inspectable; worker capacity
and successful execution are runtime evidence.

### Await and retry behavior

An `await` relation must have a real upstream producer. Verify timeout windows,
attempt limits, and the behavior when the awaited relation never appears.
Retries must be bounded and must not duplicate non-idempotent side effects.

### Stable identities

Use one stable identity contract across crawlers, spread children, relations,
preloads, and external index document IDs. `parent_entity_id` is a relationship
key, not automatically the external source identifier.
