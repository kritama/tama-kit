#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SKIP_PARTS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", "vendor"]);
const BLOCK_PATTERN = /^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/u;
const MODULE_PATTERN = /^\s*module\s+"([^"]+)"\s*\{/u;
const ASSIGNMENT_PATTERN = /^\s*(source|version)\s*=\s*"([^"]+)"/u;
const PROVIDER_PATTERN = /provider\s+"([^"]+)"\s*\{(.*?)\n\}/gsu;
const LOCK_VALUE_PATTERN = /^\s*(version|constraints)\s*=\s*"([^"]+)"/gmu;
const GLOBAL_REFERENCE_PATTERN = /\bmodule\.global\b/gu;

function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isRegistryGlobalSource(source) {
  if (!source) {
    return false;
  }
  return source.replace(/^registry\.terraform\.io\//u, "") === "upmaru/base/tama";
}

function isGlobalFoundationCall(call) {
  const normalized = call.source?.replace(/^registry\.terraform\.io\//u, "") ?? "";
  const isRegistryHelper = normalized.startsWith("upmaru/base/tama//modules/");
  return isRegistryGlobalSource(call.source) || (call.name === "global" && !isRegistryHelper);
}

function collectTerraformFiles(root, directory = root, files = []) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  for (const entry of entries) {
    if (SKIP_PARTS.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTerraformFiles(root, path, files);
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      files.push(path);
    }
  }
  return files;
}

function collectRootTerraformFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
    .map((entry) => join(root, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function stripHclComments(text) {
  let output = "";
  let state = "code";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        output += "\n";
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "string") {
      output += character;
      if (character === "\\" && next !== undefined) {
        output += next;
        index += 1;
      } else if (character === '"') {
        state = "code";
      }
      continue;
    }

    if (character === '"') {
      output += character;
      state = "string";
    } else if (character === "#") {
      output += " ";
      state = "line-comment";
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
    } else {
      output += character;
    }
  }

  return output;
}

function parseDeclaredBlocks(root, files) {
  const counts = new Map();
  const moduleCalls = [];
  let globalReferenceCount = 0;

  const increment = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const path of files) {
    const text = stripHclComments(readFileSync(path, "utf8"));
    globalReferenceCount += [...text.matchAll(GLOBAL_REFERENCE_PATTERN)].length;
    const lines = text.split(/\r?\n/u);
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      const blockMatch = line.match(BLOCK_PATTERN);
      if (blockMatch) {
        increment(`${blockMatch[1]}.${blockMatch[2]}`);
      }

      const moduleMatch = line.match(MODULE_PATTERN);
      if (!moduleMatch) {
        index += 1;
        continue;
      }

      increment("module");
      const name = moduleMatch[1];
      const startLine = index + 1;
      let depth = [...line].filter((character) => character === "{").length;
      depth -= [...line].filter((character) => character === "}").length;
      const values = {};
      index += 1;

      while (index < lines.length && depth > 0) {
        const current = lines[index];
        const assignment = current.match(ASSIGNMENT_PATTERN);
        if (depth === 1 && assignment && !(assignment[1] in values)) {
          values[assignment[1]] = assignment[2];
        }
        depth += [...current].filter((character) => character === "{").length;
        depth -= [...current].filter((character) => character === "}").length;
        index += 1;
      }

      moduleCalls.push({
        name,
        source: values.source ?? null,
        declared_version: values.version ?? null,
        file: relative(root, path).split("\\").join("/"),
        line: startLine,
      });
    }
  }

  return {
    block_counts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))),
    module_calls: moduleCalls,
    global_reference_count: globalReferenceCount,
  };
}

function parseProviderLocks(root) {
  const lockPath = join(root, ".terraform.lock.hcl");
  if (!existsSync(lockPath)) {
    return [];
  }
  const text = readFileSync(lockPath, "utf8");
  const providers = [];
  for (const match of text.matchAll(PROVIDER_PATTERN)) {
    const values = {};
    for (const valueMatch of match[2].matchAll(LOCK_VALUE_PATTERN)) {
      values[valueMatch[1]] = valueMatch[2];
    }
    providers.push({
      source: match[1],
      version: values.version ?? null,
      constraints: values.constraints ?? null,
    });
  }
  return providers;
}

