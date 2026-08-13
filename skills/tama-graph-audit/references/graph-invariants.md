# Graph invariants

Apply only the invariants required by the selected architecture. Trace helper
modules to their contained resources and external edges.

## Routed conversation

- The source message class reaches the router node and chain.
- Every class declared by the router prompt has a matching thought path.
- Every path target has a handler or an intentional persisted/external terminal.
- Cross-space routes have bridges in the forwarding direction.
- Each component forwardable class has a reactive handler in its owning space.
- Component returns to root response classes have a return bridge and root reply handler.
- Listener topics and filters include every chain required by the repository's dispatch model.
- Plain, artifact, clarification, failure, and asynchronous branches have intentional terminals.

## Shared replies and directives

- Each path directive references an existing path, prompt, and target thought.
- The path reaches the class handled by the target thought's chain.
- The directive prompt is semantically compatible with that branch.
- A delegated thought targets a compatible shared thought.
- Removing one caller does not remove a shared root reply chain used elsewhere.

## Direct forwarded action

- The root input class has a reactive forwarding node and chain.
- The forwarding thought has a path to the component forwardable class.
- A directional bridge permits the root-to-component handoff.
- The component class has a reactive action/tooling handler.
- The action terminal has any required component-to-external bridge.
- Do not report a missing router, reverse bridge, or root reply when the external action is the declared terminal.

## Event processing and ingestion

- Every crawler origin class has a stable request corpus, action, request relation, response relation, and record policy.
- Fan-out branches are independently reachable and use distinct relations where their completion is independently awaited.
- Extraction and spread target existing expected classes with stable identifiers.
- Relation builders connect each child to the intended set of parent classes.
- Reactive and explicit nodes are distinguished and both exist when automatic processing and manual reruns are required.
- Awaited relations have upstream producers and bounded failure behavior.
- Generated and embedded concepts use the intended entity or concept corpora.
- Deterministic action caller corpora render the complete request-argument envelope expected by the installed runtime, including required `path`, `query`, and `body` keys.
- Every structured model-generation thought materializes a user message carrying the runtime corpora when required by the installed Tama version.
- System-only contexts and declared context inputs are not proof that structured generation receives a valid user message or provider payload.

## Indexing and reprocessing

- Processed indexing binds the correct source class, state, chain, corpus, preloader, tool, and external bridge.
- Preloaded parents and children exist and are reachable through the relation network.
- Document serialization includes a stable external document ID.
- Class-level processing paths target the intended entity classes.
- Each batch-reprocessing path has a `tama_thought_path_activation` for the explicit entity chain.
- A path without activation is not assumed to run the intended reprocessing chain.

## Cross-cutting consistency

- Resource names, class names, prompt examples, action names, and relation strings agree.
- Node, chain, prompt, and class ownership is consistent with their space.
- Thread focus relations have producers and do not omit required tool or reply context.
- Every trigger reaches a terminal without relying on an undeclared edge.
- A loaded seed, preload, or prior record is input rather than proof of completed work.
- Tool-specific inputs and initializers target the intended tool rather than only its parent thought.
- Thought initializers are unique by thought, anchor class, and reference; repeated imports for one anchor are consolidated into one ordered `resources` list.
- An initializer class selects a resource present before initialization. Imported entity and concept classes are verified separately against their downstream context or module-input corpora.
- Space-processor changes account for every chain sharing that space.
- Class-operation resources agree with the node lifecycle states they are intended to drive.
