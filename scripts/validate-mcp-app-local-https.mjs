#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { prepareLocalTestCa } from "./lib/local-test-ca.mjs";

const addition = process.argv.includes("--addition");
const composeProvider = process.argv.includes("--compose-provider");
let caRoot;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = mkdtempSync(join(realpathSync(tmpdir()), "tama-kit-mcp-app-https-"));
const composeFile = join(project, "compose.yaml");
const tlsDirectory = addition ? "mcp-app-tls" : "tls";
const composeArgs = () => [
  "compose",
  "-f",
  composeFile,
  ...(addition && existsSync(join(project, "tama/compose.mcp-app.yaml"))
    ? ["-f", join(project, "tama/compose.mcp-app.yaml")]
    : []),
];
const fragment = join(project, "tama", ".fixture.integration.env");
let provider;
const providerPort = composeProvider
  ? 4000
  : await new Promise((resolvePort, reject) => {
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
    env: {
      ...process.env,
      CAROOT: caRoot,
      COMPOSE_PROJECT_NAME: project.split("/").at(-1).toLowerCase(),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function bootstrap(...args) {
  const continuing = args.includes("--start");
  const output = execute(process.execPath, [
    join(repositoryRoot, "bin", "tama-kit.mjs"),
    ...(continuing ? ["setup"] : addition ? ["generate", "mcp-app"] : ["bootstrap"]),
    project,
    "--json",
    ...(continuing
      ? []
      : [
          ...(addition ? [] : ["--skills", "manual", "--mcp-app"]),
          "--provider-name",
          "fixture",
          "--provider-port",
          String(providerPort),
        ]),
    ...(continuing && addition
      ? ["--compose", composeFile, "--compose", join(project, "tama/compose.mcp-app.yaml")]
      : []),
    ...(composeProvider ? ["--provider-service", "fixture"] : []),
    ...args.filter((arg) => arg !== "--start"),
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

  if (composeProvider) {
    writeFileSync(
      composeFile,
      `services:
  fixture:
    image: node:24-alpine
    command: [node, /fixture.mjs, /workspace/tama/.fixture.integration.env, "4000"]
    env_file: [{path: ./tama/.fixture.integration.env, required: false}]
    environment:
      NODE_EXTRA_CA_CERTS: /workspace/tama/${tlsDirectory}/rootCA.pem
    volumes:
      - ${JSON.stringify(`${join(repositoryRoot, "scripts/fixtures/mcp-app-provider.mjs")}:/fixture.mjs:ro`)}
      - ./tama:/workspace/tama:ro
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:4000/.well-known/oauth-authorization-server').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      retries: 15
`,
    );
  }
  caRoot = prepareLocalTestCa(project);
  if (addition) {
    execute(process.execPath, [
      join(repositoryRoot, "bin/tama-kit.mjs"),
      "bootstrap",
      project,
      "--image",
      "ghcr.io/upmaru/tama:0.13.2-server",
      "--json",
    ]);
  }
  const prepared = bootstrap();
  if (addition) assert.equal(prepared.generation.status, "complete");
  else {
    assert.equal(prepared.localHttps.providerOrigin, "https://app.localhost");
    assert.equal(prepared.localHttps.tamaOrigin, "https://tama.app.localhost");
    assert.equal(prepared.localHttps.certificateReady, true);
  }

  if (addition) {
    const receiptPath = join(project, "tama/.tama-kit-mcp-app.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const bundlePath = join(project, "tama/mcp-app-tls/local.pem");
    const originalBundle = readFileSync(bundlePath, "utf8");
    // Simulate an interruption with only the public CA copy still pending.
    receipt.progress = {
      status: "incomplete",
      pendingDestinations: ["tama/mcp-app-tls/rootCA.pem"],
    };
    writeFileSync(receiptPath, JSON.stringify(receipt));
    unlinkSync(join(project, "tama/mcp-app-tls/rootCA.pem"));
    assert.equal(bootstrap("--resume", receipt.operation.id).generation.status, "complete");
    assert.equal(
      readFileSync(bundlePath, "utf8"),
      originalBundle,
      "resume must preserve the existing TLS key and certificate",
    );
  }

  const tamaEnvironment = parseEnv(
    readFileSync(join(project, "tama", addition ? ".mcp-app.env" : ".tama.env"), "utf8"),
  );
  assert.equal(tamaEnvironment.PHX_HOST, "tama.app.localhost");
  assert.equal(Object.hasOwn(tamaEnvironment, "TAMA_MCP_APP_RESOURCE"), false);
  assert.equal(Object.hasOwn(tamaEnvironment, "TAMA_MCP_APP_INTROSPECTION_CLIENT_ID"), false);

  const localCaDockerfile = readFileSync(join(project, "tama", "tama-local-ca.Dockerfile"), "utf8");
  assert.match(localCaDockerfile, /^FROM ghcr\.io\/upmaru\/tama:0\.13\.2-server$/mu);
  assert.match(localCaDockerfile, /^COPY (?:mcp-app-)?tls\/rootCA\.pem /mu);
  assert.doesNotMatch(localCaDockerfile, /local-key|rootCA-key|rootCA\.key/u);

  if (!composeProvider) {
    provider = spawn(
      process.execPath,
      [
        join(repositoryRoot, "scripts/fixtures/mcp-app-provider.mjs"),
        fragment,
        String(providerPort),
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(project, "tama", tlsDirectory, "rootCA.pem"),
        },
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
  }

  // The application's workflow starts its provider; setup must never recreate it.
  let providerContainer;
  if (composeProvider) {
    execute("docker", [...composeArgs(), "up", "-d", "fixture"]);
    providerContainer = execute("docker", [...composeArgs(), "ps", "-q", "fixture"]).trim();
  }
  const runningPrepared = bootstrap("--start");
  assert.equal(runningPrepared.mcpApp.verified, true);
  execute("docker", [
    ...composeArgs(),
    "exec",
    "-T",
    "tama",
    "sh",
    "-c",
    "test -s /usr/local/share/ca-certificates/tama-kit-local.crt && getent hosts app.localhost >/dev/null && getent hosts tama.app.localhost >/dev/null",
  ]);

  const handoff = bootstrap("--start", "--activate");
  assert.equal(handoff.mcpApp.providerActivationRequired, true);
  assert.equal(handoff.setup.phase, "provider-restart-required");

  const enabledFragment = readFileSync(fragment, "utf8").replace(
    /^FIXTURE_TAMA_MCP_APP_MODE=prepared$/mu,
    "FIXTURE_TAMA_MCP_APP_MODE=enabled",
  );
  writeFileSync(fragment, enabledFragment, { mode: 0o600 });
  if (composeProvider) execute("docker", [...composeArgs(), "restart", "fixture"]);
  const enabled = bootstrap("--start", "--activate");
  assert.equal(enabled.mcpApp.mode, "enabled");
  assert.equal(enabled.mcpApp.verified, true);

  assert.equal(enabled.setup.phase, "enabled");
  if (composeProvider)
    assert.equal(
      execute("docker", [...composeArgs(), "ps", "-q", "fixture"]).trim(),
      providerContainer,
      "setup must not recreate the application provider",
    );
  console.log(
    `MCP App local HTTPS runtime validation passed (${addition ? "additive generation, " : ""}${composeProvider ? "Compose provider" : "host provider"}).`,
  );
} catch (error) {
  // Fixture-only diagnostics, redacted against every private environment value.
  const secrets = [
    fragment,
    join(project, "tama/.tama.env"),
    join(project, "tama/.mcp-app.env"),
    join(project, "tama/.tama.postgres.env"),
  ]
    .filter(existsSync)
    .flatMap((path) => Object.values(parseEnv(readFileSync(path, "utf8"))))
    .filter((value) => value.length >= 5)
    .sort((a, b) => b.length - a.length);
  for (const args of [
    ["ps", "--all"],
    ["logs", "--no-color", "--tail", "80"],
  ]) {
    try {
      let output = execute("docker", [...composeArgs(), ...args]);
      for (const value of secrets) output = output.replaceAll(value, "[redacted]");
      console.error(output);
    } catch {
      /* Preserve the primary validation failure. */
    }
  }
  throw error;
} finally {
  if (provider) provider.kill("SIGTERM");
  if (existsSync(composeFile)) {
    try {
      execute("docker", [...composeArgs(), "down", "-v", "--remove-orphans"]);
    } catch {
      // Preserve the primary validation failure.
    }
  }
  rmSync(project, { recursive: true, force: true });
}
