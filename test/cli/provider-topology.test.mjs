import assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { readMcpAppProvider } from "../../cli/bootstrap/manifest.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { providerServiceDependency } from "../../cli/bootstrap/provider-topology.mjs";
import { parseBootstrap } from "../../cli/commands/bootstrap-options.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/shared/write.mjs";
import { planWithMcp, preparedFor, project } from "../helpers/mcp-app.mjs";

function fixture({ healthy = true, loader = true } = {}) {
  const root = project("tama-kit-compose-provider-");
  writeFileSync(
    join(root, "compose.yaml"),
    `services:
  memovee:
    image: example/provider:dev
    ${loader ? "env_file: [./tama/.memovee.integration.env]" : "command: serve"}
    ${healthy ? 'healthcheck: {test: [CMD, curl, -f, "http://localhost:4000/"]}' : ""}
`,
  );
  return root;
}

function plan(root, options = {}) {
  return planWithMcp(
    root,
    { ...preparedFor(root), allowedOrigins: ["https://app.localhost"] },
    options,
  );
}

test("Compose provider configuration is managed, public identities stay HTTPS, and reruns need no flags", () => {
  const root = fixture();
  const first = plan(root, { providerService: "memovee" });
  assert.equal(first.localHttps.providerUpstream, "http://memovee:4000");
  assert.equal(first.localHttps.providerDependency, "service_healthy");
  assert.equal(first.mcpApp.providerOrigin, "https://app.localhost");
  assert.equal(first.mcpApp.resource, "https://tama.app.localhost/mcp/app");
  assert.equal(first.mcpApp.environmentLoading, "verified");
  const compose = parse(
    first.operations.find((op) => op.path === join(root, "tama/compose.yaml")).content,
  );
  assert.deepEqual(compose.services.caddy.depends_on.memovee, { condition: "service_healthy" });
  assert.equal(compose.services.caddy.extra_hosts, undefined);
  assert.equal(compose.services.tama.extra_hosts, undefined);
  assert.match(
    first.operations.find((op) => op.path.endsWith("/Caddyfile")).content,
    /reverse_proxy http:\/\/memovee:4000/,
  );
  applyOperations(first.operations);
  assert.equal(readMcpAppProvider(join(root, "tama")).localHttps.providerService, "memovee");
  for (const rerun of [plan(root), createBootstrapPlan({ cwd: root })]) {
    assert.equal(rerun.localHttps.providerService, "memovee");
    assert.ok(rerun.operations.every((operation) => operation.action === "unchanged"));
  }
  writeFileSync(join(root, "tama/Caddyfile"), "# application edit\n");
  assert.throws(() => plan(root), /user-modified/);
});

test("provider loader evidence must belong to the selected service", () => {
  const root = fixture({ loader: false, healthy: false });
  writeFileSync(
    join(root, "compose.yaml"),
    `${readFileSync(join(root, "compose.yaml"), "utf8")}  unrelated:
    image: example/other
    env_file: [./tama/.memovee.integration.env]
`,
  );
  writeFileSync(join(root, ".envrc"), "dotenv tama/.memovee.integration.env\n");
  const result = plan(root, { providerService: "memovee" });
  assert.equal(result.mcpApp.environmentLoading, "unverified");
  assert.equal(result.localHttps.providerDependency, "service_started");
});

test("provider runtime migration is explicit and preserves signing material", () => {
  const root = fixture();
  applyOperations(plan(root).operations);
  const secret = readFileSync(join(root, "tama/.memovee.integration.env"), "utf8");
  assert.throws(() => plan(root, { providerService: "memovee" }), /migrate-provider-topology/);
  applyOperations(
    plan(root, { providerService: "memovee", migrateProviderTopology: true }).operations,
  );
  assert.equal(readFileSync(join(root, "tama/.memovee.integration.env"), "utf8"), secret);
  assert.throws(() => plan(root, { providerRuntime: "host" }), /migrate-provider-topology/);
  applyOperations(
    plan(root, { providerRuntime: "host", migrateProviderTopology: true }).operations,
  );
  assert.equal(readMcpAppProvider(join(root, "tama")).localHttps.providerService, undefined);
  assert.equal(readFileSync(join(root, "tama/.memovee.integration.env"), "utf8"), secret);
});

