import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBootstrap } from "./commands/bootstrap.mjs";
import { CLIError, EXIT_CODES } from "./errors.mjs";

const CLI_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(resolve(CLI_ROOT, "../package.json"), "utf8"));

function usage() {
  return [
    "Usage: tama-kit <command> [options]",
    "",
    "Commands:",
    "  bootstrap [path]  Prepare a local Tama runtime and Terraform root",
    "  init [path]       Alias for bootstrap",
    "",
    "Global options:",
    "  -h, --help        Show help",
    "  -v, --version     Show the Tama Kit version",
  ].join("\n");
}

function defaultIO() {
  return {
    cwd: process.cwd(),
    stdout: (message = "") => console.log(message),
    stderr: (message = "") => console.error(message),
  };
}

export async function run(argv, providedIO = {}) {
  const io = { ...defaultIO(), ...providedIO };
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(usage());
    return EXIT_CODES.SUCCESS;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(PACKAGE.version);
    return EXIT_CODES.SUCCESS;
  }

  try {
    if (command === "bootstrap" || command === "init") {
      return await runBootstrap(args, io);
    }
    throw new CLIError(`unknown command: ${command}\n\n${usage()}`, {
      category: "usage",
      exitCode: EXIT_CODES.USAGE,
    });
  } catch (error) {
    const cliError =
      error instanceof CLIError
        ? error
        : new CLIError(error instanceof Error ? error.message : String(error));
    io.stderr(`error: ${cliError.message}`);
    if (cliError.details && providedIO.includeErrorDetails) {
      io.stderr(JSON.stringify(cliError.details, null, 2));
    }
    return cliError.exitCode;
  }
}
