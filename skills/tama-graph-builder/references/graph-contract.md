# Graph contract

Record this contract in the implementation plan or response before editing.
Use repository names rather than inventing generic aliases when changing an
existing graph.

## Execution contract

| Field | Questions to answer |
|---|---|
| Outcome | What observable product result must exist? |
| Trigger | Listener event, source class, lifecycle state, explicit node, callback, schedule, or path activation? |
| Input | Which class, operation state, properties, relations, and prior context are required? |
| Ownership | Which space owns each class, chain, thought, action, and terminal? |
| Execution | Which node starts which ordered chain? Which thoughts transform, route, call, generate, forward, or embed? |
| Branches | What are the success, empty, failure, clarification, retry, and asynchronous outcomes? |
| Terminal | Root reply, artifact action, persisted class, task result, index write, or other external side effect? |

## Control contract

| Field | Questions to answer |
|---|---|
| Cross-space | Which handoffs require bridges, and in which direction? |
| Dispatch | Does execution require listener topics/filters, reactive state, explicit invocation, or path activation? |
| Context | Which prompts, corpora, concepts, parents, children, or metadata must be loaded? |
| Directives | Does a path attach a branch-specific prompt or redirect work to a shared target thought? |
| Operations | Which queue, priority, retry, await, rate limit, pruning, and validation policies apply? |
| Identity | What stable identifier connects source records, child records, relations, and external documents? |

## Change contract

For changes to an existing graph, also record:

- Added nodes and edges.
- Removed nodes and edges.
- Replaced or redirected paths.
- Terraform addresses that remain stable, move, or disappear.
- Data-bearing resources at risk of replacement.
- Upstream producers and downstream consumers affected by the delta.
- Compatibility expectations for class schemas, relations, prompts, and actions.
- Rollout order when old and new paths must coexist.

## Verification contract

List the invariant that proves each path complete. At minimum include:

- trigger reachability;
- node, chain, and space agreement;
- router-output and thought-path agreement;
- cross-space bridge direction;
- directive and activation targets;
- branch terminals;
- operational prerequisites; and
- Terraform formatting, validation, and destructive-plan review when applicable.

Do not confuse a loaded input with a terminal. A preload, prompt context, or
existing record supplies work; it does not prove that the required action or
query occurred.
