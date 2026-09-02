// @ts-check

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

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
  if (gitMissing) {
    throw prerequisiteError("Git is required to inspect the index before writing secret files", {
      root,
    });
  }
  if (notRepository) {
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

/**
 * Validates that a new secret file may be created at `filename` without
 * touching Git-managed content. A path outside any Git worktree is accepted
 * as-is. Inside a worktree, the path must be absent from the index and must
 * match a Git ignore rule; the command never edits `.gitignore` to satisfy
 * this check, so the operator chooses an already ignored path or a private
 * directory outside the repository. The name is passed to Git with a `./`
 * prefix so it is checked as the literal path, not as a pathspec whose
 * `:(...)` magic could redirect the checks to a different file.
 *
 * @param {string} directory
 *   Directory used to locate the Git worktree that would contain `filename`.
 * @param {string} filename
 */
export function validateNewSecretFile(directory, filename) {
  const environment = { ...process.env, LC_ALL: "C" };
  const worktree = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: environment,
  });
  const gitMissing = worktree.error && "code" in worktree.error && worktree.error.code === "ENOENT";
  const notRepository =
    typeof worktree.stderr === "string" && worktree.stderr.includes("not a git repository");
  if (gitMissing) {
    throw prerequisiteError("Git is required to inspect the worktree before writing the key file", {
      directory,
    });
  }
  if (notRepository) {
    return;
  }
  if (worktree.error || worktree.status !== 0) {
    throw prerequisiteError(
      "Unable to inspect the local Git worktree before writing the key file",
      {
        directory,
      },
    );
  }
  const worktreeRoot = worktree.stdout.trim();
  const relativePath = relative(worktreeRoot, filename);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return;
  }
  // The "./" prefix forces Git to treat the name as a literal path, so
  // ":(...)" pathspec magic inside a legal filename cannot redirect the
  // index or ignore check to a different path.
  const literalPath = `./${relativePath}`;
  const tracked = spawnSync(
    "git",
    ["-C", worktreeRoot, "ls-files", "--cached", "--", literalPath],
    {
      encoding: "utf8",
      env: environment,
    },
  );
  if (tracked.error || tracked.status !== 0) {
    throw prerequisiteError("Unable to inspect the local Git index before writing the key file", {
      directory,
    });
  }
  if (tracked.stdout.trim() !== "") {
    throw ownershipError(
      "Refusing to create the key file because the destination is in the Git index. Choose an untracked path or remove it from the index first.",
    );
  }
  const ignored = spawnSync(
    "git",
    ["-C", worktreeRoot, "check-ignore", "--no-index", "--quiet", "--", literalPath],
    { encoding: "utf8", env: environment },
  );
  if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) {
    throw prerequisiteError("Unable to inspect Git ignore rules before writing the key file", {
      directory,
    });
  }
  if (ignored.status === 1) {
    throw ownershipError(
      "Refusing to create the key file because the destination is not ignored by Git. Ignore the path or choose a private directory outside the repository.",
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
