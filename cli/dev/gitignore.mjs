// @ts-check

import { join } from "node:path";
import { planIgnoreFile } from "../shared/ignore-file.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */

const DEV_ROOT_MANAGED_BLOCK = [
  "# Tama Kit development environment",
  "/.envrc",
  "/.tama.dev.postgres.env",
].join("\n");
/** @param {string} root @returns {FileOperation[]} */
export function planDevGitignore(root) {
  return [planIgnoreFile(join(root, ".gitignore"), DEV_ROOT_MANAGED_BLOCK)];
}
