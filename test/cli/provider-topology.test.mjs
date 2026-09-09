import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  providerServiceDependency,
  resolveProviderTopology,
} from "../../cli/bootstrap/provider-topology.mjs";
import { parseBootstrap } from "../../cli/commands/bootstrap-options.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
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

test("fresh Compose provider generation keeps public identities HTTPS without saving desired topology", () => {
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
  const contract = JSON.parse(
    readFileSync(join(root, "tama/contracts/mcp-app-provider-v1.json"), "utf8"),
  );
  assert.equal(contract.topology.provider_origin, "https://app.localhost");
  const receipt = JSON.parse(readFileSync(join(root, "tama/.tama-kit.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.mcpAppProvider, undefined);
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

test("provider topology validates the complete ordered Compose selection", () => {
  const root = project();
  const compose = join(root, "compose.yaml");
  const override = join(root, "override.yaml");
  writeFileSync(compose, "services:\n  tama:\n    image: example/tama\n");
  writeFileSync(
    override,
    "services:\n  memovee:\n    image: example/provider:dev\n    healthcheck: {test: [CMD, check]}\n",
  );
  assert.equal(providerServiceDependency([compose, override], "memovee"), "service_healthy");
  assert.deepEqual(
    resolveProviderTopology({ providerRuntime: "compose", providerService: "memovee" }, [
      compose,
      override,
    ]),
    { providerService: "memovee", providerDependency: "service_healthy" },
  );
});

test("generated setup guidance describes the selected provider runtime", () => {
  for (const providerService of [undefined, "memovee"]) {
    const root = fixture();
    const first = plan(root, { providerService });
    const readmePath = join(root, "tama/README.md");
    const readme = first.operations.find((op) => op.path === readmePath).content;
    if (providerService) {
      assert.match(readme, /provider runs in the application-owned Compose service `memovee`/);
      assert.match(readme, /does not restart the provider Compose service `memovee`/);
      assert.match(readme, /http:\/\/memovee:4000/);
      assert.doesNotMatch(readme, /host-native|MIX_ENV=dev/);
    } else {
      assert.match(readme, /provider remains host-native in MIX_ENV=dev/);
      assert.match(readme, /does not restart the host-native provider/);
      assert.match(readme, /http:\/\/host\.docker\.internal:4000/);
    }
    assert.match(readme, /MIX_ENV=prod/);
    assert.match(readme, /both live services pass verification/);
    applyOperations(first.operations);
    assert.equal(readFileSync(readmePath, "utf8"), readme);
  }
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

test("unresolved YAML merges cannot hide provider topology or dependency constraints", () => {
  const root = fixture();
  const path = join(root, "compose.yaml");
  for (const inherited of [
    "networks: [private]",
    "profiles: [optional]",
    "depends_on: [caddy]",
    "network_mode: host",
    "extends: base",
  ]) {
    writeFileSync(
      path,
      `x-provider: &provider_defaults\n  ${inherited}\nservices:\n  memovee:\n    <<: *provider_defaults\n    image: example/provider\n`,
    );
    assert.throws(() => providerServiceDependency(path, "memovee"), /unresolved YAML merges/);
  }
  writeFileSync(
    path,
    `x-dependencies: &dependencies\n  caddy: {condition: service_started}\nservices:\n  memovee:\n    image: example/provider\n    depends_on:\n      <<: *dependencies\n`,
  );
  assert.throws(() => providerServiceDependency(path, "memovee"), /unresolved YAML merges/);
  writeFileSync(
    path,
    `x-worker: &worker_defaults\n  depends_on: [caddy]\nservices:\n  memovee:\n    image: example/provider\n    depends_on: [worker]\n  worker:\n    <<: *worker_defaults\n    image: example/worker\n`,
  );
  assert.throws(() => providerServiceDependency(path, "memovee"), /unresolved YAML merges/);
  // A merge in the services mapping can hide a transitive dependency too.
  writeFileSync(
    path,
    `x-services: &services\n  worker:\n    image: example/worker\n    depends_on: [caddy]\nservices:\n  <<: *services\n  memovee:\n    image: example/provider\n    depends_on: [worker]\n`,
  );
  assert.throws(() => providerServiceDependency(path, "memovee"), /unresolved YAML merges/);
  // Ordinary aliases have already been resolved by the YAML parser.
  writeFileSync(
    path,
    `x-provider: &provider\n  image: example/provider\n  healthcheck: {test: [CMD, check]}\nservices:\n  memovee: *provider\n`,
  );
  assert.equal(providerServiceDependency(path, "memovee"), "service_healthy");
});
