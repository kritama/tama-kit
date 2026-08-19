# Conversation graphs

These examples are domain-neutral graph-complete patterns. Replace module
versions, models, schemas, actions, variables, and prompts with values verified
in the target repository.

## Contents

- Routed component conversation
- Shared root reply with a path directive
- Direct forwarded action
- Conversation invariants

## Routed component conversation

Create the root, component, bridges, listener, semantic route target, and root
router:

```hcl
module "app-chat" {
  source  = "upmaru/base/tama//modules/messaging"
  version = "0.5.6" # Verify the installed version.

  depends_on = [module.global.schemas]
  name       = "App Chat"
}

resource "tama_space" "catalog-conversate" {
  name = "Catalog Conversate"
  type = "component"
}

resource "tama_space_bridge" "app-chat-to-catalog" {
  space_id        = module.app-chat.space_id
  target_space_id = tama_space.catalog-conversate.id
}

resource "tama_space_bridge" "catalog-to-app-chat" {
  space_id        = tama_space.catalog-conversate.id
  target_space_id = module.app-chat.space_id
}

resource "tama_space_bridge" "catalog-to-ui" {
  space_id        = tama_space.catalog-conversate.id
  target_space_id = var.ui_space_id
}

module "catalog-search-forwardable" {
  source  = "upmaru/base/tama//modules/forwardable-class"
  version = "0.5.6" # Verify the installed version.

  space_id    = tama_space.catalog-conversate.id
  title       = "catalog-search"
  description = file("catalog/search.md")
}

module "app-chat-router" {
  source  = "upmaru/base/tama//modules/router"
  version = "0.5.6" # Verify the installed version.

  root_messaging_space_id  = module.app-chat.space_id
  author_class_name        = module.app-chat.schemas.actor.name
  thread_class_name        = module.app-chat.schemas.thread.name
  message_class_name       = module.app-chat.schemas.user-message.name
  message_routing_class_id = module.global.schemas["message-routing"].id
  routable_class_ids       = [module.app-chat.schemas.user-message.id]
  focus_relations          = ["tooling", "reply"]
  prompt                   = file("chat/routing.md")
  routing_model_id         = var.routing_model_id
  routing_model_parameters = jsonencode(var.routing_model_parameters)
}

resource "tama_thought_path" "route-to-catalog-search" {
  depends_on = [tama_space_bridge.app-chat-to-catalog]

  thought_id      = module.app-chat-router.routing_thought_id
  target_class_id = module.catalog-search-forwardable.class.id
}

resource "tama_listener" "app-chat" {
  space_id = module.app-chat.space_id
  endpoint = var.listener_endpoint
  secret   = var.listener_secret
}

resource "tama_listener_topic" "user-message" {
  listener_id = tama_listener.app-chat.id
  class_id    = module.app-chat.schemas.user-message.id
}

resource "tama_listener_filter" "routing" {
  listener_id = tama_listener.app-chat.id
  chain_id    = module.app-chat-router.chain_id
}
```

Build the domain tooling and its post-tool route:

