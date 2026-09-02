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
import { parseArgs } from "node:util";

import { validateNewSecretFile } from "../bootstrap/gitignore.mjs";
import { generateOAuthPrivateJwk, isValidOAuthKid } from "../bootstrap/oauth-key.mjs";
import { EXIT_CODES, ownershipError, usageError } from "../errors.mjs";

/** @typedef {import("../types.mjs").CommandIO} CommandIO */
/** @typedef {import("../types.mjs").ExitCode} ExitCode */

const DOTENV_SAFE_KID = /^[A-Za-z0-9._~-]+$/u;
const CURRENT_UID = typeof process.geteuid === "function" ? process.geteuid() : -1;

/**
 * @typedef {object} OauthGenerateKeyOptions
 * @property {string | undefined} kid
 * @property {boolean} stdout
 * @property {string | undefined} output
 * @property {boolean} help
 */

function generateKeyUsage() {
  return [
    "Usage: tama-kit oauth generate-key [options]",
    "",
    "Generate an RSA private JWK that Tama uses to sign System OAuth tokens.",
    "Exactly one of --stdout or --output is required; the private JWK is only",
    "ever written to the explicitly selected destination.",
    "",
    "Options:",
    "  --kid <identifier>  Set an explicit public key identifier",
    "  --stdout            Emit dotenv assignments to standard output",
    "  --output <path>     Create an owner-only dotenv file",
    "  -h, --help          Show help",
  ].join("\n");
}

/** @param {string[]} argv @returns {OauthGenerateKeyOptions} */
function parse(argv) {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { kid: undefined, stdout: false, output: undefined, help: true };
  }
  if (subcommand !== "generate-key") {
    throw usageError(`unknown oauth command: ${subcommand}\n\n${generateKeyUsage()}`);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        kid: { type: "string" },
        stdout: { type: "boolean", default: false },
        output: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(`${message}\n\n${generateKeyUsage()}`);
  }
  if (parsed.positionals.length > 0) {
    throw usageError(`unexpected argument: ${parsed.positionals[0]}\n\n${generateKeyUsage()}`);
  }
  return {
    kid: parsed.values.kid,
    stdout: parsed.values.stdout ?? false,
    output: parsed.values.output,
    help: parsed.values.help ?? false,
  };
}

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
  if ((metadata.mode & 0o022) !== 0) {
    const protectedFromOtherUsers =
      (metadata.mode & 0o1000) !== 0 && (metadata.uid === CURRENT_UID || metadata.uid === 0);
    if (!protectedFromOtherUsers) {
      throw ownershipError(
        `Refusing to create the key file because the directory is writable by other users: ${directory}`,
      );
    }
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
 * Git-managed path. Every directory on the chain must also be private to
 * other users: no group or world write bit, except a sticky directory owned
 * by the invoking user or root, because the directory owner bypasses the
 * sticky restriction and could still exchange the path. With that rule an
 * unprivileged process cannot rename or replace any checked path at any
 * point between this verification and the success report.
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
 * on the destination chain must be private to other users (no group or
 * world write bit, except a sticky directory owned by the invoking user or
 * root), an unprivileged process cannot exchange the path between the final
 * identity check and the success report; a privileged process can still race
 * the pathname checks, but the key inode remains owner-only (mode 0600)
 * wherever it ends up. On failure, the requested path is left without a
 * file.
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

/** @param {{jwk: string, kid: string}} key @returns {string[]} */
function dotenvLines(key) {
  return [`TAMA_OAUTH_PRIVATE_JWK='${key.jwk}'`, `TAMA_OAUTH_PRIVATE_JWK_ID=${key.kid}`];
}

/** @param {string[]} argv @param {CommandIO} io @returns {Promise<ExitCode>} */
export async function runOAuth(argv, io) {
  const options = parse(argv);
  if (options.help) {
    io.stdout(generateKeyUsage());
    return EXIT_CODES.SUCCESS;
  }
  const hasStdout = options.stdout;
  const hasOutput = options.output !== undefined;
  if (hasStdout === hasOutput) {
    throw usageError(`choose exactly one of --stdout or --output\n\n${generateKeyUsage()}`);
  }
  if (
    options.kid !== undefined &&
    (!isValidOAuthKid(options.kid) || !DOTENV_SAFE_KID.test(options.kid))
  ) {
    throw usageError(
      "invalid oauth key identifier: use 1-128 ASCII letters, digits, dots, underscores, tildes, or hyphens",
    );
  }

  if (hasOutput) {
    const key = generateOAuthPrivateJwk(options.kid);
    const absolutePath = writeExclusiveSecretFile(
      io.cwd,
      /** @type {string} */ (options.output),
      `${dotenvLines(key).join("\n")}\n`,
    );
    io.stdout(absolutePath);
    return EXIT_CODES.SUCCESS;
  }
  const key = generateOAuthPrivateJwk(options.kid);
  for (const line of dotenvLines(key)) {
    io.stdout(line);
  }
  return EXIT_CODES.SUCCESS;
}
