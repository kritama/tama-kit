#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createDeterministicZip } from "./lib/deterministic-zip.mjs";
import { readJson, validateRepository } from "./validate-submission.mjs";

const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDED_PATHS = [
  ".codex-plugin",
  "assets",
  "skills",
  "LICENSE",
  "README.md",
  "package.json",
];

function archivePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function collectDirectory(root, directory, files) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new TypeError(
        `Submission archives cannot include symlinks: ${archivePath(root, path)}`,
      );
    }
    if (metadata.isDirectory()) {
      collectDirectory(root, path, files);
    } else if (metadata.isFile()) {
      files.push(path);
    }
  }
}

export function collectFiles(root) {
  const files = [];
  for (const item of INCLUDED_PATHS) {
    const path = join(root, item);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      throw new TypeError(`Required submission path is missing: ${item}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new TypeError(`Submission archives cannot include symlinks: ${item}`);
    }
    if (metadata.isFile()) {
      files.push(path);
    } else if (metadata.isDirectory()) {
      collectDirectory(root, path, files);
    } else {
      throw new TypeError(`Required submission path is not a file or directory: ${item}`);
    }
  }
  return files.sort((left, right) =>
    archivePath(root, left).localeCompare(archivePath(root, right), "en"),
  );
}

export function buildArchive(root, output) {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(output);
  const [manifest] = validateRepository(resolvedRoot, { reviewReady: true });
  const files = collectFiles(resolvedRoot);
  const entries = files.map((path) => {
    const metadata = lstatSync(path);
    return {
      name: archivePath(resolvedRoot, path),
      data: readFileSync(path),
      mode: metadata.mode & 0o7777,
    };
  });
  const archive = createDeterministicZip(entries);
  if (archive.length > 100 * 1024 * 1024) {
    throw new RangeError("Submission ZIP exceeds the 100 MB compressed limit");
  }

  mkdirSync(dirname(resolvedOutput), { recursive: true });
  const temporary = `${resolvedOutput}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, archive, { mode: 0o600 });
    renameSync(temporary, resolvedOutput);
  } finally {
    rmSync(temporary, { force: true });
  }

  const digest = createHash("sha256").update(archive).digest("hex");
  console.log(
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        archive: resolvedOutput,
        files: files.length,
        bytes: archive.length,
        sha256: digest,
      },
      null,
      2,
    ),
  );
  return resolvedOutput;
}

function usage() {
  return "Usage: build-submission-zip.mjs [--root <path>] [--output <zip>]";
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: ROOT_DEFAULT },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return 0;
  }
  const root = resolve(values.root);
  const manifest = readJson(join(root, ".codex-plugin", "plugin.json"));
  const output = values.output ?? join(root, "dist", `${manifest.name}-${manifest.version}.zip`);
  buildArchive(root, output);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Submission archive failed: ${error.message}`);
    process.exitCode = 1;
  }
}
