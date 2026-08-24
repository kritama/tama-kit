// @ts-check

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").WriteOperation} WriteOperation */

/**
 * @typedef {object} FileSnapshot
 * @property {string} path
 * @property {boolean} existed
 * @property {string} [content]
 * @property {number} [mode]
 */

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

/** @param {FileOperation[]} operations */
function snapshotOperations(operations) {
  /** @type {FileSnapshot[]} */
  const files = [];
  const directories = new Set();

  for (const operation of operations) {
    if (existsSync(operation.path)) {
      files.push({
        path: operation.path,
        existed: true,
        content: readFileSync(operation.path, "utf8"),
        mode: statSync(operation.path).mode & 0o777,
      });
      continue;
    }

    files.push({ path: operation.path, existed: false });
    let directory = dirname(operation.path);
    while (!existsSync(directory)) {
      directories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }

  return {
    files,
    directories: [...directories].sort(
      (left, right) => right.split(sep).length - left.split(sep).length,
    ),
  };
}

/** @param {ReturnType<typeof snapshotOperations>} snapshot */
function rollbackOperations(snapshot) {
  for (const file of [...snapshot.files].reverse()) {
    if (!file.existed) {
      if (existsSync(file.path)) {
        unlinkSync(file.path);
      }
      continue;
    }

    atomicWrite({
      action: "update",
      path: file.path,
      content: file.content ?? "",
      owner: "user",
      sensitive: false,
      mode: file.mode,
    });
  }

  for (const directory of snapshot.directories) {
    try {
      rmdirSync(directory);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        throw error;
      }
    }
  }
}

/**
 * @param {FileOperation[]} operations
 * @param {() => void | Promise<void>} validate
 */
export async function applyOperationsTransactionally(operations, validate) {
  const snapshot = snapshotOperations(operations);
  try {
    applyOperations(operations);
    await validate();
  } catch (error) {
    try {
      rollbackOperations(snapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "bootstrap failed and the generated file changes could not be fully rolled back",
      );
    }
    throw error;
  }
}
