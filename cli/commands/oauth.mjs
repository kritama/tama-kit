// @ts-check

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
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
 * Git-managed path.
 *
 * @param {string} cwd
 * @param {string} outputPath
 * @returns {string} The resolved absolute path.
 */
function assertSafeOutputPath(cwd, outputPath) {
  const absolutePath = resolve(cwd, outputPath);
  const parent = dirname(absolutePath);

  let current = parent;
  while (true) {
    assertRealDirectory(current);
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
  return absolutePath;
}

/**
 * Creates the destination exclusively with owner-only permissions. An
 * exclusive write cannot replace an existing path and never leaves a
 * temporary file behind when it fails.
 *
 * @param {string} absolutePath
 * @param {string} content
 */
function writeExclusiveSecretFile(absolutePath, content) {
  try {
    writeFileSync(absolutePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(absolutePath, 0o600);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw ownershipError(
        `Refusing to replace the existing key file because that would rotate a signing key: ${absolutePath}`,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw ownershipError(
        `Refusing to create the key file because the destination is not writable: ${absolutePath}`,
      );
    }
    try {
      unlinkSync(absolutePath);
    } catch {
      // The partially created file, if any, already has owner-only permissions.
    }
    throw ownershipError(`Unable to create the key file: ${absolutePath}`);
  }
}

/** @param {{jwk: string, kid: string}} key @returns {string[]} */
function dotenvLines(key) {
  return [`TAMA_OAUTH_PRIVATE_JWK=${key.jwk}`, `TAMA_OAUTH_PRIVATE_JWK_ID=${key.kid}`];
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
  if (options.kid !== undefined && !isValidOAuthKid(options.kid)) {
    throw usageError(
      "invalid oauth key identifier: it must be non-empty, contain no control characters, and be at most 128 bytes",
    );
  }

  const key = generateOAuthPrivateJwk(options.kid);
  if (hasOutput) {
    const absolutePath = assertSafeOutputPath(io.cwd, /** @type {string} */ (options.output));
    writeExclusiveSecretFile(absolutePath, `${dotenvLines(key).join("\n")}\n`);
    io.stdout(absolutePath);
    return EXIT_CODES.SUCCESS;
  }
  for (const line of dotenvLines(key)) {
    io.stdout(line);
  }
  return EXIT_CODES.SUCCESS;
}
