import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { configure } from "../scripts/configure-mcp-plugin.mjs";
import { createDeterministicZip } from "../scripts/lib/deterministic-zip.mjs";
import {
  validatePublicExampleUrl,
  validateTemplateMatch,
} from "../scripts/lib/mcp-config.mjs";
import { validateRepository } from "../scripts/validate-submission.mjs";
import { buildInventory } from "../skills/graph-builder/scripts/inspect-tama-repository.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("submission metadata validates without a configured review endpoint", () => {
  const [manifest] = validateRepository(REPOSITORY_ROOT);
  assert.equal(manifest.name, "tama-kit");
});

test("Template MCP configuration writes a matching public example URL", () => {
  const root = mkdtempSync(join(tmpdir(), "tama-kit-config-"));
  mkdirSync(join(root, "submission"));
  writeFileSync(
    join(root, "submission", "portal.json"),
    JSON.stringify({
      mcpServer: {
        templateMcpServerURL: "https://{host}/mcp",
        exampleMcpServerURL: null,
      },
    }),
  );

  configure(root, "https://customer.tama.cloud/mcp");
  const portal = JSON.parse(readFileSync(join(root, "submission", "portal.json"), "utf8"));
  assert.equal(portal.mcpServer.exampleMcpServerURL, "https://customer.tama.cloud/mcp");
});

test("Template MCP URL validation rejects local endpoints and mismatches", () => {
  assert.throws(
    () => validatePublicExampleUrl("https://localhost/mcp"),
    /public, non-test hostname/u,
  );
  assert.throws(
    () => validatePublicExampleUrl("https://127.0.0.1/mcp"),
    /private or local IP/u,
  );
  assert.throws(
    () => validatePublicExampleUrl("https://[::ffff:7f00:1]/mcp"),
    /private or local IP/u,
  );
  assert.throws(
    () => validateTemplateMatch("https://{host}/mcp", "https://customer.tama.cloud/other"),
    /does not match/u,
  );
});

test("ZIP output is deterministic for identical ordered entries", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("alpha\n"), mode: 0o644 },
    { name: "nested/b.txt", data: Buffer.from("beta\n"), mode: 0o755 },
  ];
  const first = createDeterministicZip(entries);
  const second = createDeterministicZip(entries);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
});

test("Terraform inspector inventories the global foundation", () => {
  const root = mkdtempSync(join(tmpdir(), "tama-kit-inspector-"));
  writeFileSync(
    join(root, "main.tf"),
    [
      'module "global" {',
      '  source  = "upmaru/base/tama"',
      '  version = "1.2.3"',
      "}",
      "",
      'resource "tama_space" "example" {',
      '  name = module.global.name',
      "}",
      "",
    ].join("\n"),
  );

  const inventory = buildInventory(root);
  assert.equal(inventory.terraform_file_count, 1);
  assert.equal(inventory.declared.block_counts["resource.tama_space"], 1);
  assert.equal(inventory.global_foundation.status, "present");
  assert.equal(inventory.global_foundation.module_calls[0].declared_version, "1.2.3");
});
