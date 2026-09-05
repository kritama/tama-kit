// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { operationForContent } from "./files.mjs";

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
export function planIgnoreFile(filename, managedBlock, legacyBlocks = [], removalPatterns = []) {
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
