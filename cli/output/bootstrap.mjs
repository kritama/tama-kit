// @ts-check
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { formatAgentSetupPrompt } from "../bootstrap/agent-prompt.mjs";
import { formatComposeUpCommand } from "../bootstrap/compose-command.mjs";
import { localHttpsPaths } from "../bootstrap/local-https.mjs";
import { publicPlan } from "../bootstrap/plan.mjs";
import { paint, renderBox } from "../terminal.mjs";
/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */
/** @typedef {import("../types.mjs").BootstrapResult} BootstrapResult */
/** @typedef {import("../types.mjs").CommandIO} CommandIO */

/**
 * @param {BootstrapPlan} plan
 * @param {{dryRun: boolean, started: boolean, healthUrl?: string}} status
 * @returns {BootstrapResult}
 */
export function resultEnvelope(plan, { dryRun, started, healthUrl }) {
  const result = publicPlan(plan);
  return {
    ok: true,
    mode: dryRun ? "dry-run" : "write",
    started,
    healthUrl: healthUrl ?? null,
    agentPrompt: dryRun ? null : formatAgentSetupPrompt(plan),
    ...result,
    localHttps: plan.localHttps
      ? {
          profile: plan.localHttps.profile,
          localDomain: plan.localHttps.localDomain,
          providerHost: plan.localHttps.providerHost,
          tamaHost: plan.localHttps.tamaHost,
          providerOrigin: plan.localHttps.providerOrigin,
          tamaOrigin: plan.localHttps.tamaOrigin,
          resource: plan.localHttps.resource,
          healthUrl: plan.localHttps.healthUrl,
          providerUpstream: plan.localHttps.providerUpstream,
          tamaUpstream: plan.localHttps.tamaUpstream,
          providerPort: plan.localHttps.providerPort,
          tamaPort: plan.localHttps.tamaPort,
          httpsPort: plan.localHttps.httpsPort,
          certificateNames: plan.localHttps.certificateNames,
          caddyImage: plan.localHttps.caddyImage,
          trustMechanism: plan.localHttps.trustMechanism,
          allowedOrigins: plan.localHttps.allowedOrigins,
          certificateReady: Object.values(localHttpsPaths(plan.root))
            .filter((path) => path.endsWith(".pem"))
            .every(existsSync),
        }
      : null,
  };
}

/**
 * @param {CommandIO} io
 * @param {BootstrapResult} result
 * @param {boolean} color
 * @param {string | null} setupUrl
 */
