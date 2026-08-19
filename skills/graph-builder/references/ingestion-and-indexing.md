# Ingestion and indexing

Use these patterns for API-backed records, nested extraction, relation
networks, generated enrichment, embeddings, external indexing, and batch
reprocessing. Replace versions and interfaces with installed definitions.

## Contents

- Source and identity
- Crawler fan-out
- Extraction and relations
- Awaited enrichment and embeddings
- Explicit and class-level reprocessing
- Processed-record indexing
- Sibling-domain parity

## Source and identity

Register an API specification, identity, and rate limit in the data-owning
space. Never commit secrets.

```hcl
resource "tama_space" "catalog" {
  name = "Catalog"
  type = "component"
}

data "http" "catalog_api" {
  url = var.catalog_openapi_url
}

resource "tama_specification" "catalog_api" {
  space_id = tama_space.catalog.id
  endpoint = var.catalog_openapi_url
  version  = "3.0.0"
  schema   = jsonencode(jsondecode(data.http.catalog_api.response_body))

  wait_for {
    field {
      name = "current_state"
      in   = ["completed", "failed"]
    }
  }
}

resource "tama_source_identity" "catalog_api" {
  specification_id = tama_specification.catalog_api.id
  identifier       = "api-key"
  api_key          = var.catalog_api_key

  validation {
    path   = "/health"
    method = "GET"
    codes  = [200]
  }
}

data "tama_source" "catalog_api" {
  specification_id = tama_specification.catalog_api.id
  slug             = "catalog-api"
}

resource "tama_source_limit" "catalog_api" {
  source_id   = data.tama_source.catalog_api.id
  scale_count = 1
  scale_unit  = "seconds"
  value       = 20
}
```

## Crawler fan-out

Use separate crawler branches when one source record independently produces
detail, keyword, availability, or relationship records.

```hcl
data "tama_class" "catalog_item" {
  specification_id = tama_specification.catalog_api.id
  name             = "catalog-item"
}

data "tama_class" "catalog_item_relations" {
  specification_id = tama_specification.catalog_api.id
  name             = "catalog-item-relations"
}

data "tama_class" "catalog_item_keywords" {
  specification_id = tama_specification.catalog_api.id
  name             = "catalog-item-keywords"
}

data "tama_action" "get_relations" {
  specification_id = tama_specification.catalog_api.id
  method           = "GET"
  path             = "/items/{item_id}/relations"
}

data "tama_action" "get_keywords" {
  specification_id = tama_specification.catalog_api.id
  method           = "GET"
  path             = "/items/{item_id}/keywords"
}

resource "tama_class_corpus" "catalog_item_request" {
  class_id = data.tama_class.catalog_item.id
  name     = "Catalog Item Request"
  template = file("${path.module}/catalog-item-request.liquid")
}

module "crawl-catalog-relations" {
  source  = "upmaru/base/tama//modules/crawler"
  version = "0.5.6" # Verify the installed version.

  name                    = "Crawl Catalog Relations"
  space_id                = tama_space.catalog.id
  origin_class_id         = data.tama_class.catalog_item.id
  request_input_corpus_id = tama_class_corpus.catalog_item_request.id
  request_relation        = "get-catalog-relations"
  request_action_id       = data.tama_action.get_relations.id
  response_relation       = "create-catalog-relations"
  validate_record         = false
}

module "crawl-catalog-keywords" {
  source  = "upmaru/base/tama//modules/crawler"
  version = "0.5.6" # Verify the installed version.

  name                    = "Crawl Catalog Keywords"
  space_id                = tama_space.catalog.id
  origin_class_id         = data.tama_class.catalog_item.id
  request_input_corpus_id = tama_class_corpus.catalog_item_request.id
  request_relation        = "get-catalog-keywords"
  request_action_id       = data.tama_action.get_keywords.id
  response_relation       = "create-catalog-keywords"
  validate_record         = false
}

resource "tama_node" "crawl-catalog-keywords-explicit" {
  space_id = tama_space.catalog.id
  class_id = data.tama_class.catalog_item.id
  chain_id = module.crawl-catalog-keywords.chain_id
  type     = "explicit"
}
```

The explicit node supports targeted retries without changing the crawler's
normal reactive behavior.

## Extraction and relations

Split nested arrays, spread selected fields into child classes, and build each
parent relationship explicitly:

