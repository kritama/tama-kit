# Deterministic graph primitives

Use these primitives when the graph must transform, route, or publish an
already-selected value without asking a model to make the decision.

The examples below use the generic resource shapes exposed by
`upmaru/tama` provider v0.6.3, the release selected by Tama Kit's default
`~> 0.6.3` constraint:

- `tama_modular_thought.module.parameters` carries JSON module parameters;
- `tama_thought_module_input` binds one entity or concept class corpus; and
- `tama_thought_path.parameters` carries JSON path parameters.

The target repository's lockfile and installed provider schema remain
authoritative. Verify them before copying an example, especially when the
repository overrides Tama Kit's provider constraint. The provider resource
shape does not prove that the deployed Tama runtime supports a module
reference.

## Choose the primitive by contract

| Primitive | Use it for | It does not do |
|---|---|---|
| `tama/concepts/render` | Persisting a deterministic, schema-validated JSON transformation | Call a model or tool, use network-dependent filters, or select an arbitrary latest concept |
| `tama/concepts/dispatch` | Selecting exactly one thought path from a configured JSON scalar | Perform model-backed routing, activate every matching listener, or replace generic listener dispatch |
| `tama/agentic/result` | Publishing an existing forwarded concept as a durable MCP submission result | Select by relation, render or generate content, or create a result-owned Concept row |

Do not use these names interchangeably with generic graph terminology.
`tama/concepts/dispatch` is a specific thought module; listener dispatch,
reactive nodes, and path activation remain separate control mechanisms.

## Persist a deterministic transformation with Render

Render binds exactly one active `entity` or `concept` module input. The class
corpus attached to that input supplies the Solid template. An entity input is
selected by the bound class. A concept input additionally requires an exact
`relation`; missing or multiple matches fail instead of choosing a latest
concept.

The template receives the primary record or concept content as `data`. It also
receives `inputs`, whose explicitly named keys select exactly one supplied
concept for each configured relation. At most 16 named inputs are allowed.

```hcl
resource "tama_modular_thought" "render_index_document" {
  chain_id        = tama_chain.indexing.id
  index           = 2
  relation        = "index-document"
  output_class_id = tama_class.index_document.id

  module {
    reference = "tama/concepts/render"
    parameters = jsonencode({
      relation = "normalized-record"
      inputs = {
        source_metadata = "source-metadata"
        embedding       = "embedding"
      }
    })
  }
}

resource "tama_thought_module_input" "render_index_document" {
  thought_id      = tama_modular_thought.render_index_document.id
  type            = "concept"
  class_corpus_id = tama_class_corpus.index_document.id
}
```

The bound corpus can use only deterministic Solid behavior and the supported
`json` filter. Serialize source values with that filter so strings, Unicode,
newlines, and apparent template delimiters remain data:

```liquid
{
  "record": {{ data | json }},
  "source": {{ inputs.source_metadata | json }},
  "embedding": {{ inputs.embedding | json }}
}
```

For an entity primary input, set `type = "entity"` and omit `relation`, but
still configure `inputs = {}` when no named relation inputs are required.
Render does not expose network-dependent template filters. Its output must be
valid UTF-8 JSON, decode to an object, fit within 2 MiB, and satisfy
`thought.output_class.schema`. It then persists one concept under the
thought's own `relation`.

The module input is provisioned independently. Keep the chain's node or other
entry point inactive until the required input is active; a Terraform resource
declaration alone is not runtime activation evidence.

## Route a JSON scalar with Dispatch

Dispatch binds one active `concept` module input. Its module parameters must
name the concept's exact relation, an RFC 6901 JSON Pointer, and an explicit
`unique` or `latest` input-selection policy. Use `latest` only when selecting
the newest matching concept is the intended contract, not to hide ambiguous
graph wiring.

Each path carries its own `path` parameter object. Non-default paths contain
one or more JSON scalar case values; the single default path has no values.

