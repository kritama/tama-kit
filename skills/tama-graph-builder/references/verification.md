# Verification

Verify the changed graph in layers. Static completeness does not prove runtime
success.

## Execution checks

- Exactly one Terraform state owns the required global foundation, or an explicit external-foundation contract is documented.
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
- Awaited relations, preloaded relations, and thread-focus relations have consistent producers and consumers.

## Operational checks

- Tools resolve actions from the intended specification, method, and path.
- Deterministic callers receive a stable corpus and identifier.
- Retries are bounded and safe for the action's idempotency.
- Queue and priority match the expected workload.
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
