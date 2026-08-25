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
function withoutManagedBlocks(content) {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const managedLines = MANAGED_BLOCK.split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; ) {
    const candidate = lines.slice(index, index + managedLines.length);
    if (candidate.join("\n") === MANAGED_BLOCK) {
      index += managedLines.length;
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

/** @param {string} root @returns {FileOperation} */
export function planGitignore(root) {
  const filename = join(root, ".gitignore");
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  const unmanaged = withoutManagedBlocks(original);
  const content = `${unmanaged}${unmanaged.length === 0 ? "" : "\n\n"}${MANAGED_BLOCK}\n`;
  return operationForContent(filename, content, { owner: "user", allowUnmanagedUpdate: true });
}
