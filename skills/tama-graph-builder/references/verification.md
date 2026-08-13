# Verification

Verify the changed graph in layers. Static completeness does not prove runtime
success.

## Execution checks

- Exactly one Terraform state owns the required global foundation, or an explicit external-foundation contract is documented.
- Every decoded schema passed to `tama_class.schema_json` has non-empty top-level `title` and `description` strings; nested property descriptions do not satisfy the class metadata contract.
- Every global space, schema, and corpus reference resolves to an output present in the pinned root-module version.
- Every trigger selects the intended class, state, node, chain, or activation.
- Node and chain ownership agree with the intended space.
- Thought indexes and outputs form an executable sequence.
- Every router or forwarding output has a path to an existing class.
- Every target class has a handler or an intentional persisted/external terminal.
- Every branch has an explicit terminal, including empty, failure, clarification, and asynchronous outcomes.

## Control checks

- Every cross-space handoff has a bridge in the handoff direction.
- Every listener-driven chain has the required topic and filter under the repository's dispatch model.
- Every path directive references the intended path, prompt, and downstream thought.
- Every path activation names the intended explicit processing chain.
- Every delegated thought targets a compatible shared thought.
- Context inputs and module inputs use the correct corpus and input type.
- Each thought has at most one initializer for a given class and reference; a single import initializer combines all resource requests for its anchor.
- Initializer class IDs match resources present before initialization, while imported resources match the corpora of modules that consume them.
- Every deterministic action caller's rendered corpus matches the runtime request-argument envelope; required `path`, `query`, and `body` values are nested under those exact top-level keys.
- JSON actions prove that the rendered `body` becomes the HTTP JSON payload and receives the expected content type.
- Every structured generation thought materializes at least one user message; system-only contexts are incomplete when the runtime requires a user message.
- Runtime corpora are inserted into the final provider messages. For marker-based Tama versions, the user prompt contains a standalone `{{ corpus }}` marker.
- Awaited relations, preloaded relations, and thread-focus relations have consistent producers and consumers.

## Operational checks

- Tools resolve actions from the intended specification, method, and path.
- Deterministic callers receive a stable corpus and identifier.
- Retries are bounded and safe for the action's idempotency.
- Queue and priority match the expected workload.
- When the installed runtime resolves worker queues at boot, queues provisioned after startup are followed by an explicit worker reload or restart and consumption evidence.
- Pruning and version-retention behavior are deliberate.
- Source identity validation and rate limits are configured without committed secrets.
- External credentials, workers, APIs, indexes, and deployed listeners remain runtime prerequisites unless execution evidence is available.

## Lifecycle checks

- Stable resources retain their Terraform addresses.
- Address-only renames use `moved` blocks.
- Removed paths have no upstream router outputs, filters, directives, activations, or downstream consumers.
- Plan review identifies every replacement or deletion affecting data-bearing resources.

## Commands

Run repository-specific checks first. Otherwise use the narrowest safe commands:

```bash
terraform fmt -check -recursive
terraform validate
```

`terraform validate` does not necessarily call Tama's remote class-schema
validator. Add or run a repository check that decodes every `tama_class`
schema source and rejects missing or blank top-level `title` and `description`
fields before an apply.

Run `terraform init` only when required to install the declared provider and
modules. Run `terraform plan` only with approved configuration. Never use
`terraform apply` as a validation step.

## Handoff

Report:

1. The before-and-after trigger-to-terminal graph.
2. Added, moved, replaced, and removed addresses.
3. Changed classes, relations, actions, bridges, and external terminals.
4. Checks run and their results.
5. Runtime prerequisites and behavior not verified in the current environment.
