import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("generated local instructions gate Docker runtime use", () => {
  const agents = readFileSync(resolve(ROOT, "cli/templates/bootstrap/AGENTS.md"), "utf8");
  const readme = readFileSync(resolve(ROOT, "cli/templates/bootstrap/README.md"), "utf8");

  for (const instructions of [agents, readme]) {
    assert.match(instructions, /docker --version/u);
    assert.match(instructions, /docker compose version/u);
    assert.match(instructions, /docker info --format/u);
    assert.match(instructions, /install or\s+start\/initialize Docker/u);
  }
});

test("graph-builder makes Terraform ownership of OpenAPI specifications explicit", () => {
  const skill = readFileSync(resolve(ROOT, "skills/graph-builder/SKILL.md"), "utf8");
  const external = readFileSync(
    resolve(ROOT, "skills/graph-builder/references/external-integrations.md"),
    "utf8",
  );
  const conversations = readFileSync(
    resolve(ROOT, "skills/graph-builder/references/conversation-graphs.md"),
    "utf8",
  );

  // The entrypoint applies the rule to action-backed graphs and routes to the reference.
  assert.match(skill, /tama_specification/u);
  assert.match(skill, /external-integrations\.md/u);
  assert.match(skill, /synchronous tool\/action terminal/u);

  // The reference carries the ownership, identity, resolution, and adoption guidance.
  assert.match(external, /data "http"/u);
  assert.match(external, /resource "tama_specification"/u);
  assert.match(external, /servers/u);
  assert.match(external, /OpenAPI format version/u);
  assert.match(external, /Tama's API/u);
  assert.match(external, /data "tama_action"/u);
  assert.match(external, /action_id\s*=\s+data\.tama_action\./u);
  assert.match(external, /does not bind a tool/u);

  // Conditional activation leaves lookup and tool uninstantiated until configured.
  assert.match(external, /for_each\s*=\s*var\.memory_api_operations/u);
  assert.match(external, /count = local\.remember_enabled \? 1 : 0/u);
  assert.match(external, /are not instantiated/u);

  // Adoption of an existing remote specification requires import and plan review.
  assert.match(external, /terraform import tama_specification/u);
  assert.match(external, /Review the plan before apply/u);
  assert.match(external, /Do not create a second specification/u);

  // Static validation stays distinct from live action acceptance.
  assert.match(external, /terraform validate/u);
  assert.match(external, /live acceptance/u);

  // Conversation examples resolve tools from the owned specification, not copied IDs.
  assert.match(conversations, /action_id\s*=\s*data\.tama_action\.create_results\.id/u);
  assert.match(conversations, /action_id\s*=\s*data\.tama_action\.create_artifact\.id/u);
  assert.match(conversations, /action_id\s*=\s*data\.tama_action\.create_search_artifact\.id/u);
  assert.doesNotMatch(conversations, /action_id\s*=\s*var\./u);
});
