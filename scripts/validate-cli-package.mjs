#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(realpathSync(tmpdir()), "tama-kit-package-"));
const cache = join(temporary, "npm-cache");
const consumer = join(temporary, "consumer");
const project = join(temporary, "project");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
function execute(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
try {
  mkdirSync(project);
  execute("npm", ["run", "build"]);
  const [packed] = JSON.parse(
    execute("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
      "--cache",
      cache,
    ]),
  );
  const paths = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "bin/tama-kit.mjs",
    "cli/workflows/bootstrap.mjs",
    "cli/workflows/mcp-app-runtime.mjs",
    "cli/domain/lifecycle.mjs",
    "cli/templates/bootstrap/compose.yaml",
    "cli/bootstrap/contracts/mcp-app-bootstrap-v1.json",
    "skills/tama-kit-cli/SKILL.md",
  ])
    assert.ok(paths.has(required), `missing runtime asset: ${required}`);
  assert.equal(
    [...paths].some((path) => path.endsWith(".mts")),
    false,
    "package should contain emitted ESM, not TypeScript source",
  );
  execute("npm", [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--prefix",
    consumer,
    "--cache",
    cache,
    join(temporary, packed.filename),
  ]);
  const installedRoot = join(consumer, "node_modules", metadata.name);
  const installed = join(installedRoot, "bin/tama-kit.mjs");
  const source = join(root, "bin/tama-kit.mjs");
  assert.equal(existsSync(join(consumer, "node_modules/typescript")), false);
  assert.equal(existsSync(join(installedRoot, "cli/workflows/bootstrap.mts")), false);
  for (const args of [
    ["--version"],
    ["--help"],
    ["bootstrap", "--help"],
    ["dev", "setup", "--help"],
    ["oauth", "generate-key", "--help"],
    ["bootstrap", project, "--dry-run", "--json", "--skills", "local"],
    ["init", project, "--dry-run", "--json", "--skills", "manual"],
    [
      "bootstrap",
      project,
      "--mcp-app",
      "--provider-name",
      "acme",
      "--dry-run",
      "--json",
      "--skills",
      "manual",
    ],
  ]) {
    const actual = execute(process.execPath, [installed, ...args], consumer);
    assert.equal(
      actual,
      execute(process.execPath, [source, ...args], consumer),
      `installed/source mismatch: ${args[0]}`,
    );
    if (args.includes("--json")) assert.equal(JSON.parse(actual).ok, true);
  }
  const key = join(temporary, "private.env");
  assert.equal(
    execute(
      process.execPath,
      [installed, "oauth", "generate-key", "--output", key],
      consumer,
    ).trim(),
    key,
  );
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(existsSync(join(project, "tama")), false, "package dry runs must not write");
  console.log(
    `Installed ${metadata.name}@${metadata.version}: ESM, assets, plans, aliases, help, and private-key output verified without development dependencies.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
