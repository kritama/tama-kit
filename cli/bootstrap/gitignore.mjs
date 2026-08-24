// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { operationForContent } from "./files.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */

const PATTERNS = [
  ".tama.env",
  ".tama.postgres.env",
  "tama/.terraform/",
  "tama/*.tfstate",
  "tama/*.tfstate.*",
];

const MANAGED_BLOCK = ["# Tama Kit local runtime", ...PATTERNS].join("\n");

/** @param {string} content */
function hasFinalManagedBlock(content) {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(-PATTERNS.length - 1).join("\n") === MANAGED_BLOCK;
}

/** @param {string} root @returns {FileOperation} */
export function planGitignore(root) {
  const filename = join(root, ".gitignore");
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  if (hasFinalManagedBlock(original)) {
    return { action: "unchanged", path: filename, owner: "user", sensitive: false };
  }

  const separator = original.length === 0 || original.endsWith("\n") ? "" : "\n";
  const leadingBlank = original.length === 0 ? "" : "\n";
  const content = `${original}${separator}${leadingBlank}${MANAGED_BLOCK}\n`;
  return operationForContent(filename, content, { owner: "user", allowUnmanagedUpdate: true });
}
