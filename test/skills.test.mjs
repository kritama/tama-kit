import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP App guidance makes bootstrap validation the first provider-work gate", () => {
  const appIntegration = readFileSync(resolve(ROOT, "skills/app-integration/SKILL.md"), "utf8");
  const bootstrapGate = appIntegration.indexOf("## Validate Tama Kit bootstrap state first");
  const readiness = appIntegration.indexOf("## Assess provider readiness after the bootstrap gate");

  assert.notEqual(bootstrapGate, -1);
  assert.notEqual(readiness, -1);
  assert.ok(bootstrapGate < readiness);
  assert.match(appIntegration, /tama\/\.tama-kit\.json/u);
  assert.match(appIntegration, /intended Compose file/u);
  assert.match(appIntegration, /## Check Docker before continuing/u);
  assert.match(appIntegration, /docker compose version/u);
  assert.match(appIntegration, /docker info --format/u);
  assert.match(appIntegration, /pause and tell the user/u);
  assert.match(appIntegration, /bootstrap --mcp-app --dry-run --json/u);
  assert.match(appIntegration, /does not require a sibling Tama source checkout/u);
  assert.match(appIntegration, /provider-origin http:\/\/host\.docker\.internal/u);
  assert.match(appIntegration, /reuse `--skills local`/u);
  assert.match(appIntegration, /--skills <resolved-skill-mode>/u);
  assert.match(appIntegration, /every non-loopback allowed origin\s+must use HTTPS/u);
  assert.match(appIntegration, /`--activate` requires both/u);
  assert.match(appIntegration, /reported private `\/setup\/root\?token=\.\.\.` URL/u);
  assert.match(appIntegration, /in-app browser/u);
  assert.match(appIntegration, /stop provider implementation work/u);
});

test("Tama Kit CLI guidance repeats the bootstrap gate", () => {
  const tamaKitCli = readFileSync(resolve(ROOT, "skills/tama-kit-cli/SKILL.md"), "utf8");
  const providerWorkflow = tamaKitCli.indexOf("## MCP App provider bootstrap");
  const bootstrapState = tamaKitCli.indexOf("the Tama Kit bootstrap state before");
  const oauthReadiness = tamaKitCli.indexOf("After the bootstrap gate passes");

  assert.ok(providerWorkflow < bootstrapState);
  assert.ok(bootstrapState < oauthReadiness);
  assert.match(tamaKitCli, /tama\/contracts\/mcp-app-provider-v1\.json/u);
  assert.match(tamaKitCli, /## Check Docker before continuing/u);
  assert.match(tamaKitCli, /docker compose version/u);
  assert.match(tamaKitCli, /docker info --format/u);
  assert.match(tamaKitCli, /hard preflight failure/u);
  assert.match(tamaKitCli, /bootstrap --mcp-app --dry-run --json/u);
  assert.match(tamaKitCli, /Do not require a Tama source checkout/u);
  assert.match(tamaKitCli, /in-app browser/u);
  assert.match(tamaKitCli, /## Standard application command contract/u);
  assert.match(tamaKitCli, /## Complete interactive Tama setup when requested/u);
  assert.match(tamaKitCli, /### Tama source-development command contract/u);
  assert.match(tamaKitCli, /### Standalone System OAuth key command contract/u);
  assert.match(tamaKitCli, /existing `local` mode must remain `--skills local`/u);
  assert.match(tamaKitCli, /--skills <resolved-skill-mode> --dry-run --json/u);
  assert.doesNotMatch(tamaKitCli, /--skills manual --dry-run --json/u);
  assert.match(tamaKitCli, /every non-loopback allowed\s+origin must use HTTPS/u);
  assert.doesNotMatch(tamaKitCli, /CLI reference/u);
});

test("generated local instructions gate Docker runtime use", () => {
  const agents = readFileSync(resolve(ROOT, "cli/templates/bootstrap/AGENTS.md"), "utf8");
  const readme = readFileSync(resolve(ROOT, "cli/templates/bootstrap/README.md"), "utf8");

  for (const instructions of [agents, readme]) {
    assert.match(instructions, /docker --version/u);
    assert.match(instructions, /docker compose version/u);
    assert.match(instructions, /docker info --format/u);
    assert.match(instructions, /install or\s+start\/initialize Docker/u);
  }
});
