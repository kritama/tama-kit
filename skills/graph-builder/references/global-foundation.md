# Global foundation

Treat the root `upmaru/base/tama` module as infrastructure required by Tama
graphs, not as an optional graph helper. It creates the global space, shared
schemas and corpora, and global validation behavior consumed by other modules
and raw resources.

## Establish ownership

Before adding graph resources:

1. Search for a root module call whose source is `upmaru/base/tama` without a
   `//modules/...` suffix. The conventional address is `module.global`.
2. Inspect `.terraform/modules/modules.json` and the exact installed root module
   source. Record the resources and outputs supplied by that version.
3. Search every Terraform state boundary or repository convention that could
   own the same Tama environment. A Tama environment must not get a second
   global foundation from a different state.
4. Classify ownership as local, external and documented, or unknown. Resolve
   unknown ownership before planning a new foundation against an existing
   environment.

If the current state already owns the foundation, reuse its existing Terraform
address. Do not rename it merely to match the conventional `module.global`
address. If another state owns it, use that repository's approved data or
remote-state contract and make the ordering prerequisite explicit.

## Bootstrap a standalone graph

For a new state that owns its Tama environment, declare the root module once,
near the provider configuration:

```hcl
module "global" {
  source  = "upmaru/base/tama"
  version = "0.5.2" # Example only: replace with the version verified for the target repository.
}
```

Pin an explicit version. Select it from the target repository's existing
constraints, initialized modules, and compatibility requirements. Do not infer
the root-module version from a neighboring checkout or assume it must equal the
versions of `//modules/...` helper calls.

Run the repository's approved `terraform init` workflow, then inspect the
installed root module. Versions can add or change global schemas, corpora, and
validation resources.

## Consume the foundation

Use outputs from the installed version rather than recreating shared classes:

```hcl
space_id        = module.global.space.id
output_class_id = module.global.schemas["tool-call"].id
```

Use bracket notation for hyphenated schema keys. Typical root-module outputs
include `space`, `schemas`, and shared corpus IDs, but the installed module is
the interface of record.

Add an explicit dependency when a helper or resource relies on global objects
indirectly and Terraform cannot infer the edge from an input:

```hcl
depends_on = [module.global.schemas]
```

Do not add `depends_on` when a direct output reference already expresses the
dependency unless the installed helper's behavior requires the stronger edge.

## Protect existing environments

Adding the foundation creates remote, data-bearing Tama resources. Before an
approved plan:

- verify that no other state already owns the global space;
- verify that all referenced schema keys and corpus outputs exist in the pinned
  module version;
- inspect the plan for duplicate creation, replacement, or import requirements;
- preserve the existing module address when it is already in state; and
- do not run `terraform apply` unless the user explicitly requests deployment.

A missing local foundation is blocking when the configuration references
`module.global`. When ownership is explicitly external and all references use
that external contract, report deployment order and remote availability as
runtime prerequisites rather than creating a duplicate.