```hcl
resource "tama_chain" "catalog-search" {
  space_id = tama_space.catalog-conversate.id
  name     = "Catalog Search"
}

resource "tama_modular_thought" "catalog-search" {
  chain_id        = tama_chain.catalog-search.id
  index           = 0
  relation        = "search-tooling"
  output_class_id = module.global.schemas.tool-call.id

  module {
    reference = "tama/agentic/tooling"
    parameters = jsonencode({
      consecutive_limit = 5
      retry_on_codes     = [422]
      thread = {
        limit   = 5
        classes = module.app-chat.thread_classes
        relations = {
          routing = module.app-chat-router.routing_thought_relation
          focus   = ["search-tooling", "reply"]
        }
      }
    })
  }

  faculty {
    queue_id = var.conversation_queue_id
    priority = 0
  }
}

resource "tama_prompt" "catalog-search" {
  space_id = tama_space.catalog-conversate.id
  name     = "Catalog Search Tooling"
  role     = "system"
  content  = file("catalog-search/querying.md")
}

resource "tama_thought_context" "catalog-search" {
  thought_id = tama_modular_thought.catalog-search.id
  prompt_id  = tama_prompt.catalog-search.id
}

resource "tama_thought_context_input" "catalog-search-metadata" {
  thought_context_id = tama_thought_context.catalog-search.id
  type               = "metadata"
  class_corpus_id    = var.context_metadata_corpus_id
}

resource "tama_thought_processor" "catalog-search" {
  thought_id = tama_modular_thought.catalog-search.id
  model_id   = var.tooling_model_id

  completion {
    temperature = 0.0
    tool_choice = "required"
    parameters  = jsonencode(var.tooling_model_parameters)
  }
}

resource "tama_thought_tool" "create-catalog-results" {
  depends_on = [tama_space_bridge.catalog-to-ui]

  thought_id = tama_modular_thought.catalog-search.id
  action_id  = var.create_results_action_id
}

resource "tama_modular_thought" "catalog-search-routing" {
  chain_id        = tama_chain.catalog-search.id
  index           = 1
  relation        = "routing"
  output_class_id = module.global.schemas.message-routing.id

  module {
    reference = "tama/agentic/router"
    parameters = jsonencode({
      class_name = "class"
      properties = ["class", "confidence"]
      thread = {
        limit   = 7
        classes = module.app-chat.thread_classes
        relations = {
          routing = module.app-chat-router.routing_thought_relation
          focus   = ["search-tooling", "reply"]
        }
      }
    })
  }
}

resource "tama_thought_processor" "catalog-search-routing" {
  thought_id = tama_modular_thought.catalog-search-routing.id
  model_id   = var.routing_model_id

  completion {
    temperature = 0.0
    parameters  = jsonencode(var.routing_model_parameters)
  }
}

resource "tama_prompt" "catalog-search-routing" {
  space_id = tama_space.catalog-conversate.id
  name     = "Catalog Search Routing"
  role     = "system"
  content  = file("catalog-search/routing.md")
}

resource "tama_thought_context" "catalog-search-routing" {
  thought_id = tama_modular_thought.catalog-search-routing.id
  prompt_id  = tama_prompt.catalog-search-routing.id
}

resource "tama_node" "catalog-search" {
  space_id = tama_space.catalog-conversate.id
  class_id = module.catalog-search-forwardable.class.id
  chain_id = tama_chain.catalog-search.id
  type     = "reactive"
}

resource "tama_listener_filter" "catalog-search" {
  listener_id = tama_listener.app-chat.id
  chain_id    = tama_chain.catalog-search.id
}
```

## Shared root reply with a path directive

Define a root-owned artifact reply class and chain. The domain path uses a
directive to attach its rendering prompt to the shared artifact thought.

