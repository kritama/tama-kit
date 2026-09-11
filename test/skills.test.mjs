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
