// @ts-check

import {
  accessSync,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { ownershipError } from "../errors.mjs";
import { validateNewSecretFile } from "./git.mjs";

const CURRENT_UID = typeof process.geteuid === "function" ? process.geteuid() : -1;

/**
 * @typedef {object} DirectoryIdentity
 * @property {string} path
 * @property {number | bigint} dev
 * @property {number | bigint} ino
 */

/**
 * @typedef {object} SafeOutputPath
 * @property {string} absolutePath
 * @property {DirectoryIdentity[]} directories
 */

/** @param {string} directory */
function assertRealDirectory(directory) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw ownershipError(
        `Refusing to create the key file because the parent directory is missing: ${directory}`,
      );
    }
    throw ownershipError(`Unable to inspect the parent directory: ${directory}`);
  }
  if (metadata.isSymbolicLink()) {
    throw ownershipError(
      `Refusing to create the key file through a symbolic-link directory: ${directory}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw ownershipError(
      `Refusing to create the key file because the parent path is not a directory: ${directory}`,
    );
  }
  const ownerTrusted = metadata.uid === CURRENT_UID || metadata.uid === 0;
  const writableByOthers = (metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0;
  if (!ownerTrusted || writableByOthers) {
    throw ownershipError(
      `Refusing to create the key file because the directory is owned by another user or writable by other users: ${directory}`,
    );
  }
  return metadata;
}

/** @param {string} directory */
function assertWritable(directory) {
  try {
    accessSync(directory, fsConstants.W_OK);
  } catch {
    throw ownershipError(
      `Refusing to create the key file because the parent directory is not writable: ${directory}`,
    );
  }
}

/**
 * Resolves the requested destination and verifies that creating a file there
 * cannot be redirected through a symbolic link, an existing target, or a
 * Git-managed path. Every directory on the chain must also be private to the
 * invoking user: owned by the invoking user or root, and never group- or
 * world-writable without the sticky bit. Ownership is required outright
 * because the owner can rename entries even in a sticky directory. With
 * that rule no unprivileged process can rename or replace any checked path
 * at any point between this verification and the success report.
 *
 * @param {string} cwd
 * @param {string} outputPath
 * @returns {SafeOutputPath} The resolved path and the identity of every checked directory.
 */
function assertSafeOutputPath(cwd, outputPath) {
  const absolutePath = resolve(cwd, outputPath);
  const parent = dirname(absolutePath);
  /** @type {DirectoryIdentity[]} */
  const directories = [];

  let current = parent;
  while (true) {
    const metadata = assertRealDirectory(current);
    directories.push({ path: current, dev: metadata.dev, ino: metadata.ino });
    const ancestor = dirname(current);
    if (ancestor === current) {
      break;
    }
    current = ancestor;
  }
  assertWritable(parent);

  let existing = null;
  try {
    existing = lstatSync(absolutePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw ownershipError(`Unable to inspect the key file destination: ${absolutePath}`);
    }
  }
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw ownershipError(
        `Refusing to create the key file because the destination is a symbolic link: ${absolutePath}`,
      );
    }
    if (existing.isDirectory()) {
      throw ownershipError(
        `Refusing to create the key file because the destination is a directory: ${absolutePath}`,
      );
    }
    throw ownershipError(
      `Refusing to replace the existing key file because that would rotate a signing key: ${absolutePath}`,
    );
  }

  validateNewSecretFile(parent, absolutePath);
  return { absolutePath, directories };
}

const defaultFileSystem = {
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
};

/** @param {{dev: number | bigint, ino: number | bigint}} left @param {{dev: number | bigint, ino: number | bigint}} right */
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Ensures no checked directory was exchanged and that the path still names
 * the file we opened. This runs before the descriptor write, again after it
 * so a failed write can still zero the opened descriptor, and once more
 * after the close so the identity check is the final operation before a
 * success report: a destination exchanged during the close is then refused
 * instead of reported as the created key path.
 *
 * @param {SafeOutputPath} output
 * @param {{dev: number | bigint, ino: number | bigint}} openedFile
 * @param {typeof defaultFileSystem} fileSystem
 */
function assertStableOutputPath(output, openedFile, fileSystem) {
  for (const expected of output.directories) {
    let current;
    try {
      current = fileSystem.lstatSync(expected.path);
    } catch {
      throw ownershipError(
        `Refusing to write the key file because an output directory changed during creation: ${expected.path}`,
      );
    }
    if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(current, expected)) {
      throw ownershipError(
        `Refusing to write the key file because an output directory changed during creation: ${expected.path}`,
      );
    }
  }

  let destination;
  try {
    destination = fileSystem.lstatSync(output.absolutePath);
  } catch {
    throw ownershipError(
      `Refusing to write the key file because its destination changed during creation: ${output.absolutePath}`,
    );
  }
  if (destination.isSymbolicLink() || !destination.isFile() || !sameFile(destination, openedFile)) {
    throw ownershipError(
      `Refusing to write the key file because its destination changed during creation: ${output.absolutePath}`,
    );
  }
}

/**
 * Removes only the path that still identifies the file we opened. Node
 * exposes no directory-anchored unlink, so the identity is re-verified with
 * an lstat immediately before the unlink. The destination chain is private
 * to other users, so an unprivileged process cannot install a replacement in
 * that window; against a privileged process the worst case is removing its
 * replacement, never the key inode, which was already zeroed while the
 * descriptor was open.
 *
 * @param {string} absolutePath
 * @param {{dev: number | bigint, ino: number | bigint}} openedFile
 * @param {typeof defaultFileSystem} fileSystem
 */
function cleanupOpenedFile(absolutePath, openedFile, fileSystem) {
  try {
    const current = fileSystem.lstatSync(absolutePath);
    if (!current.isSymbolicLink() && sameFile(current, openedFile)) {
      fileSystem.unlinkSync(absolutePath);
    }
  } catch {
    // The file was requested with mode 0600 and may already have been moved or removed.
  }
}

/**
 * Creates the destination exclusively with owner-only permissions. An
 * exclusive write cannot replace an existing path. Because every directory
 * on the destination chain is owned by the invoking user or root and is
 * never group- or world-writable without the sticky bit, an unprivileged
 * process cannot exchange the path between the final identity check and the
 * success report; a privileged process can still race the pathname checks,
 * but the key inode remains owner-only (mode 0600) wherever it ends up. On
 * failure, the requested path is left without a file.
 *
 * @param {string} cwd
 * @param {string} outputPath
 * @param {string} content
 * @param {Partial<typeof defaultFileSystem>} [fileSystemOverrides]
 * @returns {string} The resolved absolute path.
 */
export function writeExclusiveSecretFile(cwd, outputPath, content, fileSystemOverrides = {}) {
  const output = assertSafeOutputPath(cwd, outputPath);
  const fileSystem = { ...defaultFileSystem, ...fileSystemOverrides };
  /** @type {number | undefined} */
  let descriptor;
  /** @type {{dev: number | bigint, ino: number | bigint} | undefined} */
  let openedFile;
  try {
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0);
    descriptor = fileSystem.openSync(output.absolutePath, flags, 0o600);
    openedFile = fileSystem.fstatSync(descriptor);
    assertStableOutputPath(output, openedFile, fileSystem);
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.writeFileSync(descriptor, content, { encoding: "utf8" });
    assertStableOutputPath(output, openedFile, fileSystem);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    assertStableOutputPath(output, openedFile, fileSystem);
    return output.absolutePath;
  } catch (error) {
    if (descriptor !== undefined && openedFile === undefined) {
      try {
        openedFile = fileSystem.fstatSync(descriptor);
      } catch {
        // Without a stable identity, cleanup must not unlink a possible replacement path.
      }
    }
    if (descriptor !== undefined) {
      try {
        fileSystem.ftruncateSync(descriptor, 0);
      } catch {
        // Continue with close and identity-checked path cleanup below.
      }
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Cleanup below is identity-checked and does not depend on a successful close.
      }
    }
    if (openedFile !== undefined) {
      cleanupOpenedFile(output.absolutePath, openedFile, fileSystem);
    }
    if (error instanceof Error && "exitCode" in error) {
      throw error;
    }
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw ownershipError(
        `Refusing to replace the existing key file because that would rotate a signing key: ${output.absolutePath}`,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw ownershipError(
        `Refusing to create the key file because the destination is not writable: ${output.absolutePath}`,
      );
    }
    throw ownershipError(`Unable to create the key file: ${output.absolutePath}`);
  }
}
