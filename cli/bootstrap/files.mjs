// @ts-check

import { existsSync, lstatSync, readFileSync } from "node:fs";

import { ownershipError } from "../errors.mjs";
import { MANAGED_MARKER } from "./constants.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").FileOperationOptions} FileOperationOptions */

/**
 * @param {string} filename
 * @param {string} content
 * @param {FileOperationOptions} [options]
 * @returns {FileOperation}
 */
export function operationForContent(
  filename,
  content,
  { owner = "tama-kit", sensitive = false, mode, allowUnmanagedUpdate = false } = {},
) {
  if (!existsSync(filename)) {
    return { action: "create", path: filename, content, owner, sensitive, mode };
  }
  if (lstatSync(filename).isSymbolicLink()) {
    throw ownershipError(`refusing to update a symbolic link: ${filename}`, { path: filename });
  }

  const before = readFileSync(filename, "utf8");
  if (before === content) {
    return { action: "unchanged", path: filename, owner, sensitive, mode };
  }
  if (!allowUnmanagedUpdate && !before.includes(MANAGED_MARKER)) {
    throw ownershipError(`refusing to overwrite an unmanaged file: ${filename}`, { path: filename });
  }
  return { action: "update", path: filename, content, owner, sensitive, mode };
}
