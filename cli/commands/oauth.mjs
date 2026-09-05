// @ts-check

import { parseArgs } from "node:util";
import { EXIT_CODES, usageError } from "../errors.mjs";
import { generateOAuthPrivateJwk, isValidOAuthKid } from "../shared/oauth-key.mjs";
import { writeExclusiveSecretFile } from "../shared/secret-file.mjs";

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
  if (options.kid !== undefined && !isValidOAuthKid(options.kid)) {
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
