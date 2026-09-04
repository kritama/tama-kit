#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = mkdtempSync(join(tmpdir(), "tama-kit-mcp-app-https-"));
const composeFile = join(project, "compose.yaml");
const fragment = join(project, "tama", ".fixture.integration.env");
let provider;
const providerPort = await new Promise((resolvePort, reject) => {
  const socket = createTcpServer();
  socket.once("error", reject);
  socket.listen(0, "0.0.0.0", () => {
    const address = socket.address();
    if (!address || typeof address === "string") {
      reject(new Error("could not allocate a provider fixture port"));
      return;
    }
    socket.close((error) => (error ? reject(error) : resolvePort(address.port)));
  });
});

function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function bootstrap(...args) {
  const output = execute(process.execPath, [
    join(repositoryRoot, "bin", "tama-kit.mjs"),
    "bootstrap",
    project,
    "--json",
    "--skills",
    "manual",
    "--mcp-app",
    "--provider-name",
    "fixture",
    "--provider-port",
    String(providerPort),
    ...args,
  ]);
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  return result;
}

try {
  writeFileSync(join(project, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(
    join(project, ".envrc"),
    "if [ -f ./tama/.fixture.integration.env ]; then\n  . ./tama/.fixture.integration.env\nfi\n",
  );
  mkdirSync(join(project, "tama"), { recursive: true });

  const prepared = bootstrap("--install-local-ca");
  assert.equal(prepared.localHttps.providerOrigin, "https://app.localhost");
  assert.equal(prepared.localHttps.tamaOrigin, "https://tama.app.localhost");
  assert.equal(prepared.localHttps.certificateReady, true);

  const tamaEnvironment = parseEnv(readFileSync(join(project, "tama", ".tama.env"), "utf8"));
  assert.equal(tamaEnvironment.PHX_HOST, "tama.app.localhost");
  assert.equal(Object.hasOwn(tamaEnvironment, "TAMA_MCP_APP_RESOURCE"), false);
  assert.equal(Object.hasOwn(tamaEnvironment, "TAMA_MCP_APP_INTROSPECTION_CLIENT_ID"), false);

  const localCaDockerfile = readFileSync(join(project, "tama", "tama-local-ca.Dockerfile"), "utf8");
  assert.match(localCaDockerfile, /^FROM ghcr\.io\/upmaru\/tama:0\.13\.2-server$/mu);
  assert.match(localCaDockerfile, /^COPY tls\/rootCA\.pem /mu);
  assert.doesNotMatch(localCaDockerfile, /local-key|rootCA-key|rootCA\.key/u);

  provider = spawn(
    process.execPath,
    [join(repositoryRoot, "scripts/fixtures/mcp-app-provider.mjs"), fragment, String(providerPort)],
    {
      cwd: project,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(project, "tama", "tls", "rootCA.pem") },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await new Promise((resolveReady, reject) => {
    provider.once("error", reject);
    provider.stdout.once("data", (chunk) =>
      chunk.toString("utf8").includes("ready:")
        ? resolveReady(undefined)
        : reject(new Error("provider fixture did not report readiness")),
    );
  });

  const runningPrepared = bootstrap("--start");
  assert.equal(runningPrepared.mcpApp.verified, true);
  execute("docker", [
    "compose",
    "-f",
    composeFile,
    "exec",
    "-T",
    "tama",
    "sh",
    "-c",
    "test -s /usr/local/share/ca-certificates/tama-kit-local.crt && getent hosts app.localhost >/dev/null && getent hosts tama.app.localhost >/dev/null",
  ]);

  const enabledFragment = readFileSync(fragment, "utf8").replace(
    /^FIXTURE_TAMA_MCP_APP_MODE=prepared$/mu,
    "FIXTURE_TAMA_MCP_APP_MODE=enabled",
  );
  writeFileSync(fragment, enabledFragment, { mode: 0o600 });
  const enabled = bootstrap("--start", "--activate");
  assert.equal(enabled.mcpApp.mode, "enabled");
  assert.equal(enabled.mcpApp.verified, true);

  console.log("MCP App local HTTPS runtime validation passed.");
} finally {
  if (provider) provider.kill("SIGTERM");
  if (existsSync(composeFile)) {
    try {
      execute("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"]);
    } catch {
      // Preserve the primary validation failure.
    }
  }
  rmSync(project, { recursive: true, force: true });
}