```hcl
module "extract-catalog-relations" {
  source  = "upmaru/base/tama//modules/extract-nested-properties"
  version = "0.5.6" # Verify the installed version.

  class_names         = ["catalog-item-relations"]
  specification_id    = tama_specification.catalog_api.id
  space_id            = tama_space.catalog.id
  types               = ["array"]
  depth               = 1
  expected_class_names = [
    "catalog-item-relations.people",
    "catalog-item-relations.organizations"
  ]
}

locals {
  people_class_id = module.extract-catalog-relations.extracted_class_ids["catalog-item-relations.people"]
  organizations_class_id = module.extract-catalog-relations.extracted_class_ids["catalog-item-relations.organizations"]
}

module "spread-catalog-relations" {
  source  = "upmaru/base/tama//modules/spread"
  version = "0.5.6" # Verify the installed version.

  name             = "Spread Catalog Relations"
  space_id         = tama_space.catalog.id
  class_id         = data.tama_class.catalog_item_relations.id
  fields           = ["people", "organizations"]
  target_class_ids = [local.people_class_id, local.organizations_class_id]
  identifier       = "id"
}

module "network-catalog-relations" {
  source  = "upmaru/base/tama//modules/build-relations"
  version = "0.5.6" # Verify the installed version.

  name                    = "Network Catalog Relations"
  space_id                = tama_space.catalog.id
  class_ids               = [data.tama_class.catalog_item_relations.id]
  can_belong_to_class_ids = [data.tama_class.catalog_item.id]
}

module "network-catalog-children" {
  source  = "upmaru/base/tama//modules/build-relations"
  version = "0.5.6" # Verify the installed version.

  name                    = "Network Catalog Children"
  space_id                = tama_space.catalog.id
  class_ids               = [local.people_class_id, local.organizations_class_id]
  can_belong_to_class_ids = [data.tama_class.catalog_item_relations.id]
}
```

Verify that crawler response records preserve the source identifier used by
relation builders and later preloads.

## Awaited enrichment and embeddings

Wait for an independently produced relation before generating enrichment. Load
only the children consumed by the prompt.

```hcl
resource "tama_prompt" "generate-catalog-description" {
  space_id = tama_space.catalog.id
  name     = "Generate Catalog Description"
  role     = "user"
  content  = file("${path.module}/generate-description.md")
}

resource "tama_class" "catalog-setting" {
  space_id   = tama_space.catalog.id
  schema_json = jsonencode(jsondecode(file("${path.module}/catalog-setting.json")))
}

resource "tama_class_corpus" "catalog-setting-content" {
  class_id = tama_class.catalog-setting.id
  name     = "Catalog Setting Content"
  template = "{{ data.reason }}"
}

resource "tama_chain" "generate-catalog-enrichment" {
  space_id = tama_space.catalog.id
  name     = "Generate Catalog Enrichment"
}

resource "tama_modular_thought" "generate-catalog-description" {
  chain_id = tama_chain.generate-catalog-enrichment.id
  index    = 0
  relation = "description"

  module {
    reference = "tama/agentic/generate"
    parameters = jsonencode({
      await = {
        relations               = ["create-catalog-keywords"]
        created_in_last_seconds = 604800
        max_attempts            = 15
      }
    })
  }
}

module "catalog-keywords-preloader" {
  source  = "upmaru/base/tama//modules/initializer-preload"
  version = "0.5.6" # Verify the installed version.

  thought_id = tama_modular_thought.generate-catalog-description.id
  class_id   = data.tama_class.catalog_item.id
  index      = 0

  children = [
    {
      class = "catalog-item-keywords"
      as    = "object"
      record = {
        rejections = [{ element = "value", matches = [""] }]
      }
    }
  ]
}

resource "tama_thought_context" "generate-catalog-description" {
  thought_id = tama_modular_thought.generate-catalog-description.id
  prompt_id  = tama_prompt.generate-catalog-description.id
}

resource "tama_thought_context_input" "catalog-item" {
  thought_context_id = tama_thought_context.generate-catalog-description.id
  type               = "entity"
  class_corpus_id    = var.catalog_item_json_corpus_id
}

resource "tama_thought_processor" "generate-catalog-description" {
  thought_id = tama_modular_thought.generate-catalog-description.id
  model_id   = var.generation_model_id

  completion {
    temperature = 0.0
    parameters  = jsonencode(var.generation_model_parameters)
  }
}

resource "tama_modular_thought" "embed-catalog-description" {
  chain_id = tama_chain.generate-catalog-enrichment.id
  index    = 1
  relation = "embed-description"

  module {
    reference = "tama/concepts/embed"
    parameters = jsonencode({ relation = "description" })
  }
}

resource "tama_thought_module_input" "embed-catalog-description" {
  thought_id      = tama_modular_thought.embed-catalog-description.id
  type            = "concept"
  class_corpus_id = var.answer_content_corpus_id
}

resource "tama_node" "catalog-enrichment-reactive" {
  space_id = tama_space.catalog.id
  class_id = data.tama_class.catalog_item.id
  chain_id = tama_chain.generate-catalog-enrichment.id
  type     = "reactive"
}

resource "tama_node" "catalog-enrichment-explicit" {
  space_id = tama_space.catalog.id
  class_id = data.tama_class.catalog_item.id
  chain_id = tama_chain.generate-catalog-enrichment.id
  type     = "explicit"
}
```