```hcl
resource "tama_modular_thought" "dispatch_outcome" {
  chain_id        = tama_chain.handle_outcome.id
  index           = 1
  relation        = "outcome-dispatch"
  output_class_id = tama_class.dispatch_trace.id

  module {
    reference = "tama/concepts/dispatch"
    parameters = jsonencode({
      module = {
        relation        = "operation-result"
        pointer         = "/status"
        input_selection = "unique"
      }
    })
  }
}

resource "tama_thought_module_input" "dispatch_outcome" {
  thought_id      = tama_modular_thought.dispatch_outcome.id
  type            = "concept"
  class_corpus_id = tama_class_corpus.operation_result.id
}

resource "tama_thought_path" "dispatch_ready" {
  thought_id      = tama_modular_thought.dispatch_outcome.id
  target_class_id = tama_class.ready.id
  parameters = jsonencode({
    path = {
      values  = ["ready"]
      default = false
    }
  })
}

resource "tama_thought_path" "dispatch_pending" {
  thought_id      = tama_modular_thought.dispatch_outcome.id
  target_class_id = tama_class.pending.id
  parameters = jsonencode({
    path = {
      values  = ["pending", "indexing_pending"]
      default = false
    }
  })
}

resource "tama_thought_path" "dispatch_invalid" {
  thought_id      = tama_modular_thought.dispatch_outcome.id
  target_class_id = tama_class.invalid_response.id
  parameters = jsonencode({
    path = {
      values  = []
      default = true
    }
  })
}
```

Case values may be strings, numbers, booleans, or null. Arrays and objects are
invalid. Equality follows JSON scalar semantics: numeric `201` does not match
string `"201"`, while numerically equal numbers compare equal. Configure
exactly one default, no overlapping values, and no more than 32 scalar cases
across all non-default paths. A syntactically valid pointer that does not
resolve selects the default; a resolved array or object fails rather than
falling through.

Every target class needs a downstream handler or intentional terminal. Add a
directional `tama_space_bridge` when a target is in another space, and make
the corresponding path depend on it. Dispatch validates the bridge, forwards
only to the selected target, and persists a trace concept containing the
selected path, target, forwarded entity, and scalar value. It is not a
model-backed `tama/agentic/router`.

## Publish a durable MCP terminal with Result

Result is an intentional terminal for a graph started through a durable MCP
Submission. The executing forwarding entity must identify both the Submission
root and the exact existing concept:

- `origin_entity_id` names the registered Submission root entity; and
- `forwarded_from_concept_id` names the concept to publish.

Those fields come from the forwarding handoff. Do not synthesize them in a
prompt or ask Result to search by relation. Result has no configuration
parameters and no `tama_thought_module_input`:

```hcl
resource "tama_chain" "publish_submission_result" {
  space_id = var.submission_root_space_id
  name     = "Publish Submission Result"
}

resource "tama_modular_thought" "publish_submission_result" {
  chain_id        = tama_chain.publish_submission_result.id
  index           = 0
  relation        = "result"
  output_class_id = var.result_class_id

  module {
    reference = "tama/agentic/result"
  }
}

resource "tama_node" "publish_submission_result" {
  space_id = var.submission_root_space_id
  class_id = var.result_forwarding_class_id
  chain_id = tama_chain.publish_submission_result.id
  type     = "reactive"
}
```

`output_class_id` satisfies the general modular-thought resource contract and
should describe the expected terminal concept class. It does not make Result
search for or create a concept; the forwarding record still selects the exact
existing concept.

The chain must execute in the Submission root space. The forwarded concept's
flow, space, output class, schema, and ancestry must agree with that root, and
its lineage must be cycle-free. The serialized result is limited to 65,536
bytes. Agent-visible text must be present either as nonblank `text` or as
nonblank assistant-message content, and is limited to 8,192 bytes.

On success, Result completes the durable Submission with the concept content,
agent-visible text, `terminal_step_id`, and `terminal_concept_id`, then returns
the same concept to the worker. It does not call a model, render content, or
insert another Concept. An exact replay is idempotent; attempting to publish a
different terminal result conflicts with the already-completed Submission.

Do not add an outgoing thought path merely to make this terminal appear
connected. `tama/agentic/reply` remains the model-backed graph primitive for
creating an application reply concept; it is not a substitute for durable MCP
Submission completion.

## Verify without overstating evidence

Terraform source and provider validation can prove resource shape, declared
parameters, path cases, bridge direction, and the intentional absence of a
Result output path. They do not prove that a Render step produced valid output,
Dispatch selected a path, or Result completed a durable Submission.

Use runtime records when available to verify:

- the persisted Render concept and its schema-valid content;
- the selected Dispatch path, forwarded entity, and dispatch trace concept;
  and
- the completed Submission's `result`, `text`, `terminal_step_id`, and
  `terminal_concept_id`.

Report those as runtime unknowns when only static Terraform evidence is
available.
