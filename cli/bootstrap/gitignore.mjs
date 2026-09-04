// @ts-check

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { ownershipError, prerequisiteError } from "../errors.mjs";
import { BOOTSTRAP_PATHS } from "./constants.mjs";
import { operationForContent } from "./files.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */

const TAMA_MANAGED_BLOCK = [
  "# Tama Kit local runtime",
  "/.tama.env",
  "/.tama.postgres.env",
  "",
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
const SECRET_FILES = [BOOTSTRAP_PATHS.environment, BOOTSTRAP_PATHS.postgresEnvironment];
const MCP_APP_IGNORE_HEADER = "# Tama Kit MCP App integration";
const MCP_APP_IGNORE_HEADER_PATTERN = new RegExp(`^${MCP_APP_IGNORE_HEADER}$`, "u");
const LOCAL_HTTPS_IGNORE_BLOCK = ["# Tama Kit local HTTPS certificate material", "/tls/"].join(
  "\n",
);

/**
 * Matches the ignore line Tama Kit writes for one provider fragment, anchored
 * or unanchored. Removal is restricted to the fragments Tama Kit manages so
 * unrelated user-owned .integration.env entries survive.
 *
 * @param {string} file
 * @returns {RegExp}
 */
function fragmentLinePattern(file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\/?${escaped}$`, "u");
}

/** @param {string} file @returns {string} */
function tamaRelativeFragment(file) {
  const prefix = `${BOOTSTRAP_PATHS.tamaDirectory}/`;
  if (!file.startsWith(prefix) || file.length === prefix.length) {
    throw ownershipError(`Provider environment fragment must be inside ${prefix}: ${file}`, {
      path: file,
    });
  }
  return file.slice(prefix.length);
}

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
 * Confirms that every private environment file is effectively ignored after
 * the managed `.gitignore` operation has been written. Git evaluates the
 * nearest matching rule last, so checking the final rules prevents a nested
 * negation from leaving a generated secret exposed.
 *
 * @param {string} root
 * @param {string[]} [secretFiles]
 */
export function validateSecretFilesIgnored(root, secretFiles = SECRET_FILES) {
  const environment = { ...process.env, LC_ALL: "C" };
  const worktree = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    env: environment,
  });
  const gitMissing = worktree.error && "code" in worktree.error && worktree.error.code === "ENOENT";
  const notRepository =
    typeof worktree.stderr === "string" && worktree.stderr.includes("not a git repository");
  if (gitMissing) {
    throw prerequisiteError(
      "Git is required to verify ignore rules for private environment files",
      {
        root,
      },
    );
  }
  if (notRepository) {
    return;
  }
  if (worktree.error || worktree.status !== 0 || worktree.stdout.trim() !== "true") {
    throw prerequisiteError("Unable to inspect Git ignore rules for private environment files", {
      root,
    });
  }

  const notIgnored = [];
  for (const file of secretFiles) {
    const literalPath = `./${file}`;
    const ignored = spawnSync(
      "git",
      ["-C", root, "check-ignore", "--no-index", "--quiet", "--", literalPath],
      { encoding: "utf8", env: environment },
    );
    if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) {
      throw prerequisiteError("Unable to inspect Git ignore rules for private environment files", {
        root,
        file,
      });
    }
    if (ignored.status === 1) {
      notIgnored.push(file);
    }
  }
  if (notIgnored.length > 0) {
    throw ownershipError(
      `Refusing to continue because private environment files are not effectively ignored by Git: ${notIgnored.join(", ")}. A nested .gitignore may override the managed rule.`,
      { paths: notIgnored },
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

/**
 * @param {string} filename
 * @param {string} managedBlock
 * @param {string[]} [legacyBlocks]
 * @param {RegExp[]} [removalPatterns]
 *   Extra managed lines removed from the unmanaged content (for example an
 *   MCP App fragment from a previously configured provider).
 */
function planIgnoreFile(filename, managedBlock, legacyBlocks = [], removalPatterns = []) {
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  const unmanaged = withoutManagedBlocks(original, [...legacyBlocks, managedBlock]);
  const lines = [];
  let removedByPattern = false;
  for (const line of unmanaged.split("\n")) {
    if (removalPatterns.some((pattern) => pattern.test(line))) {
      removedByPattern = true;
      continue;
    }
    if (removedByPattern && line === "" && lines.at(-1) === "") {
      continue;
    }
    lines.push(line);
    removedByPattern = false;
  }
  const cleaned = lines.join("\n");
  const content = `${cleaned}${cleaned.length === 0 ? "" : "\n\n"}${managedBlock}\n`;
  return operationForContent(filename, content, { owner: "user", allowUnmanagedUpdate: true });
}

/**
 * @param {string} root
 * @param {{
 *   current: string | null,
 *   persisted: string | null,
 *   localHttps?: boolean,
 * }} [mcpAppFragments]
 *   The fragment the current run manages and the fragment a previous run
 *   persisted. Both lines may be removed; every other .integration.env line
 *   is user-owned and preserved.
 * @returns {FileOperation[]}
 */
export function planGitignore(root, mcpAppFragments = { current: null, persisted: null }) {
  const tamaLines = TAMA_MANAGED_BLOCK.split("\n");
  /** @type {RegExp[]} */
  const removalPatterns = [];
  if (mcpAppFragments.current !== null) {
    const current = tamaRelativeFragment(mcpAppFragments.current);
    tamaLines.push("", MCP_APP_IGNORE_HEADER, `/${current}`);
    const fragmentFiles = [
      ...new Set([
        current,
        ...(mcpAppFragments.persisted !== null
          ? [tamaRelativeFragment(mcpAppFragments.persisted)]
          : []),
      ]),
    ];
    removalPatterns.push(
      MCP_APP_IGNORE_HEADER_PATTERN,
      ...fragmentFiles.map((file) => fragmentLinePattern(file)),
    );
  }
  if (mcpAppFragments.localHttps) {
    tamaLines.push("", LOCAL_HTTPS_IGNORE_BLOCK);
  }
  return [
    planIgnoreFile(
      join(root, BOOTSTRAP_PATHS.tamaDirectory, ".gitignore"),
      tamaLines.join("\n"),
      [TAMA_MANAGED_BLOCK],
      removalPatterns,
    ),
  ];
}

/** @param {string} root @returns {FileOperation[]} */
export function planDevGitignore(root) {
  return [planIgnoreFile(join(root, ".gitignore"), DEV_ROOT_MANAGED_BLOCK)];
}
