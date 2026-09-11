import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activationStep, lifecycleCheckpoint } from "../../cli/domain/lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("shared system operations do not depend on commands or workflow-specific policy", () => {
  const shared = join(root, "cli/shared");
  for (const name of readdirSync(shared)) {
    if (!name.endsWith(".mjs")) continue;
    const source = readFileSync(join(shared, name), "utf8");
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
      const target = resolve(shared, match[1]);
      for (const layer of ["commands", "workflows", "bootstrap", "dev", "output"]) {
        assert.equal(
          target.startsWith(join(root, "cli", layer) + sep),
          false,
          `${name} imports ${layer}`,
        );
      }
    }
  }
});

test("lifecycle decisions keep provider restart requirements distinct from enabled readiness", () => {
  assert.equal(lifecycleCheckpoint("enabled", "prepared").kind, "provider-restart-required");
  assert.equal(lifecycleCheckpoint("enabled", "enabled").kind, "enabled");
  for (const tama of ["disabled", "prepared", "enabled"]) {
    for (const provider of ["disabled", "prepared", "enabled"]) {
      assert.equal(activationStep(false, tama, provider).kind, "observe");
      assert.equal(
        activationStep(true, tama, provider).kind === "enable-tama",
        tama === "prepared" && provider === "prepared",
      );
    }
  }
});