```hcl
module "response-with-artifact" {
  source  = "upmaru/base/tama//modules/forwardable-class"
  version = "0.5.6" # Verify the installed version.

  space_id    = module.app-chat.space_id
  title       = "response-with-artifact"
  description = "A root response that creates an artifact before replying."
}

resource "tama_chain" "root-artifact-reply" {
  space_id = module.app-chat.space_id
  name     = "Root Artifact Reply"
}

resource "tama_modular_thought" "root-artifact" {
  chain_id        = tama_chain.root-artifact-reply.id
  index           = 0
  relation        = "create-artifact"
  output_class_id = module.global.schemas.tool-call.id

  module {
    reference = "tama/agentic/tooling"
  }
}

resource "tama_thought_tool" "create-artifact" {
  thought_id = tama_modular_thought.root-artifact.id
  action_id  = var.create_artifact_action_id
}

resource "tama_thought_processor" "root-artifact" {
  thought_id = tama_modular_thought.root-artifact.id
  model_id   = var.artifact_model_id

  completion {
    temperature = 0.0
    tool_choice = "required"
    parameters  = jsonencode(var.artifact_model_parameters)
  }
}

resource "tama_modular_thought" "root-reply" {
  chain_id        = tama_chain.root-artifact-reply.id
  index           = 1
  relation        = "reply"
  output_class_id = module.global.schemas["assistant-response"].id

  module {
    reference = "tama/agentic/reply"
    parameters = jsonencode({
      thread = {
        limit   = 5
        classes = module.app-chat.thread_classes
        relations = {
          routing = module.app-chat-router.routing_thought_relation
          focus   = ["search-tooling", "create-artifact", "reply"]
        }
      }
    })
  }
}

resource "tama_thought_processor" "root-reply" {
  thought_id = tama_modular_thought.root-reply.id
  model_id   = var.reply_model_id

  completion {
    temperature = 0.0
    parameters  = jsonencode(var.reply_model_parameters)
  }
}

resource "tama_prompt" "root-reply" {
  space_id = module.app-chat.space_id
  name     = "Root Reply"
  role     = "system"
  content  = file("chat/reply.md")
}

resource "tama_thought_context" "root-reply" {
  thought_id = tama_modular_thought.root-reply.id
  prompt_id  = tama_prompt.root-reply.id
}

resource "tama_node" "root-artifact-reply" {
  space_id = module.app-chat.space_id
  class_id = module.response-with-artifact.class.id
  chain_id = tama_chain.root-artifact-reply.id
  type     = "reactive"
}

resource "tama_listener_filter" "root-artifact-reply" {
  listener_id = tama_listener.app-chat.id
  chain_id    = tama_chain.root-artifact-reply.id
}

resource "tama_prompt" "catalog-results-artifact" {
  space_id = tama_space.catalog-conversate.id
  name     = "Catalog Results Artifact"
  role     = "system"
  content  = file("catalog-search/artifact.md")
}

resource "tama_thought_path" "catalog-search-to-artifact" {
  depends_on = [tama_space_bridge.catalog-to-app-chat]

  thought_id      = tama_modular_thought.catalog-search-routing.id
  target_class_id = module.response-with-artifact.class.id
}

resource "tama_thought_path_directive" "catalog-results-artifact" {
  thought_path_id   = tama_thought_path.catalog-search-to-artifact.id
  prompt_id         = tama_prompt.catalog-results-artifact.id
  target_thought_id = tama_modular_thought.root-artifact.id
}
```

Add a separate path and a delegated text-only chain when plain text is a valid
branch:

```hcl
resource "tama_thought_path" "catalog-search-to-text" {
  depends_on = [tama_space_bridge.catalog-to-app-chat]

  thought_id      = tama_modular_thought.catalog-search-routing.id
  target_class_id = module.app-chat.schemas["response"].id
}

resource "tama_chain" "root-text-reply" {
  space_id = module.app-chat.space_id
  name     = "Root Text Reply"
}

resource "tama_delegated_thought" "root-text-reply" {
  chain_id        = tama_chain.root-text-reply.id
  index           = 0
  output_class_id = module.global.schemas["assistant-response"].id

  delegation {
    target_thought_id = tama_modular_thought.root-reply.id
  }
}

resource "tama_node" "root-text-reply" {
  space_id = module.app-chat.space_id
  class_id = module.app-chat.schemas["response"].id
  chain_id = tama_chain.root-text-reply.id
  type     = "reactive"
}

resource "tama_listener_filter" "root-text-reply" {
  listener_id = tama_listener.app-chat.id
  chain_id    = tama_chain.root-text-reply.id
}
```

## Direct forwarded action

Use this topology when every input performs one component action and the
external action is the terminal. A router and component-to-root return bridge
are intentionally absent.