test("invalid, missing, unreachable, or cyclic provider service selections fail before writing", () => {
  const root = fixture();
  for (const name of ["caddy", "tama", "../escape", "a\n  injected:", "missing"]) {
    assert.throws(() => plan(root, { providerService: name }));
  }
  for (const extra of [
    "network_mode: host",
    "networks: [private]",
    "profiles: [optional]",
    "extends: base",
    "depends_on: [caddy]",
  ]) {
    writeFileSync(
      join(root, "compose.yaml"),
      `services:\n  memovee:\n    image: example/provider\n    ${extra}\n`,
    );
    assert.throws(
      () => providerServiceDependency(join(root, "compose.yaml"), "memovee"),
      /provider service/,
    );
  }
});

test("provider topology flags require MCP App and cannot migrate while activating", () => {
  assert.throws(() => parseBootstrap(["--provider-service", "memovee"]), /require --mcp-app/);
  assert.throws(
    () => parseBootstrap(["--mcp-app", "--provider-runtime", "invalid"]),
    /must be host or compose/,
  );
  assert.throws(
    () => parseBootstrap(["--mcp-app", "--migrate-provider-topology", "--start", "--activate"]),
    /prepared mode/,
  );
  assert.equal(
    parseBootstrap(["--mcp-app", "--provider-service", "memovee"]).providerService,
    "memovee",
  );
});

test("service removal and symlink replacement are refused on ordinary reruns", () => {
  const root = fixture();
  applyOperations(plan(root, { providerService: "memovee" }).operations);
  const composePath = join(root, "compose.yaml");
  writeFileSync(composePath, "services: {}\n");
  assert.throws(() => createBootstrapPlan({ cwd: root }), /must be declared/);
  unlinkSync(composePath);
  const other = fixture();
  symlinkSync(join(other, "compose.yaml"), composePath);
  assert.throws(() => createBootstrapPlan({ cwd: root }), /regular file|resolve inside/);
});

test("failed topology write restores the previous managed routing and manifest", async () => {
  const root = fixture();
  applyOperations(plan(root).operations);
  const filenames = [
    "tama/.tama-kit.json",
    "tama/compose.yaml",
    "tama/Caddyfile",
    "tama/.memovee.integration.env",
  ];
  const previous = filenames.map((name) => readFileSync(join(root, name), "utf8"));
  const migration = plan(root, { providerService: "memovee", migrateProviderTopology: true });
  await assert.rejects(
    applyOperationsTransactionally(migration.operations, async () => {
      throw new Error("invalid composed project");
    }),
    /invalid composed project/,
  );
  assert.deepEqual(
    filenames.map((name) => readFileSync(join(root, name), "utf8")),
    previous,
  );
});

test("enabled provider or Tama configurations cannot migrate provider topology", () => {
  for (const name of ["tama/.tama.env", "tama/.memovee.integration.env"]) {
    const root = fixture();
    applyOperations(plan(root).operations);
    const path = join(root, name);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/(_MCP_APP_MODE=)prepared/g, "$1enabled"),
    );
    assert.throws(
      () => plan(root, { providerService: "memovee", migrateProviderTopology: true }),
      /prepared mode/,
    );
  }
});

test("application health-check changes are recorded and then remain idempotent", () => {
  const root = fixture({ healthy: false });
  applyOperations(plan(root, { providerService: "memovee" }).operations);
  const path = join(root, "compose.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "image: example/provider:dev",
      'image: example/provider:dev\n    healthcheck: {test: "curl -f http://localhost:4000/"}',
    ),
  );
  applyOperations(createBootstrapPlan({ cwd: root }).operations);
  assert.equal(
    readMcpAppProvider(join(root, "tama")).localHttps.providerDependency,
    "service_healthy",
  );
  assert.ok(createBootstrapPlan({ cwd: root }).operations.every((op) => op.action === "unchanged"));
});
