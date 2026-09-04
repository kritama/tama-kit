#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(process.env.MEMOVEE_CHECKOUT ?? "");
if (!process.env.MEMOVEE_CHECKOUT || !existsSync(join(project, "mix.exs"))) {
  throw new Error("MEMOVEE_CHECKOUT must name a Memovee source checkout");
}
const composeFile = join(project, "compose.yaml");
const originalCompose = readFileSync(composeFile, "utf8");
const fragment = join(project, "tama", ".memovee.integration.env");
const providerPort = await availablePort();
let provider;

function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const socket = createTcpServer();
    socket.once("error", reject);
    socket.listen(0, "0.0.0.0", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate a Memovee upstream port"));
        return;
      }
      socket.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
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
    "memovee",
    "--provider-port",
    String(providerPort),
    ...args,
  ]);
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  return result;
}

async function startProvider() {
  const values = parseEnv(readFileSync(fragment, "utf8"));
  const child = spawn("mix", ["phx.server"], {
    cwd: project,
    env: {
      ...process.env,
      ...values,
      MIX_ENV: "dev",
      PHX_SERVER: "true",
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "5432",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Memovee exited before readiness with status ${child.exitCode}`);
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${providerPort}/.well-known/oauth-authorization-server`,
      );
      if (response.ok) return child;
    } catch {
      // Retry while Phoenix compiles and starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  child.kill("SIGTERM");
  throw new Error("Memovee did not start in MIX_ENV=dev");
}

async function stopProvider() {
  if (!provider || provider.exitCode !== null) return;
  provider.kill("SIGTERM");
  await new Promise((resolveExit) => provider.once("exit", resolveExit));
}

try {
  execute("docker", ["compose", "-f", composeFile, "up", "-d", "--wait", "postgres"]);
  execute("mix", ["deps.get"]);
  execute("mix", ["ecto.setup"]);

  bootstrap("--install-local-ca");
  provider = await startProvider();
  const prepared = bootstrap("--start");
  assert.equal(prepared.mcpApp.verified, true);

  await stopProvider();
  const enabledFragment = readFileSync(fragment, "utf8").replace(
    /^MEMOVEE_TAMA_MCP_APP_MODE=prepared$/mu,
    "MEMOVEE_TAMA_MCP_APP_MODE=enabled",
  );
  writeFileSync(fragment, enabledFragment, { mode: 0o600 });
  provider = await startProvider();
  const enabled = bootstrap("--start", "--activate");
  assert.equal(enabled.mcpApp.mode, "enabled");
  assert.equal(enabled.mcpApp.verified, true);

  console.log("Memovee MIX_ENV=dev local HTTPS runtime validation passed.");
} finally {
  await stopProvider();
  try {
    execute("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"]);
  } catch {
    // Preserve the primary validation failure.
  }
  writeFileSync(composeFile, originalCompose);
}
