// @ts-check

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";

import { ownershipError } from "../errors.mjs";
import { MANAGED_MARKER } from "./constants.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").FileOperationOptions} FileOperationOptions */

/** @param {string} content */
export function contentDigest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** @param {string} content */
export function hasManagedMarker(content) {
  const firstLine = content.split(/\r?\n/u, 1)[0];
  return (
    firstLine.startsWith(`# ${MANAGED_MARKER}`) || firstLine.startsWith(`<!-- ${MANAGED_MARKER}`)
  );
}

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
    return {
      action: "create",
      path: filename,
      content,
      owner,
      sensitive,
      mode,
      beforeDigest: null,
      afterDigest: contentDigest(content),
      reason: "file does not exist",
    };
  }
  const fileStats = lstatSync(filename);
  if (fileStats.isSymbolicLink()) {
    throw ownershipError(`refusing to update a symbolic link: ${filename}`, { path: filename });
  }

  const before = readFileSync(filename, "utf8");
  const beforeDigest = contentDigest(before);
  const afterDigest = contentDigest(content);
  if (before === content) {
    if (mode !== undefined && (fileStats.mode & 0o777) !== mode) {
      return {
        action: "update",
        path: filename,
        content,
        owner,
        sensitive,
        mode,
        beforeDigest,
        afterDigest,
        reason: "file permissions differ",
      };
    }
    return {
      action: "unchanged",
      path: filename,
      owner,
      sensitive,
      mode,
      beforeDigest,
      afterDigest,
      reason: "content and permissions match",
    };
  }
  if (!allowUnmanagedUpdate && !hasManagedMarker(before)) {
    throw ownershipError(`refusing to overwrite an unmanaged file: ${filename}`, {
      path: filename,
    });
  }
  return {
    action: "update",
    path: filename,
    content,
    owner,
    sensitive,
    mode,
    beforeDigest,
    afterDigest,
    reason: "managed content differs",
  };
}
