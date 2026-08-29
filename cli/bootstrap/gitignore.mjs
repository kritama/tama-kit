// @ts-check

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ownershipError, prerequisiteError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */

const ROOT_MANAGED_BLOCK = ["# Tama Kit local runtime", ".tama.env", ".tama.postgres.env"].join(
  "\n",
);
const LEGACY_ROOT_MANAGED_BLOCK = [
  ROOT_MANAGED_BLOCK,
  "tama/.terraform/",
  "tama/*.tfstate",
  "tama/*.tfstate.*",
].join("\n");
const TERRAFORM_MANAGED_BLOCK = [
  "# Tama Kit Terraform local state",
  ".terraform/",
  "*.tfstate",
  "*.tfstate.*",
].join("\n");
const DEV_ROOT_MANAGED_BLOCK = [
  "# Tama Kit development environment",
  "/.envrc",
  "/.tama.dev.postgres.env",
].join("\n");
const SECRET_FILES = [".tama.env", ".tama.postgres.env"];

/** @param {string} root @param {string[]} [secretFiles] */
export function validateSecretFilesUntracked(root, secretFiles = SECRET_FILES) {
  const worktree = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const gitMissing = worktree.error && "code" in worktree.error && worktree.error.code === "ENOENT";
  const notRepository =
    typeof worktree.stderr === "string" && worktree.stderr.includes("not a git repository");
  if (gitMissing || notRepository) {
    return;
  }
  if (worktree.error || worktree.status !== 0 || worktree.stdout.trim() !== "true") {
    throw prerequisiteError("Unable to inspect the local Git index before writing secret files", {
      root,
    });
  }

  const tracked = spawnSync("git", ["-C", root, "ls-files", "--cached", "--", ...secretFiles], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (tracked.error || tracked.status !== 0) {
    throw prerequisiteError("Unable to inspect the local Git index before writing secret files", {
      root,
    });
  }
  const paths = tracked.stdout.split(/\r?\n/u).filter(Boolean);
  if (paths.length > 0) {
    throw ownershipError(
      `Refusing to continue because private environment files are tracked by Git: ${paths.join(", ")}. Untrack them with: git rm --cached -- ${paths.join(" ")}`,
      { paths },
    );
  }
}

/** @param {string} content @param {string[]} managedBlocks */
function withoutManagedBlocks(content, managedBlocks) {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; ) {
    const matched = managedBlocks.find((block) => {
      const managedLines = block.split("\n");
      return lines.slice(index, index + managedLines.length).join("\n") === block;
    });
    if (matched) {
      index += matched.split("\n").length;
      if (kept.at(-1) === "" && lines[index] === "") {
        index += 1;
      }
      continue;
    }
    kept.push(lines[index]);
    index += 1;
  }
  while (kept.at(-1) === "") {
    kept.pop();
  }
  return kept.join("\n");
}

/** @param {string} filename @param {string} managedBlock @param {string[]} [legacyBlocks] */
function planIgnoreFile(filename, managedBlock, legacyBlocks = []) {
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  const unmanaged = withoutManagedBlocks(original, [...legacyBlocks, managedBlock]);
  const content = `${unmanaged}${unmanaged.length === 0 ? "" : "\n\n"}${managedBlock}\n`;
  return operationForContent(filename, content, { owner: "user", allowUnmanagedUpdate: true });
}

/** @param {string} root @returns {FileOperation[]} */
export function planGitignore(root) {
  return [
    planIgnoreFile(join(root, ".gitignore"), ROOT_MANAGED_BLOCK, [LEGACY_ROOT_MANAGED_BLOCK]),
    planIgnoreFile(join(root, "tama", ".gitignore"), TERRAFORM_MANAGED_BLOCK),
  ];
}

/** @param {string} root @returns {FileOperation[]} */
export function planDevGitignore(root) {
  return [planIgnoreFile(join(root, ".gitignore"), DEV_ROOT_MANAGED_BLOCK)];
}