```hcl
module "app-search" {
  source  = "upmaru/base/tama//modules/messaging"
  version = "0.5.6" # Verify the installed version.

  depends_on = [module.global.schemas]
  name       = "App Search"
}

resource "tama_space" "catalog-search" {
  name = "Catalog Search"
  type = "component"
}

resource "tama_space_bridge" "app-search-to-catalog" {
  space_id        = module.app-search.space_id
  target_space_id = tama_space.catalog-search.id
}

resource "tama_space_bridge" "catalog-search-to-ui" {
  space_id        = tama_space.catalog-search.id
  target_space_id = var.ui_space_id
}

module "catalog-search-forwardable" {
  source  = "upmaru/base/tama//modules/forwardable-class"
  version = "0.5.6" # Verify the installed version.

  space_id    = tama_space.catalog-search.id
  title       = "catalog-search"
  description = "A search request forwarded to the catalog component."
}

resource "tama_chain" "forward-to-catalog" {
  space_id = module.app-search.space_id
  name     = "Forward to Catalog"
}

resource "tama_modular_thought" "forward-to-catalog" {
  chain_id        = tama_chain.forward-to-catalog.id
  index           = 0
  relation        = "forwarding"
  output_class_id = module.global.schemas["forwarding"].id

  module {
    reference = "tama/concepts/forward"
  }
}

resource "tama_thought_path" "forward-to-catalog" {
  depends_on = [tama_space_bridge.app-search-to-catalog]

  thought_id      = tama_modular_thought.forward-to-catalog.id
  target_class_id = module.catalog-search-forwardable.class.id
}

resource "tama_node" "forward-user-message" {
  space_id = module.app-search.space_id
  class_id = module.app-search.schemas.user-message.id
  chain_id = tama_chain.forward-to-catalog.id
  type     = "reactive"
}

resource "tama_chain" "catalog-search-action" {
  space_id = tama_space.catalog-search.id
  name     = "Catalog Search Action"
}

resource "tama_modular_thought" "catalog-search-action" {
  chain_id        = tama_chain.catalog-search-action.id
  index           = 0
  relation        = "search-tooling"
  output_class_id = module.global.schemas.tool-call.id

  module {
    reference = "tama/agentic/tooling"
    parameters = jsonencode({
      consecutive_limit = 5
      thread = {
        limit   = 3
        classes = module.app-search.thread_classes
        relations = {
          routing = "forwarding"
          focus   = ["search-tooling"]
        }
      }
    })
  }
}

resource "tama_prompt" "catalog-search-action" {
  space_id = tama_space.catalog-search.id
  name     = "Catalog Search Action"
  role     = "system"
  content  = file("catalog-search/querying.md")
}

resource "tama_thought_context" "catalog-search-action" {
  thought_id = tama_modular_thought.catalog-search-action.id
  prompt_id  = tama_prompt.catalog-search-action.id
}

resource "tama_thought_context_input" "catalog-search-action-metadata" {
  thought_context_id = tama_thought_context.catalog-search-action.id
  type               = "metadata"
  class_corpus_id    = var.context_metadata_corpus_id
}

resource "tama_thought_processor" "catalog-search-action" {
  thought_id = tama_modular_thought.catalog-search-action.id
  model_id   = var.tooling_model_id

  completion {
    temperature = 0.0
    tool_choice = "required"
    parameters  = jsonencode(var.tooling_model_parameters)
  }
}

resource "tama_thought_tool" "create-search-artifact" {
  depends_on = [tama_space_bridge.catalog-search-to-ui]

  thought_id = tama_modular_thought.catalog-search-action.id
  action_id  = var.create_search_artifact_action_id
}

resource "tama_node" "catalog-search-action" {
  space_id = tama_space.catalog-search.id
  class_id = module.catalog-search-forwardable.class.id
  chain_id = tama_chain.catalog-search-action.id
  type     = "reactive"
}
```

The `create-search-artifact` action is the terminal contract.

## Conversation invariants

- Every router prompt class has a thought path.
- Every forwardable class has a handler in its owning space.
- Every cross-space handoff has a directional bridge.
- Every listener-dispatched chain has a filter when the listener model requires one.
- Every post-tool route has paths for all declared outcomes.
- Every branch-specific directive targets the shared thought that consumes its prompt.
- Plain and artifact replies remain semantically distinct.
- Direct-action graphs are not required to return to the root when the external action is the terminal.
