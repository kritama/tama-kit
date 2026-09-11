// @ts-check

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ownershipError } from "../errors.mjs";
import { contentDigest, inspectRegularFile } from "./files.mjs";
import { writeExclusiveSecretFile } from "./secret-file.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {import("../types.mjs").WriteOperation} WriteOperation */
/** @typedef {{content: string, digest: string, metadata: import("node:fs").Stats} | null} FileState */
/** @typedef {Map<string, import("node:fs").Stats>} Directories */

/** @param {string} filename @returns {FileState} */
function readState(filename) {
  const metadata = inspectRegularFile(filename);
  if (metadata === null) return null;
  const content = readFileSync(filename, "utf8");
  return { content, digest: contentDigest(content), metadata };
}

/** @param {import("node:fs").Stats} left @param {import("node:fs").Stats} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {FileState} left @param {FileState} right */
function sameState(left, right) {
  return left === null || right === null
    ? left === right
    : left.digest === right.digest &&
        sameIdentity(left.metadata, right.metadata) &&
        left.metadata.mode === right.metadata.mode &&
        left.metadata.uid === right.metadata.uid &&
        left.metadata.gid === right.metadata.gid;
}

/** @param {string} path */
function changed(path) {
  return ownershipError("file changed during the operation; preserving current content", { path });
}