The awaited `create-catalog-keywords` relation must be produced by a real
upstream crawler. Define timeout behavior for missing or failed keyword data.

## Explicit and class-level reprocessing

Use a class-processing chain plus path activation to regenerate all entities in
a selected class through the explicit enrichment chain:

```hcl
resource "tama_chain" "regenerate-class-entities" {
  space_id = tama_space.catalog.id
  name     = "Regenerate Class Entities"
}

resource "tama_modular_thought" "regenerate-class-entities" {
  chain_id        = tama_chain.regenerate-class-entities.id
  index           = 0
  relation        = "regenerate-details"
  output_class_id = var.task_result_class_id

  module {
    reference = "tama/classes/process"
  }
}

resource "tama_thought_path" "regenerate-catalog-items" {
  thought_id      = tama_modular_thought.regenerate-class-entities.id
  target_class_id = data.tama_class.catalog_item.id
}

resource "tama_thought_path_activation" "regenerate-catalog-enrichment" {
  thought_path_id = tama_thought_path.regenerate-catalog-items.id
  chain_id        = tama_chain.generate-catalog-enrichment.id
}

resource "tama_node" "regenerate-class-entities" {
  space_id = tama_space.catalog.id
  class_id = var.class_proxy_class_id
  chain_id = tama_chain.regenerate-class-entities.id
  type     = "explicit"
}
```

## Processed-record indexing

Merge generated concepts and related children into a stable document, then
index only after the source entity reaches the intended lifecycle state.

```hcl
resource "tama_space_bridge" "catalog-to-search-index" {
  space_id        = tama_space.catalog.id
  target_space_id = var.search_index_space_id
}

resource "tama_class_corpus" "catalog-item-indexing" {
  class_id = data.tama_class.catalog_item.id
  name     = "Catalog Item Indexing"
  template = file("${path.module}/document-indexing.liquid")
}

data "tama_action" "index_document" {
  specification_id = var.search_index_specification_id
  method           = "PUT"
  path             = "/{index}/_doc/{id}"
}

resource "tama_chain" "index-catalog-item" {
  space_id = tama_space.catalog.id
  name     = "Index Catalog Item"
}

resource "tama_modular_thought" "index-catalog-item" {
  chain_id = tama_chain.index-catalog-item.id
  index    = 0
  relation = "index-catalog-item"

  module {
    reference = "tama/actions/caller"
  }

  faculty {
    queue_id = var.indexing_queue_id
    priority = 0
  }
}

resource "tama_thought_pruning" "index-catalog-item" {
  thought_id              = tama_modular_thought.index-catalog-item.id
  previous_versions_count = 0
}

module "catalog-item-index-preloader" {
  source  = "upmaru/base/tama//modules/initializer-preload"
  version = "0.5.6" # Verify the installed version.

  thought_id = tama_modular_thought.index-catalog-item.id
  class_id   = data.tama_class.catalog_item.id
  index      = 0

  concept_relations  = ["description", "overview", "setting"]
  concept_embeddings = "include"
  concept_content = {
    action = "merge"
    merge  = { location = "root", name = "merge" }
  }

  record_rejections = [{ element = "value", matches = [""] }]

  children = [
    {
      class = "catalog-item-relations"
      as    = "object"
      record = {
        rejections = [{ element = "value", matches = [""] }]
      }
    }
  ]
}

resource "tama_thought_module_input" "index-catalog-item" {
  thought_id      = tama_modular_thought.index-catalog-item.id
  type            = "entity"
  class_corpus_id = tama_class_corpus.catalog-item-indexing.id
}

resource "tama_thought_tool" "index-catalog-item" {
  depends_on = [tama_space_bridge.catalog-to-search-index]

  thought_id = tama_modular_thought.index-catalog-item.id
  action_id  = data.tama_action.index_document.id
}

resource "tama_node" "index-catalog-item-on-processed" {
  space_id = tama_space.catalog.id
  class_id = data.tama_class.catalog_item.id
  chain_id = tama_chain.index-catalog-item.id
  type     = "reactive"
  on       = "processed"
}
```

## Sibling-domain parity

For parallel domains, compare rather than copy blindly:

| Contract | Domain A | Domain B |
|---|---|---|
| Source class and ID field | | |
| Detail/keyword/relationship actions | | |
| Crawler relations | | |
| Extracted child classes | | |
| Parent relation builders | | |
| Await relation | | |
| Generated concepts and embeddings | | |
| Reactive and explicit nodes | | |
| Class-level activation | | |
| Index corpus, preload children, and document ID | | |
| Queue, pruning, and lifecycle state | | |

Parity means equivalent capability, not shared class names or forced coupling.
Verify and operate each domain independently.
