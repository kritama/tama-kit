// @ts-check

import { join } from "node:path";

import { ownershipError } from "../errors.mjs";
import {
  validateSecretFilesIgnored as checkSecretFilesIgnored,
  validateSecretFilesUntracked as checkSecretFilesUntracked,
} from "../shared/git.mjs";
import { planIgnoreFile } from "../shared/ignore-file.mjs";
import { BOOTSTRAP_PATHS } from "./constants.mjs";

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
  return checkSecretFilesUntracked(root, secretFiles);
}

/** @param {string} root @param {string[]} [secretFiles] */
export function validateSecretFilesIgnored(root, secretFiles = SECRET_FILES) {
  return checkSecretFilesIgnored(root, secretFiles);
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
      [TAMA_MANAGED_BLOCK, LOCAL_HTTPS_IGNORE_BLOCK],
      removalPatterns,
    ),
  ];
}
