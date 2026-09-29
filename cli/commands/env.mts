import { parseArgs } from "node:util";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import type { CommandIO, ExitCode } from "../types.mjs";
import { runEnvironmentDoctor } from "../workflows/environment.mjs";

type ParsedEnv = {
  values: {
    compose?: string[];
    service?: string;
    "env-file"?: string;
    contract?: string;
    "provider-service"?: string;
    json?: boolean;
    "non-interactive"?: boolean;
    "no-color"?: boolean;
    help?: boolean;
  };
  positionals: string[];
};

export function envUsage() {
  return [
    "Usage: tama-kit env <subcommand> [path] [options]",
    "",
    "Subcommands:",
    "  doctor  Inspect the private environment files the current configuration",
    "          declares; read-only, and it never prompts",
    "",
    "Options:",
    "  --compose <path>          Compose root, then overrides (repeatable)",
    "  --service <name>          Select the Tama service",
    "  --env-file <path>         Select Tama's loaded private environment file",
    "  --contract <path>         Select the project-owned local MCP App contract",
    "  --provider-service <name> Select the provider service",
    "  --json                    Machine-readable output; never prompts",
    "  --non-interactive         Do not prompt",
    "  --no-color                Disable color",
    "  -h, --help                Show help",
  ].join("\n");
}

export async function runEnv(argv: string[], io: CommandIO): Promise<ExitCode> {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.stdout(envUsage());
    return EXIT_CODES.SUCCESS;
  }
  if (subcommand !== "doctor") {
    throw usageError(`unknown env command: ${subcommand}\n\n${envUsage()}`);
  }
  let parsed: ParsedEnv;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        compose: { type: "string", multiple: true },
        service: { type: "string" },
        "env-file": { type: "string" },
        contract: { type: "string" },
        "provider-service": { type: "string" },
        json: { type: "boolean" },
        "non-interactive": { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw usageError(`${error instanceof Error ? error.message : String(error)}\n\n${envUsage()}`);
  }
  if (parsed.values.help) {
    io.stdout(envUsage());
    return EXIT_CODES.SUCCESS;
  }
  if (parsed.positionals.length > 1) throw usageError("expected at most one project path");
  const targetPath = typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : undefined;
  const json = Boolean(parsed.values.json);
  try {
    const result = await runEnvironmentDoctor({
      cwd: io.cwd,
      targetPath,
      composeFiles: parsed.values.compose,
      service: parsed.values.service,
      environmentFile: parsed.values["env-file"],
      contractPath: parsed.values.contract,
      providerService: parsed.values["provider-service"],
    });
    if (json) {
      io.stdout(JSON.stringify(result, null, 2));
    } else {
      io.stdout(
        `env doctor: ${result.files.length} private environment file(s) inspected; ${result.ok ? "required files are present" : "required environment files are missing or invalid"}.`,
      );
      for (const file of result.files) {
        io.stdout(
          `  ${file.status}  ${file.relative}${file.services.length > 0 ? ` (services: ${file.services.join(", ")})` : ""}`,
        );
        for (const issue of file.issues) io.stdout(`        ${issue}`);
      }
      for (const warning of result.warnings) io.stdout(`warning: ${warning}`);
      for (const action of result.nextActions) io.stdout(`next: ${action}`);
    }
    return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.OWNERSHIP;
  } catch (error) {
    const failure =
      error instanceof CLIError
        ? error
        : new CLIError("env doctor could not complete; inspect the selected configuration locally");
    if (json) {
      io.stdout(
        JSON.stringify(
          {
            ok: false,
            error: {
              category: failure.category,
              exitCode: failure.exitCode,
              message: failure.message,
              ...(Array.isArray(failure.details?.missingEnvironmentFiles)
                ? {
                    missingEnvironmentFiles: failure.details.missingEnvironmentFiles,
                    suggestedCommands: failure.details.suggestedCommands ?? [],
                  }
                : {}),
            },
          },
          null,
          2,
        ),
      );
    } else {
      io.stderr(failure.message);
    }
    return failure.exitCode;
  }
}
