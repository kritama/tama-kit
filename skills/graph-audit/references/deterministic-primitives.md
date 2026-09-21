# Deterministic primitive invariants

Apply these checks when the graph uses `tama/concepts/render`,
`tama/concepts/dispatch`, or `tama/agentic/result`. Keep each module distinct
from generic transform, routing, dispatch, reply, and terminal terminology.

First verify the target repository's locked `upmaru/tama` provider schema. In
provider v0.6.3, module configuration is JSON in
`tama_modular_thought.module.parameters`, inputs are separate
`tama_thought_module_input` resources, and path cases are JSON in
`tama_thought_path.parameters`. A valid provider shape proves declared intent,
not successful runtime execution.

## Render

For every `tama/concepts/render` thought, verify:

- exactly one `tama_thought_module_input` exists and is expected to be active;
- its type is `entity` or `concept` and its class corpus owns the intended
  deterministic Solid template;
- a concept primary input configures an exact nonblank `relation`;
- the primary class/relation is intended to resolve uniquely rather than
  selecting an arbitrary latest concept;
- `inputs` exists, is a map of explicit template names to exact relations, and
  contains at most 16 entries;
- every named relation has exactly one producer in the resources supplied to
  the step;
- the template treats primary content as `data` and named content as `inputs`,
  serializing untrusted values with the supported `json` filter;
- the Render thought has no processor or tool, and its template uses no
  network-dependent filter;
- `output_class_id` is the intended class and its schema requires a JSON
  object compatible with the rendered document; and
- downstream thoughts consume the persisted concept through the Render
  thought's exact output relation.

The runtime enforces valid UTF-8 JSON-object output, the output-class schema,
and a 2 MiB byte limit. Static inspection can verify the declared template,
input wiring, limit-aware design, and output schema, but cannot prove that
particular runtime data rendered or validated successfully. Without a Step and
persisted concept, classify execution as runtime unknown.

## Dispatch

For every `tama/concepts/dispatch` thought, verify:

- exactly one active `concept` module input is intended;
- `parameters.module` contains a nonblank exact `relation`, a valid RFC 6901
  `pointer`, and explicit `input_selection` of `unique` or `latest`;
- `latest` is a deliberate domain rule rather than a workaround for ambiguous
  producers;
- every thought path has `parameters.path` with scalar `values` and a boolean
  `default`;
- exactly one path is the default and its values list is empty;
- every non-default path has at least one value;
- case values are only string, number, boolean, or null, with no arrays or
  objects;
- cases do not overlap under JSON equality and total no more than 32 values
  across non-default paths;
- every target class has a downstream handler or intentional terminal; and
- every cross-space target has a bridge from the Dispatch thought's space to
  the target class's space.

A missing pointer value selects the default path. A pointer resolving to an
array or object is an execution failure, not a default case. Numeric values do
not match strings with the same characters. Dispatch forwards to exactly one
selected target and persists a dispatch trace concept.

Do not apply this case-table contract to listener filters, reactive-node
delivery, `tama_thought_path_activation`, generic path traversal, or
model-backed `tama/agentic/router`. Conversely, do not describe the Dispatch
primitive as proven merely because a listener or reactive node can run.

Static source can prove the configured pointer, selection policy, cases,
targets, and bridges. A runtime Step, forwarding entity, and dispatch trace are
required to prove which case was selected and which downstream work started.

## Result

Treat `tama/agentic/result` as an explicit durable MCP terminal. Verify:

- the thought has no configurable result-selection parameters, module input,
  processor, or model/tool dependency;
- its triggering forwarding entity is expected to contain valid
  `origin_entity_id` and `forwarded_from_concept_id` values;
- `origin_entity_id` identifies a registered durable Submission root;
- `forwarded_from_concept_id` identifies the already-existing concept intended
  for publication;
- the executing flow originates at the Submission root;
- the executing chain and forwarding entity are in the Submission root space;
- every concept in the forwarding ancestry remains in the same flow, has the
  class declared by its producing thought, and reaches the Submission root
  without a cycle;
- the selected concept content satisfies its output-class schema and can be
  serialized to at most 65,536 bytes;
- agent-visible text is nonblank and at most 8,192 bytes; and
- no outgoing path is required after Result, because durable publication is
  the terminal side effect.

Do not require a newly created Result concept. Successful Result execution
publishes the existing forwarded concept and records its ID. Distinguish it
from `tama/agentic/reply`, which may call a model and create a reply concept.

Static Terraform can prove the Result thought, root-space chain, triggering
class, bridge topology, and intentional terminal shape. It cannot prove that a
Submission exists, forwarding UUIDs are valid, lineage and schemas agree for a
particular execution, or the payload meets byte and text limits.

Runtime completion requires the durable Submission to contain `result`,
nonblank `text`, `terminal_step_id`, and `terminal_concept_id`. The terminal
concept ID must be the forwarded existing concept, not a Result-owned concept.
An exact repeated publication is idempotent. A different terminal payload is a
conflict and must not overwrite the first terminal state.

## Evidence classification

Keep the final audit explicit:

- **Configured intent:** provider-valid resources, input bindings, parameters,
  cases, paths, nodes, and bridges in Terraform source.
- **Observed execution:** the relevant Step, persisted Render or Dispatch
  concept, forwarding entity, and durable Submission fields.
- **Diagnosis:** the smallest evidence-backed explanation for any disagreement
  between the configured graph and observed execution.

Do not report static fixtures, provider validation, or mock plans as proof that
Render produced output, Dispatch chose the intended case, or Result completed
a Submission.
