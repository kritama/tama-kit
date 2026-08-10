# Tama base modules

Inspect the exact installed module source and version before using any helper.
This catalog explains selection; it is not a versioned interface specification.

The root `upmaru/base/tama` module is the global foundation, not one of the
optional helper modules below. Establish it once before selecting helpers; see
[global foundation](global-foundation.md).

| Module | Use for | Key contract |
|---|---|---|
| `messaging` | Root conversational surface | Creates a root space and messaging classes such as actor, thread, user-message, and response. |
| `router` | Classifying messages into behaviors | Requires messaging class names, a routing class, prompt, model, routable classes, and explicit paths to target classes. |
| `forwardable-class` | Semantic handoff | Creates a class with forwarding metadata. Route to this class across chains or spaces. |
| `thought-context` | Attaching layered prompts and corpus inputs | Creates contexts and their entity, concept, or metadata inputs for a thought. |
| `tooling` | Model-directed action calls | Creates a tooling thought, action tools, prompt contexts, and a model processor. |
| `crawler` | Request/response ingestion | Calls an action from an origin class and converts the action response into records. |
| `extract-nested-properties` | Splitting nested records | Extracts object or array properties into expected classes. |
| `spread` | Emitting child entities from fields | Maps selected fields into target classes using a stable identifier. |
| `build-relations` | Connecting related entities | Relates configured classes to permitted parent classes using stable properties. |
| `extract-embed` | Extracting and embedding relations | Extracts concept content for selected relations and emits embeddings. |
| `initializer-preload` | Loading graph context | Preloads concepts, embeddings, records, parents, children, and rejection filters. |
| `sample-forward-entities` | Sampling and forwarding records | Preloads selected entities and forwards samples to another graph stage. |
| `elasticsearch` | Index administration graph | Creates specification, identity, index-generation classes, and management actions. |
| `inference-service` | Model provider registration | Creates provider-backed models and exposes model IDs. |

## Selection rules

- Prefer helper modules when their complete contract matches the target graph.
- Use raw `tama_*` resources for control edges and behavior not exposed by a helper.
- Use tooling only when a model must decide or compose action calls. Use `tama/actions/caller` for deterministic actions.
- Use a preloader only for the context the thought actually consumes.
- Keep movie, TV, customer, tenant, or other sibling domains independently configurable even when their graph shapes are parallel.

## Version discovery

Check all of these sources:

1. `.terraform.lock.hcl` for the provider version.
2. Root Terraform constraints for allowed provider versions.
3. `.terraform/modules/modules.json` for installed helper versions and directories.
4. The installed module's variables, outputs, and resource implementation.
5. The target repository's existing calls for local conventions.

Do not assume a nearby checkout of the base-module repository matches the
version installed in the target repository.
