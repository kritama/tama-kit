#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SKIP_PARTS = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", "vendor"]);
const PROVIDER_PATTERN = /provider\s+"([^"]+)"\s*\{(.*?)\n\}/gsu;
const LOCK_VALUE_PATTERN = /^\s*(version|constraints)\s*=\s*"([^"]+)"/gmu;

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

function tokenizeHcl(text) {
  const tokens = [];
  let index = 0;
  let line = 1;

  const advance = () => {
    if (text[index] === "\n") {
      line += 1;
    }
    index += 1;
  };

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/u.test(character)) {
      advance();
      continue;
    }
    if (character === "#" || (character === "/" && next === "/")) {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      advance();
      advance();
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        advance();
      }
      if (index < text.length) {
        advance();
        advance();
      }
      continue;
    }

    if (character === "<" && next === "<") {
      const header = text
        .slice(index)
        .match(/^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[^\S\r\n]*(?:\r?\n|$)/u);
      if (header) {
        const tokenLine = line;
        const indented = header[1] === "-";
        const delimiter = header[2];
        for (let offset = 0; offset < header[0].length; offset += 1) {
          advance();
        }
        const bodyStart = index;
        while (index < text.length) {
          const lineStart = index;
          while (index < text.length && text[index] !== "\n") {
            index += 1;
          }
          const candidate = text.slice(lineStart, index).replace(/\r$/u, "");
          const comparable = indented ? candidate.trimStart() : candidate;
          if (comparable === delimiter) {
            const value = text.slice(bodyStart, lineStart);
            tokens.push({ type: "heredoc", value, line: tokenLine });
            if (index < text.length) {
              advance();
            }
            break;
          }
          if (index < text.length) {
            advance();
          }
        }
        continue;
      }
    }

    if (character === '"') {
      const tokenLine = line;
      let value = "";
      advance();
      while (index < text.length) {
        const current = text[index];
        if (current === "\\" && text[index + 1] !== undefined) {
          value += current + text[index + 1];
          advance();
          advance();
          continue;
        }
        if (current === '"') {
          advance();
          break;
        }
        value += current;
        advance();
      }
      tokens.push({ type: "string", value, line: tokenLine });
      continue;
    }

    const identifier = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/u);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0], line });
      index += identifier[0].length;
      continue;
    }

    tokens.push({ type: "symbol", value: character, line });
    advance();
  }

  return tokens;
}

function templateExpressions(value) {
  const expressions = [];
  let index = 0;
  while (index < value.length) {
    const marker = value[index];
    if (
      (marker === "$" || marker === "%") &&
      value[index + 1] === marker &&
      value[index + 2] === "{"
    ) {
      index += 3;
      continue;
    }
    if ((marker !== "$" && marker !== "%") || value[index + 1] !== "{") {
      index += 1;
      continue;
    }

    const start = index + 2;
    let depth = 1;
    let quoted = false;
    index = start;
    while (index < value.length && depth > 0) {
      const character = value[index];
      if (quoted && character === "\\" && value[index + 1] !== undefined) {
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        index += 1;
        continue;
      }
      if (!quoted && character === "{") {
        depth += 1;
      } else if (!quoted && character === "}") {
        depth -= 1;
      }
      index += 1;
    }
    if (depth === 0) {
      expressions.push(value.slice(start, index - 1));
    }
  }
  return expressions;
}

function countGlobalReferences(tokens) {
  let count = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type === "identifier" &&
      token.value === "module" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "global"
    ) {
      count += 1;
    }
    if (token.type === "string" || token.type === "heredoc") {
      for (const expression of templateExpressions(token.value)) {
        count += countGlobalReferences(tokenizeHcl(expression));
      }
    }
  }
  return count;
}

function parseDeclaredBlocks(root, files) {
  const counts = new Map();
  const moduleCalls = [];
  let globalReferenceCount = 0;

  const increment = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const path of files) {
    const tokens = tokenizeHcl(readFileSync(path, "utf8"));
    globalReferenceCount += countGlobalReferences(tokens);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (
        token.type === "identifier" &&
        (token.value === "resource" || token.value === "data") &&
        tokens[index + 1]?.type === "string" &&
        tokens[index + 2]?.type === "string" &&
        tokens[index + 3]?.value === "{"
      ) {
        increment(`${token.value}.${tokens[index + 1].value}`);
      }

      if (
        token.type !== "identifier" ||
        token.value !== "module" ||
        tokens[index + 1]?.type !== "string" ||
        tokens[index + 2]?.value !== "{"
      ) {
        continue;
      }

      increment("module");
      const name = tokens[index + 1].value;
      const startLine = token.line;
      let depth = 1;
      const values = {};
      index += 3;

      while (index < tokens.length && depth > 0) {
        const current = tokens[index];
        if (
          depth === 1 &&
          current.type === "identifier" &&
          (current.value === "source" || current.value === "version") &&
          tokens[index + 1]?.value === "=" &&
          tokens[index + 2]?.type === "string" &&
          !(current.value in values)
        ) {
          values[current.value] = tokens[index + 2].value;
        }
        if (current.value === "{") {
          depth += 1;
        } else if (current.value === "}") {
          depth -= 1;
        }
        index += 1;
      }

      moduleCalls.push({
        name,
        source: values.source ?? null,
        declared_version: values.version ?? null,
        file: relative(root, path).split("\\").join("/"),
        line: startLine,
      });
      index -= 1;
    }
  }

  return {
    block_counts: Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
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
    const resolved = directory ? (isAbsolute(directory) ? directory : join(root, directory)) : root;
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
  const globalStatus =
    globalCalls.length === 0 ? "missing" : globalCalls.length === 1 ? "present" : "multiple";
  const warnings = [];
  if (!existsSync(join(root, ".terraform.lock.hcl"))) {
    warnings.push("No .terraform.lock.hcl was found.");
  }
  if (installed.length === 0) {
    warnings.push("No .terraform/modules/modules.json was found; modules may be uninitialized.");
  }
  if (globalStatus === "missing") {
    warnings.push(
      "No global foundation module was found; verify whether this state or an external state owns it.",
    );
  } else if (globalStatus === "multiple") {
    warnings.push(
      "Multiple global foundation candidates were found; verify that exactly one Terraform state owns the Tama global foundation.",
    );
  }
  if (declared.global_reference_count > 0 && !globalCalls.some((call) => call.name === "global")) {
    warnings.push(
      "The configuration references module.global but does not declare that module address.",
    );
  }
  for (const call of globalCalls) {
    if (isRegistryGlobalSource(call.source) && !call.declared_version) {
      warnings.push(
        `module.${call.name} uses the registry global foundation without an explicit version pin.`,
      );
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
