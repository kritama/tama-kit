# Project structure

Use explicit feature files so a reader can follow one handler without decoding a
central stage map. Preserve the target repository's ownership and state boundaries.
For an application with a Tama Kit root, use this layout:

```text
tama/
  main.tf                 # Existing global foundation; preserve its address
  versions.tf             # Root provider requirements
  memory.tf               # Application-owned call to ./graph and root inputs
  tests/
    foundations.tftest.hcl # Native Terraform plan assertions
  graph/
    versions.tf           # Child provider requirements; no separate state
    variables.tf          # IDs and corpora supplied by the root
    remember.tf           # Messaging root, outgoing bridges, forwarding/results
    recall.tf
    memory-write.tf       # Component space, outgoing bridges, shared inputs
    memory-query.tf
    memory-index.tf
    memory-api.tf          # Source/specification/action interfaces
    memory-inference.tf
    remember-ingestion.tf # One handler's request class, chain, node and thoughts
    remember-save.tf
    recall-search.tf
    index-snapshot.tf
    models.tf
    queues.tf
    outputs.tf            # Public interfaces referencing explicit resources
    schemas/
    corpora/
    prompts/
      remember/
      recall/
      index/
```

The memory names illustrate the layout; use the application's own features and
create only the files needed. A standalone graph can keep the same feature files
directly in its existing root. Do not add a child module solely for file grouping
when that would unnecessarily change deployed addresses.

## Keep a handler readable

- Keep its request class, chain, node, ordered thoughts, contexts, inputs, tools,
  modifiers, and paths together in `<operation>-<stage>.tf`.
- Keep space-level resources and outgoing bridges in the owning root/component
  file. Put shared models, queues and reusable inputs in focused shared files.
- Reference schemas, corpora and prompts with `${path.module}`. Split substantial
  contracts by consumer where practical; retain a versioned shared bundle when
  consumers deliberately share it.
- Do not construct distinct components or handlers with a `stages.tf` map and
  `for_each`/`count` factory. Their different prompts, paths, retries and terminals
  should be explicit. Ordinary comprehensions for output maps and `for_each` over
  genuinely uniform data such as operation-ID lookups are appropriate.
- Do not split every resource into its own file. The unit is the behavior being
  read and changed, not the Terraform resource type.

## Ownership and staged implementation

Reuse exactly one global foundation. Pass its IDs and corpus outputs to child
modules; keep the provider configuration and state at the existing root. Preserve
project-owned generated files. Edit Terraform and Compose directly; Tama Kit
receipts and generator comments are provenance only. No manifest hashes need
updating. Use native Terraform source and state to assess configuration.

For an intentionally staged foundation, declare the fixed interfaces explicitly,
keep incomplete entry nodes disabled, and document the issue that supplies each
terminal path. A declared handler or `ready = false` output does not make a flow
executable. Do not enable a trigger until its downstream execution and terminal
paths are complete.

Moving blocks between files in the same module preserves addresses. Replacing a
loop with explicit resources, renaming labels, or moving resources into a child
module changes addresses: inspect state and use `moved` blocks for already-managed
resources. Compare the plan and public outputs; a formatting pass alone cannot
establish lifecycle safety.

## Tooling belongs with its owner

Use Terraform directly for configuration validation and native `.tftest.hcl`
files for graph assertions. Do not add an application `scripts/` directory just
to wrap fmt/init/validate/plan or duplicate the bundled repository inspector.

Keep application-specific authorization, payload and persistence tests in the
application's normal test framework. Runtime probes of private application
modules are application-owned, even when a generic runner invokes them.

Before replacing existing scripts with Tama Kit, inspect every caller and preserve
its behavior: environment loading, public HTTPS identities and CA trust, service
selection, process/container ownership, and cleanup. Use an existing supported CLI
workflow only when it covers that behavior. Tama Kit's internal `validate-*`
scripts are package integration tests, not general application lifecycle commands;
do not substitute one simply because its name mentions the application. Reusable
product commands belong in `cli/`, with `bin/` remaining a thin entrypoint.
