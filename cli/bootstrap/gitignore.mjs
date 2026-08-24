import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { operationForContent } from "./files.mjs";

const PATTERNS = [
  ".tama.env",
  ".tama.postgres.env",
  "tama/.terraform/",
  "tama/*.tfstate",
  "tama/*.tfstate.*",
];

export function planGitignore(root) {
  const filename = join(root, ".gitignore");
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  const existing = new Set(original.split(/\r?\n/u));
  const missing = PATTERNS.filter((pattern) => !existing.has(pattern));
  if (missing.length === 0) {
    return { action: "unchanged", path: filename, owner: "user", sensitive: false };
  }

  const separator = original.length === 0 || original.endsWith("\n") ? "" : "\n";
  const leadingBlank = original.length === 0 ? "" : "\n";
  const content = `${original}${separator}${leadingBlank}# Tama Kit local runtime\n${missing.join("\n")}\n`;
  return operationForContent(filename, content, { owner: "user", allowUnmanagedUpdate: true });
}
