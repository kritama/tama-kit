// @ts-check
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { EXIT_CODES, ownershipError, usageError } from "../errors.mjs";
import { CancelledInput, questions } from "./questions.mjs";
import { runSetup } from "./setup.mjs";

/** Intercept before manifest topology, provider preparation or the generation questionnaire.
 * @param {import("../types.mjs").BootstrapCommandOptions} options
 * @param {import("../types.mjs").CommandIO} io
 * @param {string} root
 * @returns {Promise<import("../types.mjs").ExitCode | null>}
 */
export async function runExistingBootstrap(options, io, root) {
  const evidence = readGenerationEvidence(join(root, "tama/.tama-kit.json"));
  const configured =
    evidence.kind !== "absent" ||
    ["tama/.tama.env", "tama/compose.yaml", "tama/contracts/mcp-app-provider-v1.json"].some(
      (path) => existsSync(join(root, path)),
    );
  if (!configured) {
    if (options.resumeId) throw ownershipError("resume requires an unfinished generation receipt");
    return null;
  }
  if (evidence.kind === "receipt" && evidence.receipt.progress.status === "incomplete") {
    if (evidence.receipt.operation.kind !== "bootstrap")
      throw ownershipError("use generate mcp-app to resume MCP App generation");
    if (options.resumeId !== evidence.receipt.operation.id)
      throw ownershipError(
        `generation is incomplete; review its pending destinations and rerun with --resume ${evidence.receipt.operation.id} and the original generation options`,
        { operationId: evidence.receipt.operation.id },
      );
    options.resumePending = evidence.receipt.progress.pendingDestinations;
    options.generationId = evidence.receipt.operation.id;
    return null;
  }
  if (options.mcpApp)
    throw usageError(
      "bootstrap --mcp-app does not add capabilities to an existing project; use tama-kit generate mcp-app",
    );
  const changes = [
    options.image !== undefined && "--image",
    options.port !== undefined && "--port",
    options.localDomain !== undefined && "--local-domain",
    options.providerPort !== undefined && "--provider-port",
    options.providerPrefix !== undefined && "--provider-prefix",
    options.providerRuntime !== undefined && "--provider-runtime",
    !options.start && options.providerName !== undefined && "--provider-name",
    !options.start && options.mcpAppContract !== undefined && "--mcp-app-contract",
    options.providerEnvironmentFile !== undefined && "--provider-env-file",
    options.providerOrigin !== undefined && "--provider-origin",
    options.tamaOrigin !== undefined && "--tama-origin",
    options.allowedOrigins !== undefined && "--allowed-origin",
    options.migrateLocalHttps && "--migrate-local-https",
    options.migrateProviderIdentity && "--migrate-provider-identity",
    options.migrateProviderTopology && "--migrate-provider-topology",
    options.installLocalCa && "--install-local-ca",
  ].filter(Boolean);
  if (changes.length)
    throw usageError(
      `bootstrap does not upgrade existing project configuration (${changes.join(", ")}). Edit the current configuration, then use tama-kit setup or doctor. No files were changed.`,
    );
  let start = options.start;
  const activate = options.activate;
  if (
    !options.json &&
    !options.nonInteractive &&
    io.interactive &&
    io.prompt &&
    !options.dryRun &&
    !start
  ) {
    const next = await questions(io).choice(
      "This project already exists. Generated files belong to you.",
      ["Continue setup", "Inspect current configuration", "Finish"],
    );
    if (next === 2) throw new CancelledInput();
    if (next === 1)
      return runSetup(
        [root, ...(options.composePath ? ["--compose", options.composePath] : [])],
        io,
        "doctor",
      );
    start = true;
  }
  if (start) {
    if (!options.json)
      io.stdout(
        "bootstrap --start/--activate is deprecated for existing projects; use tama-kit setup.",
      );
    return runSetup(
      [
        root,
        ...(options.composePath ? ["--compose", options.composePath] : []),
        ...(options.providerService ? ["--provider-service", options.providerService] : []),
        ...(activate ? ["--activate"] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
        ...(options.json ? ["--json"] : []),
        ...(options.nonInteractive ? ["--non-interactive"] : []),
      ],
      options.json
        ? {
            ...io,
            stdout(output) {
              const result = JSON.parse(output ?? "{}");
              io.stdout(
                JSON.stringify(
                  {
                    ...result,
                    deprecation:
                      "Use tama-kit setup for existing projects; bootstrap runtime flags are a compatibility route.",
                  },
                  null,
                  2,
                ),
              );
            },
          }
        : io,
    );
  }
  if (evidence.kind === "absent") {
    throw ownershipError(
      "existing Tama configuration has no generation receipt. Inspect it with tama-kit doctor or run tama-kit setup; bootstrap will not recreate missing output",
    );
  }
  const result = {
    ok: true,
    schemaVersion: 1,
    mode: options.dryRun ? "dry-run" : "write",
    root,
    generation: { status: "existing", source: evidence.kind },
    changes: [],
    started: false,
    healthUrl: null,
    setup: {
      phase: "configured",
      runtimeHealth: "not-checked",
      runtimeVerified: false,
      foundation: "not-verified",
      nextActions: [
        {
          id: "setup",
          workingDirectory: root,
          description:
            "Run tama-kit setup to start/verify current configuration, or doctor for read-only diagnosis.",
        },
      ],
    },
  };
  io.stdout(
    options.json
      ? JSON.stringify(result, null, 2)
      : "Project already exists. No generation changes. Use tama-kit setup to continue or doctor to inspect current configuration.",
  );
  return EXIT_CODES.SUCCESS;
}
