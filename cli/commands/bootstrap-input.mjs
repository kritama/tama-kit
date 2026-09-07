// @ts-check
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULTS } from "../bootstrap/constants.mjs";
import { discoverProject, inspectProject } from "../bootstrap/detect-project.mjs";
import { resolveEnvironmentPort } from "../bootstrap/environment.mjs";
import { normalizeLocalDomain, usesLocalHttpsTopology } from "../bootstrap/local-https.mjs";
import { allowedOrigin, normalizeMcpAppOrigin, prepareMcpApp } from "../bootstrap/mcp-app.mjs";
import {
  discoverProviderContract,
  loadTamaContract,
  unpinnedTamaImageTag,
  unsupportedTamaImage,
} from "../bootstrap/mcp-app-contract.mjs";
import { normalizeProviderName, resolveProviderIdentity } from "../bootstrap/provider-identity.mjs";
import { providerServiceDependency } from "../bootstrap/provider-topology.mjs";
import { CLIError, usageError } from "../errors.mjs";
import { planBootstrap } from "../workflows/bootstrap-plan.mjs";
import { mcpAppOptions } from "../workflows/options.mjs";
import { CancelledInput, PreviousQuestion, questions } from "./questions.mjs";

/** @typedef {import("../types.mjs").BootstrapCommandOptions} Options */
/** @typedef {import("../types.mjs").CommandIO} IO */

/** Redirect a newly selected existing project before reading historical planner settings. */
export class ExistingBootstrapTarget extends Error {
  /** @param {Options & {targetPath: string}} options */
  constructor(options) {
    super("existing project selected");
    this.options = options;
  }
}

/** @param {string} value */
function port(value) {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw usageError("Enter a port between 1 and 65535.");
  }
  return value;
}

/** Re-read contracts and loader evidence immediately before execution. @param {Options} options @param {IO} io */
export async function prepareBootstrapInput(options, io) {
  const inspection = inspectProject({
    cwd: io.cwd,
    targetPath: options.targetPath,
    composePath: options.composePath,
  });
  if (!options.mcpApp) return null;
  return prepareMcpApp({
    root: inspection.root,
    tamaDirectory: inspection.tamaDirectory,
    framework: inspection.framework,
    options: mcpAppOptions(options),
    nonInteractive: true,
    io,
  });
}

/** @param {import("../types.mjs").BootstrapPlan} plan @param {IO} io */
export function printReview(plan, io) {
  io.stdout("Review bootstrap configuration");
  io.stdout(
    `Mode: ${plan.mcpApp ? "MCP App OAuth provider integration" : "Local Tama runtime and Terraform"}`,
  );
  io.stdout(`Project: ${plan.root} (${plan.framework})`);
  io.stdout(`Detection evidence: ${plan.frameworkEvidence.join("; ")}`);
  io.stdout(`Compose: ${relative(plan.root, plan.composeFile)}`);
  io.stdout(`Image: ${plan.tamaImage}; agent skills: ${plan.skillMode}`);
  if (plan.skillMode === "local") io.stdout("Skill location: .agents/skills inside the project");
  if (plan.localHttps) {
    io.stdout(`Provider: ${plan.localHttps.providerOrigin}; Tama: ${plan.localHttps.tamaOrigin}`);
    io.stdout(`Private provider route: ${plan.localHttps.providerUpstream}`);
  } else io.stdout(`Tama host port: ${plan.port}`);
  if (plan.mcpApp) {
    io.stdout(
      `Configured modes: Tama ${plan.mcpApp.lifecycle}; provider ${plan.mcpApp.providerLifecycle}. Live state has not been checked.`,
    );
    io.stdout(`Allowed client origins: ${plan.mcpApp.allowedOrigins.join(", ")}`);
  }
  for (const op of plan.operations.filter((op) => op.action !== "unchanged")) {
    io.stdout(
      `  ${op.action}: ${relative(plan.root, op.path)}${op.sensitive ? " (private contents hidden)" : ""}`,
    );
  }
  io.stdout(
    "The preview has not written files, created credentials/certificates, or started services.",
  );
}

/**
 * Interactive input adapts the existing planner. Explicit flags are locked;
 * navigation restores answer snapshots, and planning is always secret-free.
 * @param {Options} supplied @param {IO} io
 */
