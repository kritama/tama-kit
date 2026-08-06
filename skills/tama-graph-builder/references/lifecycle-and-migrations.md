# Lifecycle and migrations

Use this reference for changes to an existing graph, especially renames,
replacements, schema changes, and removals.

## Classify the change

Record whether each Terraform address is:

- unchanged;
- newly added;
- moved without changing the remote object;
- replaced intentionally;
- removed; or
- unknown until plan.

Treat spaces, classes, specifications, source identities, and external index
administration as data-bearing or operationally sensitive.

## Rename safely

Changing a Terraform resource label normally changes its state address. When
only the address changes, add a `moved` block:

```hcl
moved {
  from = tama_chain.old_catalog_enrichment
  to   = tama_chain.catalog_enrichment
}
```

Do not use a moved block when the remote object should genuinely be replaced.

## Replace a route

Use this order when old and new paths may need to coexist:

1. Create the new target class, handler, chain, bridges, terminal, and control edges.
2. Verify the new trigger-to-terminal path.
3. Add or switch the upstream router or forwarding path.
4. Observe the approved rollout boundary.
5. Remove the old prompt output, thought path, filters, directives, and handler.
6. Review the plan for unintended replacements or orphaned resources.

## Remove a graph slice

Trace removal in reverse dependency order:

1. Prompt examples and router outputs.
2. Upstream thought paths and forwarding edges.
3. Listener filters, directives, and activations.
4. Reactive and explicit nodes.
5. Thoughts, contexts, tools, processors, and chains.
6. Forwardable classes and bridges no longer used by another path.
7. Shared classes, spaces, specifications, actions, and indexes only after proving no remaining consumers.

Never delete a shared reply chain merely because one component stops using it.

## Change schemas compatibly

- Identify every prompt, corpus, action, relation, preload, and external index that consumes the class.
- Prefer additive changes before making fields required.
- Preserve stable identifiers across versions.
- Regenerate or migrate indexed documents when mappings or serialized fields change.
- Keep sibling domain changes independent unless the user explicitly requests coupled behavior.

## Verify destructive intent

Run formatting and validation first. Run `terraform plan` only with approved
backend, variables, credentials, and workspace. Report every delete or replace
for data-bearing resources. Do not apply as part of graph authoring unless the
user explicitly requests deployment.