function parseInstalledModules(root) {
  const modulesPath = join(root, ".terraform", "modules", "modules.json");
  if (!existsSync(modulesPath)) {
    return [];
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(modulesPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${modulesPath}: ${error.message}`);
  }

  return (payload.Modules ?? []).map((item) => {
    const directory = item.Dir ?? null;
    const resolved = directory
      ? isAbsolute(directory)
        ? directory
        : join(root, directory)
      : root;
    return {
      key: item.Key ?? "",
      source: item.Source ?? "",
      version: item.Version ?? null,
      directory,
      directory_exists: existsSync(resolved),
    };
  });
}

export function buildInventory(root, { recursive = true } = {}) {
  const files = recursive ? collectTerraformFiles(root) : collectRootTerraformFiles(root);
  const declared = parseDeclaredBlocks(root, files);
  const installed = parseInstalledModules(root);
  const installedByKey = new Map(
    installed.filter((item) => item.key).map((item) => [item.key, item]),
  );

  for (const call of declared.module_calls) {
    const match = installedByKey.get(call.name);
    call.installed_version = match?.version ?? null;
    call.installed_directory = match?.directory ?? null;
  }

  const globalCalls = declared.module_calls.filter(isGlobalFoundationCall);
  const globalStatus = globalCalls.length === 0 ? "missing" : globalCalls.length === 1 ? "present" : "multiple";
  const warnings = [];
  if (!existsSync(join(root, ".terraform.lock.hcl"))) {
    warnings.push("No .terraform.lock.hcl was found.");
  }
  if (installed.length === 0) {
    warnings.push("No .terraform/modules/modules.json was found; modules may be uninitialized.");
  }
  if (globalStatus === "missing") {
    warnings.push("No global foundation module was found; verify whether this state or an external state owns it.");
  } else if (globalStatus === "multiple") {
    warnings.push("Multiple global foundation candidates were found; verify that exactly one Terraform state owns the Tama global foundation.");
  }
  if (
    declared.global_reference_count > 0 &&
    !globalCalls.some((call) => call.name === "global")
  ) {
    warnings.push("The configuration references module.global but does not declare that module address.");
  }
  for (const call of globalCalls) {
    if (isRegistryGlobalSource(call.source) && !call.declared_version) {
      warnings.push(`module.${call.name} uses the registry global foundation without an explicit version pin.`);
    }
    if (
      call.declared_version &&
      call.installed_version &&
      call.declared_version !== call.installed_version
    ) {
      warnings.push(
        `module.${call.name} declares global foundation version ${call.declared_version} ` +
          `but ${call.installed_version} is installed.`,
      );
    }
  }

  return {
    repository: root,
    terraform_file_count: files.length,
    provider_locks: parseProviderLocks(root),
    declared,
    global_foundation: {
      status: globalStatus,
      module_calls: globalCalls,
      module_global_reference_count: declared.global_reference_count,
    },
    installed_module_count: installed.length,
    installed_modules: installed,
    warnings,
  };
}

function printText(inventory, showAllModules) {
  console.log(`Repository: ${inventory.repository}`);
  console.log(`Terraform files: ${inventory.terraform_file_count}`);
  console.log("\nProvider locks:");
  if (inventory.provider_locks.length === 0) {
    console.log("  none");
  }
  for (const provider of inventory.provider_locks) {
    const constraints = provider.constraints ? ` constraints=${provider.constraints}` : "";
    console.log(`  ${provider.source}: version=${provider.version ?? "unknown"}${constraints}`);
  }

  console.log("\nDeclared Tama blocks:");
  const tamaCounts = Object.entries(inventory.declared.block_counts).filter(
    ([key]) => key.includes("tama_") || key === "module",
  );
  if (tamaCounts.length === 0) {
    console.log("  none");
  }
  for (const [key, value] of tamaCounts) {
    console.log(`  ${key}: ${value}`);
  }

  console.log("\nDeclared module calls:");
  if (inventory.declared.module_calls.length === 0) {
    console.log("  none");
  }
  for (const call of inventory.declared.module_calls) {
    console.log(
      `  ${call.file}:${call.line} module.${call.name} ` +
        `source=${call.source ?? "dynamic-or-unknown"} ` +
        `declared=${call.declared_version ?? "local-or-unpinned"} ` +
        `installed=${call.installed_version ?? "not-matched"}`,
    );
  }

  const foundation = inventory.global_foundation;
  console.log(`\nGlobal foundation: ${foundation.status}`);
  for (const call of foundation.module_calls) {
    console.log(
      `  ${call.file}:${call.line} module.${call.name} ` +
        `source=${call.source ?? "dynamic-or-local"} ` +
        `declared=${call.declared_version ?? "local-or-unpinned"} ` +
        `installed=${call.installed_version ?? "not-matched"}`,
    );
  }
  console.log(`  module.global references: ${foundation.module_global_reference_count}`);

  console.log(`\nInstalled modules: ${inventory.installed_module_count}`);
  if (showAllModules) {
    for (const module of inventory.installed_modules) {
      if (!module.key) {
        continue;
      }
      console.log(
        `  ${module.key}: source=${module.source} version=${module.version ?? "local"} ` +
          `dir=${module.directory} exists=${module.directory_exists ? "yes" : "no"}`,
      );
    }
  }
  for (const warning of inventory.warnings) {
    console.error(`\nWarning: ${warning}`);
  }
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function usage() {
  return [
    "Usage: inspect-tama-repository.mjs [--json] [--all-modules] [repository]",
    "",
    "Inventory Tama Terraform versions, installed modules, and declared blocks.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      "all-modules": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (positionals.length > 1) {
    throw new TypeError(usage());
  }

  const root = resolve(expandHome(positionals[0] ?? "."));
  let metadata;
  try {
    metadata = statSync(root);
  } catch {
    throw new TypeError(`repository is not a directory: ${root}`);
  }
  if (!metadata.isDirectory()) {
    throw new TypeError(`repository is not a directory: ${root}`);
  }

  const inventory = buildInventory(root);
  if (values.json) {
    console.log(JSON.stringify(sortJson(inventory), null, 2));
  } else {
    printText(inventory, values["all-modules"]);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