/** @param {string} filename @param {Directories} directories */
function checkDirectories(filename, directories) {
  let directory = dirname(resolve(filename));
  while (true) {
    const expected = directories.get(directory);
    if (expected) {
      const current = lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
        throw changed(filename);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

/** Plan-wide checks happen before the first mutation, then again immediately before each write.
 * @param {FileOperation[]} operations
 */
function prepareOperations(operations) {
  const paths = new Set();
  /** @type {Directories} */
  const directories = new Map();
  const entries = operations.map((operation) => {
    const path = resolve(operation.path);
    if (paths.has(path)) throw ownershipError("duplicate write destination", { path });
    paths.add(path);
    const before = readState(path);
    if (
      (operation.action === "create" && before !== null) ||
      (operation.action !== "create" &&
        (before === null || before.digest !== operation.beforeDigest))
    ) {
      throw changed(path);
    }
    if (
      (operation.action === "create" || operation.action === "update") &&
      contentDigest(operation.content) !== operation.afterDigest
    ) {
      throw ownershipError("write content does not match the reviewed operation", { path });
    }
    let directory = dirname(path);
    while (true) {
      try {
        directories.set(directory, lstatSync(directory));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return { operation, before };
  });
  return { entries, directories };
}

/** Record only directories this operation creates, not arbitrary missing snapshot paths.
 * @param {string} directory @param {Directories} directories @param {Directories} created
 */
function ensureDirectory(directory, directories, created) {
  if (directories.has(directory)) return;
  const parent = dirname(directory);
  if (parent !== directory) ensureDirectory(parent, directories, created);
  mkdirSync(directory);
  const metadata = lstatSync(directory);
  directories.set(directory, metadata);
  created.set(directory, metadata);
}

/** @param {WriteOperation} operation @param {FileState} before @param {(after: FileState) => void} [onWrite] @param {import("node:fs").Stats} [restoreOwner] */
function atomicWrite(operation, before, onWrite = () => {}, restoreOwner) {
  const directory = dirname(operation.path);
  if (operation.action === "create" && operation.sensitive) {
    writeExclusiveSecretFile(directory, basename(operation.path), operation.content);
    onWrite(readState(operation.path));
    return;
  }
  const mode = operation.mode ?? (before ? before.metadata.mode & 0o777 : 0o644);
  const temporary = join(
    directory,
    `.${basename(operation.path)}.tama-kit-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  let failure;
  let temporaryCreated = false;
  try {
    const descriptor = openSync(temporary, "wx", mode);
    temporaryCreated = true;
    try {
      writeFileSync(descriptor, operation.content, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    const owner = restoreOwner ?? before?.metadata;
    if (owner && process.platform !== "win32") {
      chownSync(temporary, owner.uid, owner.gid);
    }
    chmodSync(temporary, mode);
    const after = {
      content: operation.content,
      digest: operation.afterDigest,
      metadata: lstatSync(temporary),
    };
    if (!sameState(readState(operation.path), before)) throw changed(operation.path);
    if (operation.action === "create") {
      // Publishing a new inode with link is exclusive; rename would overwrite a late arrival.
      linkSync(temporary, operation.path);
    } else {
      renameSync(temporary, operation.path);
    }
    onWrite(after);
  } catch (error) {
    failure = error;
  }
  try {
    if (temporaryCreated) unlinkSync(temporary);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
      failure ??= error;
  }
  if (failure) throw failure;
}

/** @typedef {{operation: FileOperation, before: FileState, after: FileState}} AppliedEntry */

/** @param {AppliedEntry[]} applied @param {AppliedEntry} entry */
function recordApplied(applied, entry) {
  const existing = applied.find(
    (previous) => resolve(previous.operation.path) === resolve(entry.operation.path),
  );
  if (existing) existing.after = entry.after;
  else applied.push(entry);
}

/** @param {ReturnType<typeof prepareOperations>} prepared @param {AppliedEntry[]} applied @param {Directories} created @param {(operation: FileOperation, write: (operation: FileOperation) => void) => void} [afterWrite] */
function writeOperations(prepared, applied, created, afterWrite) {
  for (const { operation, before } of prepared.entries) {
    checkDirectories(operation.path, prepared.directories);
    if (!sameState(readState(operation.path), before)) throw changed(operation.path);
    if (operation.action === "unchanged") {
      afterWrite?.(operation, () => {});
      continue;
    }
    if (operation.action === "delete") {
      unlinkSync(operation.path);
      recordApplied(applied, { operation, before, after: null });
    } else {
      ensureDirectory(dirname(resolve(operation.path)), prepared.directories, created);
      atomicWrite(operation, before, (after) =>
        recordApplied(applied, { operation, before, after }),
      );
    }
    afterWrite?.(operation, (progressOperation) => {
      const progress = prepareOperations([progressOperation]);
      for (const [path, metadata] of prepared.directories) progress.directories.set(path, metadata);
      writeOperations(progress, applied, created);
    });
  }
}

/** @param {AppliedEntry[]} applied @param {Directories} directories @param {Directories} created */
function rollbackOperations(applied, directories, created) {
  const errors = [];
  for (const { operation, before, after } of [...applied].reverse()) {
    try {
      checkDirectories(operation.path, directories);
      if (!sameState(readState(operation.path), after)) throw changed(operation.path);
      if (before === null) {
        unlinkSync(operation.path);
      } else {
        atomicWrite(
          {
            action: after === null ? "create" : "update",
            path: operation.path,
            content: before.content,
            owner: "user",
            sensitive: operation.sensitive,
            mode: before.metadata.mode & 0o777,
            beforeDigest: after?.digest ?? null,
            afterDigest: before.digest,
            reason: "restore only this operation's changes",
          },
          after,
          undefined,
          before.metadata,
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [directory, expected] of [...created].reverse()) {
    try {
      checkDirectories(join(directory, ".rollback"), directories);
      if (!sameIdentity(lstatSync(directory), expected)) throw changed(directory);
      rmdirSync(directory);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "some operation changes could not be safely restored");
}

/** @param {FileOperation[]} operations */
export function applyOperations(operations) {
  writeOperations(prepareOperations(operations), [], new Map());
}

/** @param {FileOperation[]} operations @param {() => void | Promise<void>} validate @param {(operation: FileOperation, write: (operation: FileOperation) => void) => void} [afterWrite] */
export async function applyOperationsTransactionally(operations, validate, afterWrite) {
  const prepared = prepareOperations(operations);
  /** @type {AppliedEntry[]} */
  const applied = [];
  /** @type {Directories} */
  const created = new Map();
  try {
    writeOperations(prepared, applied, created, afterWrite);
    await validate();
  } catch (error) {
    try {
      rollbackOperations(applied, prepared.directories, created);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "bootstrap failed and the file changes could not be fully rolled back",
      );
    }
    throw error;
  }
}
