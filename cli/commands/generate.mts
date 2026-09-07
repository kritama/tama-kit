import { join } from "node:path";
import { inspectCurrentConfiguration } from "../bootstrap/current-config.mjs";
import { discoverProject } from "../bootstrap/detect-project.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import { CLIError, EXIT_CODES, ownershipError, usageError } from "../errors.mjs";
import { inspectRegularFile } from "../shared/files.mjs";
import type { CommandIO, ExitCode } from "../types.mjs";
import {
  type AdditionOptions,
  additionReviewDigest,
  additionStatus,
  MCP_ADDITION,
  planMcpAppAddition,
  writeMcpAppAddition,
} from "../workflows/generate-mcp-app.mjs";
import { mcpAppOptions } from "../workflows/options.mjs";
import { bootstrapUsage, parseBootstrap } from "./bootstrap-options.mjs";
import { CancelledInput, questions } from "./questions.mjs";

export function generateUsage() {
  return [
    "Usage: tama-kit generate mcp-app [path] [options]",
    "",
    "Add MCP App to an existing standard runtime; generation never starts services.",
    "  --compose <path>       Existing Compose files in order (repeatable)",
    "  --service <name>       Select the current Tama service",
    "  --env-file <path>      Select an existing Tama environment file",
    ...bootstrapUsage()
      .split("\n")
      .filter((line) =>
        /--(?:image|resume|dry-run|json|non-interactive|no-color|help|mcp-app-contract|provider-name|provider-prefix|provider-env-file|provider-origin|tama-origin|local-domain|acknowledge-local-domain-risk|provider-port|provider-runtime|provider-service|install-local-ca|allowed-origin)(?:\s|$)/u.test(
          line,
        ),
      ),
    "",
    "Review with --dry-run; use setup with the emitted Compose selection to start/activate.",
  ].join("\n");
}
function parse(argv: string[], io: CommandIO): AdditionOptions {
  const [capability, ...args] = argv;
  if (capability !== "mcp-app") throw usageError(generateUsage());
  const rest: string[] = [];
  const composeFiles: string[] = [];
  let service: string | undefined;
  let environmentFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/su);
    if (["--compose", "--service", "--env-file"].includes(flag)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("--")) throw usageError(`${flag} requires a value`);
      if (flag === "--compose") composeFiles.push(value);
      else if (flag === "--service") service = value;
      else environmentFile = value;
    } else {
      if (
        [
          "--start",
          "--activate",
          "--skills",
          "--port",
          "--migrate-local-https",
          "--migrate-provider-identity",
          "--migrate-provider-topology",
        ].includes(flag)
      )
        throw usageError(
          `${flag} is not supported by additive generation; use setup or edit current configuration`,
        );
      rest.push(args[i]);
    }
  }
  const options = parseBootstrap([...rest, "--mcp-app"]);
  return {
    ...options,
    selection: {
      cwd: io.cwd,
      targetPath: options.targetPath,
      composeFiles: composeFiles.length ? composeFiles : undefined,
      service,
      environmentFile,
    },
  };
}

export async function runGenerate(argv: string[], io: CommandIO): Promise<ExitCode> {
  try {
    if (argv.length === 0 || ["--help", "-h"].includes(argv[0])) {
      io.stdout(generateUsage());
      return EXIT_CODES.SUCCESS;
    }
    const options = parse(argv, io);
    if (options.help) {
      io.stdout(generateUsage());
      return EXIT_CODES.SUCCESS;
    }
    const root = discoverProject({ cwd: io.cwd, targetPath: options.targetPath }).root;
    const progress = additionStatus(root, options.resumeId);
    if (progress.status === "existing") {
      const result = {
        ok: true,
        generation: { status: "existing", capability: "mcp-app" },
        changes: [],
        next: "Use setup with your current Compose selection; completed output is never regenerated.",
      };
      io.stdout(options.json ? JSON.stringify(result, null, 2) : result.next);
      return EXIT_CODES.SUCCESS;
    }
    const initial = readGenerationEvidence(join(root, "tama/.tama-kit.json"));
    if (initial.kind === "receipt" && initial.receipt.progress.status === "incomplete")
      throw ownershipError("finish the unfinished bootstrap operation before adding MCP App");
    // Current configuration, rather than an old manifest inventory, establishes the project.
    const current = inspectCurrentConfiguration(options.selection);
    if (
      current.mcpApp ||
      (progress.status === "new" && inspectRegularFile(join(root, MCP_ADDITION.contract)))
    )
      throw usageError(
        "MCP App configuration already exists; use setup or doctor with its Compose selection",
      );
    const interactive = Boolean(
      io.interactive && io.prompt && !options.json && !options.nonInteractive,
    );
    const prepared = await prepareMcpApp({
      root,
      tamaDirectory: join(root, "tama"),
      framework: current.framework,
      options: mcpAppOptions(options),
      nonInteractive: !interactive,
      ignoreGenerationHistory: true,
      io,
    });
    const build = (materialize: boolean) =>
      planMcpAppAddition(current, options, prepared, progress, materialize);
    const preview = build(false);
    const publicResult = (addition: typeof preview, status: string) => ({
      ok: true,
      generation: { status, capability: "mcp-app", operationId: progress.id },
      changes: addition.plan.operations.map(({ action, path, sensitive, reason }) => ({
        action,
        path,
        sensitive,
        reason,
      })),
      commands: addition.commands,
      setup: {
        phase: status === "planned" ? "planned" : "mcp-app-prepared",
        runtimeHealth: "not-checked",
        runtimeVerified: false,
      },
    });
    if (options.dryRun) {
      io.stdout(
        options.json
          ? JSON.stringify(publicResult(preview, "planned"), null, 2)
          : `${preview.plan.operations
              .map((operation) => `${operation.action}: ${operation.path}`)
              .join("\n")}\nNext: ${preview.commands.setup}`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (interactive) {
      for (const operation of preview.plan.operations)
        io.stdout(`${operation.action}: ${operation.path}`);
      if (!(await questions(io).confirm("Write these MCP App additions?")))
        throw new CancelledInput();
    }
    const refreshed = inspectCurrentConfiguration(options.selection);
    const freshPrepared = await prepareMcpApp({
      root,
      tamaDirectory: join(root, "tama"),
      framework: refreshed.framework,
      options: mcpAppOptions(options),
      nonInteractive: true,
      ignoreGenerationHistory: true,
      io,
    });
    const fresh = planMcpAppAddition(refreshed, options, freshPrepared, progress, false);
    if (additionReviewDigest(fresh) !== additionReviewDigest(preview))
      throw ownershipError(
        "MCP App addition changed after review; rerun to review current configuration",
      );
    const addition = planMcpAppAddition(refreshed, options, freshPrepared, progress, true);
    await writeMcpAppAddition(addition, options);
    io.stdout(
      options.json
        ? JSON.stringify(publicResult(addition, "complete"), null, 2)
        : `MCP App additions generated in prepared mode.\nNext: ${addition.commands.setup}\nSee tama/MCP_APP.md for provider loading, activation, and native commands.`,
    );
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof CancelledInput) {
      io.stdout("Generation cancelled; no files were written.");
      return EXIT_CODES.SUCCESS;
    }
    if (!argv.includes("--json")) throw error;
    const failure =
      error instanceof CLIError
        ? error
        : new CLIError("MCP App generation failed; inspect the selected configuration");
    io.stdout(
      JSON.stringify({
        ok: false,
        error: { category: failure.category, exitCode: failure.exitCode, message: failure.message },
      }),
    );
    return failure.exitCode;
  }
}