export function printHuman(io, result, color, setupUrl) {
  io.stdout(paint(color, "bold", `Tama Kit bootstrap (${result.mode})`));
  io.stdout(`${paint(color, "dim", "Project:")} ${result.root}`);
  io.stdout(`${paint(color, "dim", "Framework:")} ${result.framework}`);
  io.stdout(`${paint(color, "dim", "Compose:")} ${relative(result.root, result.composeFile)}`);
  io.stdout(`${paint(color, "dim", "Global foundation:")} ${result.terraform.foundation}`);
  io.stdout(
    `${paint(color, "dim", "Agent skills:")} ${
      result.skillMode === "local"
        ? paint(color, "green", "repository-local (.agents/skills)")
        : paint(color, "yellow", "manual installation")
    }`,
  );
  io.stdout("");

  const changes = result.changes.filter((change) => change.action !== "unchanged");
  if (changes.length === 0) {
    io.stdout(paint(color, "green", "No changes required."));
  } else {
    io.stdout(paint(color, "bold", "Changes:"));
    for (const change of changes) {
      const display = relative(result.root, change.path) || ".";
      const actionStyle = change.action === "create" ? "green" : "yellow";
      const action = paint(color, actionStyle, change.action.padEnd(6));
      const sensitive = change.sensitive ? paint(color, "magenta", " (sensitive)") : "";
      io.stdout(`  ${action} ${display}${sensitive}`);
    }
  }

  if (result.skillMode === "manual") {
    io.stdout("");
    io.stdout(paint(color, "bold", "Install the agent skills later with either:"));
    io.stdout(`  ${paint(color, "cyan", "npx skills add kritama/tama-kit --agent codex --yes")}`);
    io.stdout("");
    io.stdout("Or install the Tama Kit Codex plugin:");
    io.stdout(`  ${paint(color, "cyan", "codex plugin marketplace add kritama/tama-kit")}`);
    io.stdout(`  ${paint(color, "cyan", "codex plugin add tama-kit@upmaru")}`);
  }

  if (result.providerContract) {
    io.stdout("");
    io.stdout(paint(color, "bold", "MCP App local contract:"));
    io.stdout(
      `  ${paint(color, "dim", "Path:")} ${paint(color, "cyan", result.providerContract.path)} (${result.providerContract.action})`,
    );
    io.stdout(
      `  ${paint(color, "dim", "Source:")} ${result.providerContract.source}` +
        (result.providerContract.sourcePath
          ? ` (${paint(color, "cyan", result.providerContract.sourcePath)})`
          : ""),
    );
    io.stdout(`  ${paint(color, "dim", "Bindings:")} ${result.providerContract.bindingSource}`);
    io.stdout(
      `  ${paint(color, "dim", "Environment loading:")} ${result.providerContract.environmentLoading}` +
        (result.providerContract.environmentLoadingEvidencePath
          ? ` via ${result.providerContract.environmentLoadingMechanism} (${paint(color, "cyan", result.providerContract.environmentLoadingEvidencePath)})`
          : ""),
    );
  }

  if (result.provider?.environmentLoading === "unverified") {
    io.stdout("");
    io.stdout(paint(color, "yellow", "Provider environment loading is not verified:"));
    io.stdout(
      `  Configure the provider process to load ${paint(color, "cyan", result.provider.environmentFile)} before starting or restarting it.`,
    );
  }

  if (result.localHttps) {
    io.stdout("");
    io.stdout(paint(color, "bold", "MCP App local HTTPS topology:"));
    io.stdout(`  Provider: ${result.localHttps.providerOrigin}`);
    io.stdout(`  Tama: ${result.localHttps.tamaOrigin}`);
    io.stdout(`  Resource: ${result.localHttps.resource}`);
    io.stdout(
      `  Caddy is the public entry point; upstreams are ${result.localHttps.providerUpstream} and ${result.localHttps.tamaUpstream}.`,
    );
    io.stdout(
      `  Certificate: ${result.localHttps.certificateReady ? "generated/reused" : "planned; generated during write"}; CA trust requires explicit mkcert authorization when needed.`,
    );
  }

  /** @param {{title?: string, lines: string[], style?: import("../terminal.mjs").PaintStyle}} box */
  function printBox(box) {
    const maxWidth = io.columns === undefined ? undefined : io.columns - 4;
    for (const line of renderBox({ ...box, color, maxWidth })) {
      io.stdout(line);
    }
  }

  /** @param {string | null} url */
  function printSetupUrl(url) {
    if (!url) {
      return;
    }
    io.stdout("");
    io.stdout(paint(color, "bold", "Private setup URL:"));
    io.stdout(`  ${paint(color, "magenta", url)}`);
  }

  if (result.started) {
    io.stdout("");
    io.stdout(`Tama is healthy at ${result.healthUrl}`);
    printSetupUrl(setupUrl);
  } else if (result.mode !== "dry-run") {
    const composeReference = relative(io.cwd, result.composeFile) || result.composeFile;
    io.stdout("");
    io.stdout(paint(color, "bold", "Next:"));
    io.stdout(
      `  ${paint(
        color,
        "cyan",
        formatComposeUpCommand(
          composeReference,
          result.localHttps ? "caddy" : "tama",
          Boolean(result.localHttps),
        ),
      )}`,
    );
    printSetupUrl(setupUrl);
  }

  if (result.mcpApp?.providerActivationRequired && result.provider) {
    io.stdout("");
    io.stdout(paint(color, "bold", "Provider activation required:"));
    io.stdout(
      `  Set the provider's ${paint(color, "cyan", result.provider.modeVariable)} to ${paint(color, "cyan", "enabled")}, restart the provider, then rerun this command with ${paint(color, "cyan", "--start --activate")}.`,
    );
    io.stdout(
      "  Tama Kit will record the enabled checkpoint only after both services verify live.",
    );
  }

  if (result.agentPrompt) {
    io.stdout("");
    printBox({
      title: "Copy this prompt into your coding agent",
      lines: result.agentPrompt.split("\n"),
    });
  }
}
