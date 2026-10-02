import { parseArgs } from "node:util";
import { CLIError, EXIT_CODES, usageError } from "../errors.mjs";
import type { CommandIO, ExitCode } from "../types.mjs";
import { runEnvironmentDoctor, runEnvironmentInit } from "../workflows/environment.mjs";

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
    "dry-run"?: boolean;
    fresh?: boolean;
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
    "  init    Create missing Tama-owned private environment files without",
    "          touching existing ones; derived files keep surviving secrets,",
    "          and new issuance is refused when local runtime data is detected",
    "",
    "Options:",
    "  --compose <path>          Compose root, then overrides (repeatable)",
    "  --service <name>          Select the Tama service",
    "  --env-file <path>         Select Tama's loaded private environment file",
    "  --contract <path>         Select the project-owned local MCP App contract",
    "  --provider-service <name> Select the provider service",
    "  --dry-run                 init only: report the plan and blockers without writing",
    "  --fresh                   init only: assert unknown persistence is fresh; never overrides detected data",
    "  --json                    Machine-readable output; never prompts",
    "  --non-interactive         Do not prompt",
    "  --no-color                Disable color",
    "  -h, --help                Show help",
    "",
    "Examples (from the project root; carry the same selection into each command):",
    "  tama-kit env doctor --json",
    "  tama-kit env init --dry-run --json",
    "  tama-kit env init --json",
    "  tama-kit env init --compose compose.yaml --compose tama/compose.mcp-app.yaml --dry-run --json",
    "",
    "Recovery uses current Compose declarations, public examples and the local",
    "contract. Existing files and keys are preserved. Optional and unsupported",
    "application files are never auto-created; invalid files need manual repair.",
    "New signing material requires prepared MCP App peers. Unknown persistence",
    "needs --fresh only after confirming the selected runtime is fresh.",
    "Follow printed setup, provider loading, TLS/trust, private onboarding and",
    "Terraform plan steps afterward. env init does not start or activate services.",
  ].join("\n");
}

export async function runEnv(argv: string[], io: CommandIO): Promise<ExitCode> {
  const [subcommand, ...args] = argv;
  let json = args.includes("--json");
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.stdout(envUsage());
    return EXIT_CODES.SUCCESS;
  }
  try {
    if (subcommand !== "doctor" && subcommand !== "init") {
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
          "dry-run": { type: "boolean" },
          fresh: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (error) {
      throw usageError(
        `${error instanceof Error ? error.message : String(error)}\n\n${envUsage()}`,
      );
    }
    json = Boolean(parsed.values.json);
    if (parsed.values.help) {
      io.stdout(envUsage());
      return EXIT_CODES.SUCCESS;
    }
    if (parsed.positionals.length > 1) throw usageError("expected at most one project path");
    const targetPath =
      typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : undefined;
    const selection = {
      cwd: io.cwd,
      targetPath,
      composeFiles: parsed.values.compose,
      service: parsed.values.service,
      environmentFile: parsed.values["env-file"],
      contractPath: parsed.values.contract,
      providerService: parsed.values["provider-service"],
    };
    if (subcommand === "doctor") {
      const result = await runEnvironmentDoctor(selection);
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
    }
    const result = await runEnvironmentInit({
      ...selection,
      dryRun: Boolean(parsed.values["dry-run"]),
      fresh: Boolean(parsed.values.fresh),
    });
    if (json) {
      io.stdout(JSON.stringify(result, null, 2));
    } else {
      io.stdout(
        `env init (${result.mode}): ${result.files.filter((file) => file.created).length} file(s) created, ${result.files.filter((file) => !file.created).length} preserved.`,
      );
      for (const file of result.files) {
        io.stdout(
          `  ${file.created ? "created" : "preserved"}  ${file.relative}${file.issuance !== "none" ? ` (${file.issuance})` : ""}`,
        );
      }
      io.stdout(
        `  persistence: ${result.persistence.status}${result.persistence.freshAsserted ? " (fresh asserted)" : ""}: ${result.persistence.detail}`,
      );
      for (const blocker of result.blockers) io.stdout(`blocked: ${blocker}`);
      for (const action of result.nextActions) io.stdout(`next: ${action}`);
    }
    return result.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.OWNERSHIP;
  } catch (error) {
    const failure =
      error instanceof CLIError
        ? error
        : new CLIError(
            `${subcommand} could not complete; inspect the selected configuration locally`,
          );
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
