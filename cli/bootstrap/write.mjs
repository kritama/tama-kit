// @ts-check

import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").WriteOperation} WriteOperation */

/** @param {WriteOperation} operation */
function atomicWrite(operation) {
  const directory = dirname(operation.path);
  mkdirSync(directory, { recursive: true });
  const mode =
    operation.mode ??
    (operation.action === "update" ? statSync(operation.path).mode & 0o777 : 0o644);
  const temporary = join(
    directory,
    `.${basename(operation.path)}.tama-kit-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    writeFileSync(temporary, operation.content, {
      encoding: "utf8",
      mode,
    });
    if (operation.mode !== undefined || operation.action === "update") {
      chmodSync(temporary, mode);
    }
    renameSync(temporary, operation.path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

/** @param {FileOperation[]} operations */
export function applyOperations(operations) {
  for (const operation of operations) {
    if (operation.action === "unchanged") {
      if (operation.mode !== undefined) {
        chmodSync(operation.path, operation.mode);
      }
      continue;
    }
    atomicWrite(operation);
  }
}
