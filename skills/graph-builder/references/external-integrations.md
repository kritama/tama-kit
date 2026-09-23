# External integrations

Use this reference for any Tama graph backed by an external API — crawlers,
indexers, and synchronous tool/action terminals alike. Replace versions,
identifiers, and URLs with values verified in the target repository.

## Contents

- Terraform owns the specification
- Three distinct identities
- Action and source resolution
- Conditional activation
- Adopting an existing specification
- External state ownership
- Static checks versus live acceptance

## Terraform owns the specification

Inspect the repository's ownership convention before registering an external
API. When this Terraform state owns the integration, declare the OpenAPI
document source and its Tama registration in that state:

```hcl
data "http" "memory_api" {
  url = var.memory_api_openapi_url
}

resource "tama_specification" "memory_api" {
  space_id = tama_space.memory-api.id
  endpoint = var.memory_api_openapi_url
  version  = var.memory_api_spec_version
  schema   = jsonencode(jsondecode(data.http.memory_api.response_body))

  wait_for {
    field {
      name = "current_state"
      in   = ["completed", "failed"]
    }
  }
}
```

Do not provision the specification directly through Tama's API or console as a
substitute for Terraform ownership. A hand-created specification is not the
source of truth, and later applies cannot manage it.

## Three distinct identities

Keep these three values separate. Confusing them produces actions that target
the wrong host or specifications that stop tracking the application:

- `tama_specification.endpoint` is the URL of the OpenAPI document itself,
  served by this repository (for example `https://app.localhost/tama/openapi`
  in Memovee).
- The API source endpoint is the base URL the actions actually call, read from
  the document's `servers` entry after import (for example the application's
  service origin). The `data "tama_source"` slug identifies that imported
  server.
- `tama_specification.version` follows the target application's own versioning
  convention (for example the Memovee `mix.exs` version, `0.1.2`). It is not
  the OpenAPI format version (`3.0.0`), which only identifies the document
  dialect. Other projects follow their own repository contract.

Read `servers` from the fetched document when configuring the source slug or
verifying that the intended actions target the expected host.

## Action and source resolution

Resolve actions and sources from the Terraform-managed specification ID. Never
copy a remote action or source ID into reusable configuration as a variable:

```hcl
data "tama_action" "memory_post_create" {
  specification_id = tama_specification.memory_api.id
  identifier       = "memory_post_create"
}

resource "tama_thought_tool" "memory-post-create" {
  thought_id = tama_modular_thought.remember-tooling.id
  action_id  = data.tama_action.memory_post_create.id
}
```

The `tama_specification` resource alone does not bind a tool. It registers the
document; the tool is enabled only when an action is resolved and a
`tama_thought_tool` attaches it to the exact thought. Keep source identity,
validation, and rate limits on the same specification and source contract, as
in [ingestion and indexing](ingestion-and-indexing.md).

## Conditional activation

When activation must be deliberate, use this gated lookup and tool *instead of*
the unconditional pair above, so an unconfigured integration instantiates
neither:

```hcl
variable "memory_api_operations" {
  type    = set(string)
  default = []

  validation {
    condition     = length(setsubtract(var.memory_api_operations, toset(["memory_post_create"]))) == 0
    error_message = "Only explicitly enabled operation IDs may be resolved."
  }
}

locals {
  remember_enabled = (
    var.memory_api_source_slug != null &&
    contains(var.memory_api_operations, "memory_post_create")
  )
}

data "tama_action" "memory_api" {
  for_each         = local.remember_enabled ? var.memory_api_operations : toset([])
  specification_id = tama_specification.memory_api.id
  identifier       = each.key
}

resource "tama_thought_tool" "memory-post-create" {
  count = local.remember_enabled ? 1 : 0

  thought_id = tama_modular_thought.remember-tooling.id
  action_id  = data.tama_action.memory_api["memory_post_create"].id
}
```

With no source or operation configured, the action lookup and the thought tool
are not instantiated. When the allowlist selects `memory_post_create`, verify
the operation is the exact intended one — in Memovee, `POST
/tama/memory/posts` — before treating the tool as enabled. A declared
specification alone is not an enabled tool.

## Adopting an existing specification

When the specification already exists outside state — for example created
directly through Tama's API before the repository adopted Terraform ownership
— adopt it into the owning state instead of creating a second one:

1. Inspect the exact identity and ownership of the existing specification:
   which state or process created it, its owning space, endpoint, version, and
   current state.
2. Import it into the Terraform state that owns the integration:

   ```bash
   terraform import tama_specification.memory_api SPECIFICATION_ID
   ```

3. Review the plan before apply. The imported attributes may differ from the
   declared configuration (commonly the `version` string); decide deliberately
   whether the plan updates the specification in place or replaces it, and
   treat replacement as destructive.
4. Do not create a second specification for the same document, and do not
   hard-code one environment's remote ID into reusable graph configuration.

## External state ownership

Preserve the exception for a deliberately external owner. When another
Terraform state owns the integration, consume it through an explicit
documented dependency — a variable or remote-state output — instead of
claiming local ownership:

```hcl
data "tama_action" "index_document" {
  specification_id = var.search_index_specification_id
  method           = "PUT"
  path             = "/{index}/_doc/{id}"
}
```

Record the owning repository or state in the variable description or the
repository's graph contract so the dependency stays discoverable.

## Static checks versus live acceptance

- `terraform validate` and a reviewed plan prove the configuration is
  well-formed and that lookups reference the Terraform-managed specification.
  They do not prove the operation exists in the document or that the action
  executes.
- Verify the OpenAPI operation against the document itself: the operation
  identifier must map to the intended method and path (for example
  `memory_post_create` is `POST /tama/memory/posts`).
- Keep live acceptance separate: credentials, source rate limiting, model
  tool-call behavior, and a completed action execution are runtime evidence
  described in [verification](verification.md).