export async function resolveBootstrapInput(supplied, io) {
  const q = questions(io);
  /** @type {Options} */
  let options = { ...supplied };
  let advanced = false;
  let discovered = discoverProject({ cwd: io.cwd, targetPath: options.targetPath });
  /** @type {ReturnType<typeof discoverProviderContract>} */
  let contract = { path: null, document: null };
  io.stdout(
    "Tama Kit guided bootstrap. Press Enter for a suggested value; use :back or :cancel at any question.",
  );
  if (
    ["tama/.tama-kit.json", "tama/.tama.env", "tama/compose.yaml"].some((path) =>
      existsSync(join(discovered.root, path)),
    )
  )
    throw new ExistingBootstrapTarget({ ...options, targetPath: discovered.root });

  const steps = [
    async () => {
      if (!supplied.targetPath) {
        options.targetPath = await q.text(
          "Project directory",
          discovered.root,
          (value) => discoverProject({ cwd: io.cwd, targetPath: value }).root,
        );
      }
      discovered = discoverProject({ cwd: io.cwd, targetPath: options.targetPath });
      options.targetPath = discovered.root;
      if (
        ["tama/.tama-kit.json", "tama/.tama.env", "tama/compose.yaml"].some((path) =>
          existsSync(join(discovered.root, path)),
        )
      ) {
        throw new ExistingBootstrapTarget({ ...options, targetPath: discovered.root });
      }
      io.stdout(`Detected ${discovered.framework} project: ${discovered.root}`);
      options.composePath = supplied.composePath;
      if (!options.composePath && discovered.composeCandidates.length > 1) {
        const names = discovered.composeCandidates.map((name) => relative(discovered.root, name));
        options.composePath = names[await q.choice("Choose the application's Compose file", names)];
      } else if (!options.composePath && discovered.composeCandidates.length === 0) {
        io.stdout("A new root compose.yaml will be created.");
      }
      if (!supplied.composePath && (await q.confirm("Select a different existing Compose file?"))) {
        options.composePath = await q.text(
          "Compose path inside the project",
          options.composePath ?? "compose.yaml",
          (value) => {
            inspectProject({ cwd: io.cwd, targetPath: options.targetPath, composePath: value });
            return value;
          },
        );
      }
      inspectProject({
        cwd: io.cwd,
        targetPath: options.targetPath,
        composePath: options.composePath,
      });
    },
    async () => {
      if (!supplied.mcpApp) {
        options.mcpApp =
          (await q.choice("What should this application use?", [
            "Local Tama runtime and Terraform",
            "MCP App: application OAuth provider for Tama",
          ])) === 1;
      }
      if (options.mcpApp)
        io.stdout(
          "MCP App preparation configures trust and routing. Your application must implement the OAuth provider; live verification happens later.",
        );
      advanced = await q.confirm("Customize advanced settings (image, contracts, identity)?");
    },
    async () => {
      options.skillMode =
        supplied.skillMode ??
        ((await q.confirm("Install Tama Kit's agent skills in this repository?", true))
          ? "local"
          : "manual");
      if (!options.mcpApp) {
        if (!supplied.port)
          options.port = Number(
            await q.text("Tama host port", String(resolveEnvironmentPort(discovered.root)), port),
          );
        return;
      }
      if (advanced && !supplied.mcpAppContract) {
        options.mcpAppContract =
          (await q.text(
            "Provider contract path (blank discovers the application contract)",
            options.mcpAppContract ?? "",
            (value) => {
              discoverProviderContract(discovered.root, value || undefined);
              return value;
            },
          )) || undefined;
      }
      contract = discoverProviderContract(discovered.root, options.mcpAppContract);
      if (contract.path) io.stdout(`Provider contract: ${contract.path}`);
      const identityInput = {
        root: discovered.root,
        framework: discovered.framework,
        contractDocument: contract.document,
        name: supplied.providerName,
        prefix: supplied.providerPrefix,
        environmentFile: supplied.providerEnvironmentFile,
      };
      /** @type {import("../types.mjs").ProviderIdentity} */
      let identity;
      try {
        identity = resolveProviderIdentity(identityInput);
      } catch (error) {
        if (
          !(error instanceof CLIError) ||
          error.category !== "usage" ||
          contract.document?.provider ||
          supplied.providerName ||
          supplied.providerPrefix ||
          supplied.providerEnvironmentFile
        )
          throw error;
        io.stdout(
          "The detected project name cannot be used as a provider identity. Choose a short provider name.",
        );
        identity = resolveProviderIdentity({ ...identityInput, name: "provider" });
      }
      if (!supplied.providerName && identity.source !== "contract") {
        options.providerName = await q.text("Provider name", identity.name, (value) => {
          const name = normalizeProviderName(value);
          resolveProviderIdentity({ ...identityInput, name });
          return name;
        });
      } else options.providerName = supplied.providerName ?? identity.name;
      // Recompute defaults after accepting a new provider name.
      identity = resolveProviderIdentity({
        root: discovered.root,
        framework: discovered.framework,
        contractDocument: contract.document,
        name: options.providerName,
        prefix: supplied.providerPrefix,
        environmentFile: supplied.providerEnvironmentFile,
      });
      options.providerPrefix = supplied.providerPrefix ?? identity.environmentPrefix;
      options.providerEnvironmentFile =
        supplied.providerEnvironmentFile ?? identity.environmentFile;
      if (advanced && identity.source !== "contract") {
        if (!supplied.providerPrefix)
          options.providerPrefix = await q.text(
            "Provider environment prefix",
            identity.environmentPrefix,
          );
        if (!supplied.providerEnvironmentFile)
          options.providerEnvironmentFile = await q.text(
            "Provider private fragment path",
            identity.environmentFile,
          );
      }
    },
    async () => {
      if (!options.mcpApp) return;
      const https = usesLocalHttpsTopology(mcpAppOptions(options), contract.document);
      if (https) {
        options.localDomain = normalizeLocalDomain(supplied.localDomain ?? "app.localhost");
        if (!supplied.localDomain)
          options.localDomain = await q.text(
            "Local HTTPS domain",
            options.localDomain,
            normalizeLocalDomain,
          );
        if (!options.localDomain.endsWith(".localhost") && !options.acknowledgeLocalDomainRisk) {
          options.acknowledgeLocalDomainRisk = await q.confirm(
            "This name may collide with public DNS. Have you verified local-only resolution and accepted that risk?",
          );
          if (!options.acknowledgeLocalDomainRisk) throw new CancelledInput();
        }
        options.providerRuntime =
          supplied.providerRuntime ?? (supplied.providerService ? "compose" : "host");
        options.providerService = supplied.providerService;
        if (!supplied.providerRuntime && !supplied.providerService) {
          options.providerRuntime =
            (await q.choice(
              "Where does the application's provider run?",
              ["On this host", "An existing Compose service"],
              0,
            )) === 1
              ? "compose"
              : "host";
        }
        if (options.providerRuntime === "compose" && !supplied.providerService) {
          options.providerService = await q.text(
            "Provider Compose service",
            options.providerService ?? options.providerName,
            (name) => {
              providerServiceDependency(
                inspectProject({
                  cwd: io.cwd,
                  targetPath: options.targetPath,
                  composePath: options.composePath,
                }).selectedCompose,
                name,
              );
              return name;
            },
          );
        } else if (options.providerRuntime === "host") options.providerService = undefined;
        if (!supplied.providerPort)
          options.providerPort = Number(
            await q.text("Provider private listening port", "4000", port),
          );
        io.stdout(
          `Public identities: https://${options.localDomain} and https://tama.${options.localDomain}/mcp/app`,
        );
      } else {
        options.providerOrigin = supplied.providerOrigin;
        options.tamaOrigin = supplied.tamaOrigin;
        if (!options.providerOrigin)
          options.providerOrigin = await q.text(
            "Exact provider origin reachable from Tama",
            "",
            (value) => normalizeMcpAppOrigin(value, "provider origin"),
          );
        if (!options.tamaOrigin)
          options.tamaOrigin = await q.text("Exact Tama origin", "http://127.0.0.1:4001", (value) =>
            normalizeMcpAppOrigin(value, "Tama origin"),
          );
        if (!supplied.port)
          options.port = Number(
            await q.text("Tama host port", new URL(options.tamaOrigin).port || "4001", port),
          );
      }
      if (!supplied.allowedOrigins) {
        const origins = https ? [`https://${options.localDomain}`] : [];
        options.allowedOrigins = (
          await q.text(
            "Allowed browser/MCP client origins (comma separated; replace the list to add/remove)",
            origins.join(", "),
            (value) => {
              const normalized = [
                ...new Set(value.split(",").map((item) => allowedOrigin(item.trim()))),
              ];
              if (!normalized.length || normalized.length > 32)
                throw usageError("Choose 1 to 32 unique origins.");
              return normalized.join(",");
            },
          )
        )
          .split(",")
          .map((item) => item.trim());
      }
      if (advanced) {
        for (const key of /** @type {const} */ (["providerOrigin", "tamaOrigin"])) {
          if (!supplied[key] && https)
            options[key] =
              (await q.text(`${key}: optional exact origin assertion`, options[key] ?? "")) ||
              undefined;
        }
      }
    },
    async () => {
      let image =
        supplied.image ?? (options.mcpApp ? DEFAULTS.mcpAppTamaImage : DEFAULTS.tamaImage);
      /** @param {string} value */
      const validate = (value) => {
        if (!value || /\s/u.test(value))
          throw usageError("Enter a container image reference without whitespace.");
        if (options.mcpApp) {
          const reason =
            unsupportedTamaImage(value, loadTamaContract().supported_tama_versions) ??
            unsupportedTamaImage(value, contract.document?.supported_tama_versions);
          if (reason) throw usageError(reason);
          if (unpinnedTamaImageTag(value))
            throw usageError("MCP App setup requires a pinned image version or digest.");
        }
        return value;
      };
      if (supplied.image) validate(image);
      else {
        let valid = true;
        try {
          validate(image);
        } catch (error) {
          valid = false;
          io.stderr(error instanceof Error ? error.message : "Incompatible image");
        }
        if (advanced || !valid) {
          io.stdout(
            "Enter an existing published image. Version compatibility is checked offline; availability is checked when Docker pulls it.",
          );
          image = await q.text("Tama image", image, validate);
        }
      }
      options.image = image;
    },
  ];
  /** @type {Array<{options: Options, advanced: boolean}>} */
  const history = [];
  let index = 0;
  while (true) {
    while (index < steps.length) {
      history[index] = { options: { ...options }, advanced };
      try {
        await steps[index]();
        index++;
      } catch (error) {
        if (error instanceof PreviousQuestion) {
          index = Math.max(0, index - 1);
          options = { ...history[index].options };
          advanced = history[index].advanced;
        } else if (error instanceof CLIError && error.category === "usage") {
          io.stderr(error.message);
          if (!(await q.confirm("Retry this setup step?", true))) throw new CancelledInput();
        } else throw error;
      }
    }
    try {
      let prepared = await prepareBootstrapInput(options, io);
      const build = () =>
        planBootstrap({
          options,
          cwd: io.cwd,
          skillMode: options.skillMode ?? "manual",
          mcpAppPrepared: prepared,
          materializeSecrets: false,
        });
      let reviewedPlan = build();
      printReview(reviewedPlan, io);
      if (supplied.dryRun) {
        const next = await q.choice("Dry run complete", ["Finish", "Edit answers"]);
        if (next === 0) return { options, prepared, reviewedPlan, statusOnly: false };
      } else {
        const choices = [
          "Prepare files",
          "Prepare and start services",
          ...(options.mcpApp ? ["Start and activate/verify MCP App (provider must be ready)"] : []),
          "Edit answers",
          "Finish without changes",
        ];
        if (supplied.start || supplied.activate) {
          io.stdout(
            supplied.activate
              ? "Requested action: start and activate/verify MCP App."
              : "Requested action: prepare and start services.",
          );
          if (await q.confirm("Execute this reviewed action?"))
            return { options, prepared, reviewedPlan, statusOnly: false };
          throw new CancelledInput();
        }
        const action = await q.choice("Next action", choices);
        if (action === choices.length - 1) throw new CancelledInput();
        if (action !== choices.length - 2) {
          options.start = action > 0;
          options.activate = action === 2;
          if (options.activate) {
            prepared = await prepareBootstrapInput(options, io);
            reviewedPlan = build();
            printReview(reviewedPlan, io);
            if (
              !(await q.confirm("Start services and run the staged activation/verification now?"))
            )
              throw new CancelledInput();
          }
          return { options, prepared, reviewedPlan, statusOnly: false };
        }
      }
      index = 0;
    } catch (error) {
      if (error instanceof PreviousQuestion) {
        index = steps.length - 1;
      } else if (error instanceof CLIError && error.category === "usage") {
        io.stderr(error.message);
        if (!(await q.confirm("Edit the answers and try again?", true))) throw new CancelledInput();
        index = 0;
      } else throw error;
    }
  }
}
