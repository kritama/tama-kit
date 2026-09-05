import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateSecretFilesIgnored } from "../../cli/bootstrap/gitignore.mjs";
import {
  contractTamaPort,
  loadTamaContract,
  validateMcpAppContract,
} from "../../cli/bootstrap/mcp-app-contract.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { resolveProviderIdentity } from "../../cli/bootstrap/provider-identity.mjs";
import { validateWrittenSecretsIgnored } from "../../cli/bootstrap/secrets.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/shared/write.mjs";
import {
  command,
  MEMOVEE,
  memoveeContract,
  PINNED_TAMA_IMAGE,
  planWithMcp,
  preparedFor,
  prepareFor,
  project,
  validContract,
  writeContract,
} from "../helpers/mcp-app.mjs";

test("bootstrap preserves unrelated .integration.env ignore entries on MCP App reruns", async () => {
  const root = project();
  const originalPrepared = await prepareFor(root, {
    providerName: "acme",
    providerOrigin: "http://host.docker.internal:5000",
  });
  applyOperations(
    planWithMcp(root, originalPrepared, { providerOrigin: "http://host.docker.internal:5000" })
      .operations,
  );
  const gitignorePath = join(root, "tama", ".gitignore");
  writeFileSync(gitignorePath, `${readFileSync(gitignorePath, "utf8")}.other.integration.env\n`);

  applyOperations(
    planWithMcp(
      root,
      await prepareFor(root, { providerOrigin: "http://host.docker.internal:5000" }),
      { providerOrigin: "http://host.docker.internal:5000" },
    ).operations,
  );
  let gitignore = readFileSync(gitignorePath, "utf8");
  assert.match(gitignore, /^\/?\.other\.integration\.env$/mu);
  assert.match(gitignore, /^\/\.acme\.integration\.env$/mu);

  writeFileSync(join(root, ".envrc"), 'dotenv_load "tama/.beta.integration.env"\n');
  const migratedPrepared = await prepareFor(root, {
    providerName: "beta",
    providerPrefix: "BETA",
    providerOrigin: "http://host.docker.internal:5000",
    migrateProviderIdentity: true,
  });
  applyOperations(
    planWithMcp(root, migratedPrepared, {
      providerOrigin: "http://host.docker.internal:5000",
      migrateProviderIdentity: true,
    }).operations,
  );
  gitignore = readFileSync(gitignorePath, "utf8");
  assert.doesNotMatch(gitignore, /acme\.integration\.env/u);
  assert.match(gitignore, /^\/?\.other\.integration\.env$/mu);
  assert.match(gitignore, /^\/\.beta\.integration\.env$/mu);
  assert.equal(gitignore.split("# Tama Kit local runtime").length - 1, 1);
  assert.equal(gitignore.split("# Tama Kit MCP App integration").length - 1, 1);
});

test("bootstrap rejects nested Git ignore overrides and rolls generated secrets back", async () => {
  const root = project();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, "tama", "config"), { recursive: true });
  writeFileSync(join(root, "tama", "config", ".gitignore"), "!provider.env\n");

  const contract = memoveeContract();
  contract.provider = {
    name: "memovee",
    environment_prefix: "MEMOVEE",
    environment_file: "tama/config/provider.env",
  };
  contract.environment_loading.loads = "tama/config/provider.env";
  const contractDocument = validateMcpAppContract(contract);
  const contractPath = writeContract(root, contract);
  const plan = planWithMcp(
    root,
    preparedFor(root, {
      contractPath,
      contractDocument,
      identity: {
        name: "memovee",
        environmentPrefix: "MEMOVEE",
        environmentFile: "tama/config/provider.env",
        source: "contract",
      },
    }),
  );

  await assert.rejects(
    () =>
      applyOperationsTransactionally(plan.operations, () => {
        validateSecretFilesIgnored(root, [
          "tama/.tama.env",
          "tama/.tama.postgres.env",
          "tama/config/provider.env",
        ]);
      }),
    /(?:not effectively ignored by Git.*nested \.gitignore|destination is not ignored by Git)/u,
  );
  assert.equal(existsSync(join(root, "tama", ".tama.env")), false);
  assert.equal(existsSync(join(root, "tama", ".tama.postgres.env")), false);
  assert.equal(existsSync(join(root, "tama", "config", "provider.env")), false);
});

test("ordinary reruns validate effective ignores for the persisted provider fragment", async () => {
  const root = project();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, "tama", "config"), { recursive: true });

  const contract = memoveeContract();
  contract.provider = {
    name: "memovee",
    environment_prefix: "MEMOVEE",
    environment_file: "tama/config/provider.env",
  };
  contract.environment_loading.loads = "tama/config/provider.env";
  const contractDocument = validateMcpAppContract(contract);
  const contractPath = writeContract(root, contract);
  const initial = planWithMcp(
    root,
    preparedFor(root, {
      contractPath,
      contractDocument,
      identity: {
        name: "memovee",
        environmentPrefix: "MEMOVEE",
        environmentFile: "tama/config/provider.env",
        source: "contract",
      },
    }),
  );
  applyOperations(initial.operations);
  writeFileSync(join(root, "tama", "config", ".gitignore"), "!provider.env\n");

  const ordinary = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: PINNED_TAMA_IMAGE,
  });
  await assert.rejects(
    () =>
      applyOperationsTransactionally(ordinary.operations, () => {
        validateWrittenSecretsIgnored(ordinary);
      }),
    /not effectively ignored by Git: tama\/config\/provider\.env/u,
  );
});

test("bootstrap rejects a Tama port change while an MCP App integration is persisted", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );
  assert.throws(
    () => createBootstrapPlan({ cwd: root, targetPath: root, port: 4020 }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /persisted MCP App integration advertises Tama at http:\/\/127\.0\.0\.1:4001/u.test(
        error.message,
      ),
  );
  assert.doesNotThrow(() =>
    createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
  );
});

test("contractTamaPort derives the fresh Tama port from the accepted contract", () => {
  const contract = validContract();
  assert.equal(contractTamaPort(contract, null), 4001);
  assert.equal(contractTamaPort(null, loadTamaContract()), null);
  const override = structuredClone(memoveeContract());
  override.local_development.tama_origin = "http://127.0.0.1:4567";
  assert.equal(contractTamaPort(validateMcpAppContract(override), loadTamaContract()), 4567);
  const none = structuredClone(memoveeContract());
  delete none.local_development.tama_origin;
  assert.equal(contractTamaPort(null, validateMcpAppContract(none)), null);
});

test("bootstrap derives the fresh Tama port from the accepted contract", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const plan = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: PINNED_TAMA_IMAGE,
    mcpApp: {
      requested: true,
      activate: false,
      allowedOrigins: ["http://127.0.0.1:3000"],
    },
    mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
  });
  assert.equal(plan.port, 4001);
  assert.equal(plan.mcpApp?.tamaOrigin, "http://127.0.0.1:4001");
  assert.equal(plan.mcpApp?.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(plan.mcpApp?.resource, "http://127.0.0.1:4001/mcp/app");
  assert.equal(plan.mcpApp?.introspectionClientId, "http://127.0.0.1:4001/mcp/app/introspection");
});

test("bootstrap rejects a Tama port that collides with the host-native provider", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  assert.throws(
    () =>
      createBootstrapPlan({
        cwd: root,
        targetPath: root,
        image: PINNED_TAMA_IMAGE,
        port: 4000,
        mcpApp: {
          requested: true,
          activate: false,
          allowedOrigins: ["http://127.0.0.1:3000"],
        },
        mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /collides with the provider origin/u.test(error.message),
  );
});

test("bootstrap rejects an https container-gateway provider origin", () => {
  const root = project();
  assert.throws(
    () =>
      planWithMcp(root, preparedFor(root), {
        providerOrigin: "https://host.docker.internal:5000",
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /cannot be verified from the host/u.test(error.message) &&
      /http:\/\/host\.docker\.internal:5000/u.test(error.message),
  );
});

test("bootstrap rejects an HTTPS Tama origin without TLS termination", () => {
  const root = project();
  assert.throws(
    () =>
      planWithMcp(root, preparedFor(root), {
        providerOrigin: "http://host.docker.internal:4000",
        tamaOrigin: "https://127.0.0.1:4001",
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /must use an http loopback origin.*does not terminate TLS/u.test(error.message),
  );
});

test("bootstrap retains the host-gateway mapping on ordinary reruns", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);
  assert.match(readFileSync(join(root, "tama", "compose.yaml"), "utf8"), /host-gateway/u);

  // The mapping is derived from the persisted provider origin, so an
  // ordinary rerun re-renders the identical Compose file.
  const rerun = createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE });
  const composeOperation = rerun.operations.find((operation) =>
    operation.path.endsWith(join("tama", "compose.yaml")),
  );
  assert.equal(composeOperation?.action, "unchanged");
});

test("ordinary reruns keep the MCP App documentation rendered from the persisted integration", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);
  assert.match(
    readFileSync(join(root, "tama", ".tama.env.example"), "utf8"),
    /host\.docker\.internal/u,
  );

  // An ordinary rerun does not plan the MCP App topology, but the managed
  // example and README section must still render from the persisted state —
  // otherwise the re-render drops them and rewrites the files.
  const rerun = createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE });
  const envExample = rerun.operations.find((operation) =>
    operation.path.endsWith(".tama.env.example"),
  );
  assert.equal(envExample?.action, "unchanged");
  const readme = rerun.operations.find((operation) => operation.path.endsWith("README.md"));
  assert.equal(readme?.action, "unchanged");
});

test("ordinary reruns reject drift in persisted MCP App environment variables", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);
  const filename = join(root, "tama", ".tama.env");
  const original = readFileSync(filename, "utf8");
  const drifts = [
    ["TAMA_MCP_APP_RESOURCE", "http://127.0.0.1:4001/mcp/app?drifted=true"],
    ["TAMA_MCP_APP_AUTHORIZATION_SERVER", "http://host.docker.internal:4000/wrong"],
    ["TAMA_MCP_APP_JWKS_URI", "http://host.docker.internal:4000/wrong"],
    ["TAMA_MCP_APP_INTROSPECTION_ENDPOINT", "http://host.docker.internal:4000/wrong"],
    ["TAMA_MCP_APP_SIGNING_ALGORITHMS", "RS256,HS256"],
    ["TAMA_MCP_APP_ALLOWED_ORIGINS", "http://127.0.0.1:3000,http://example.test"],
    ["TAMA_MCP_APP_INTROSPECTION_CLIENT_ID", "drifted-client"],
    ["TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM", "HS256"],
    ["TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS", "not-json"],
    ["TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY", "not-json"],
  ];

  for (const [name, value] of drifts) {
    const drifted = original.replace(new RegExp(`^${name}=.*$`, "mu"), `${name}=${value}`);
    assert.notEqual(drifted, original, `${name} must exist in the generated environment`);
    writeFileSync(filename, drifted);
    assert.throws(
      () => createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.OWNERSHIP &&
        error.message.includes(name),
      `${name} drift must fail closed`,
    );
  }
  writeFileSync(filename, original);
  assert.doesNotThrow(() =>
    createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
  );
});

test("an ordinary rerun selects the pinned MCP App image", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);

  const rerun = createBootstrapPlan({ cwd: root, targetPath: root });
  assert.equal(rerun.tamaImage, PINNED_TAMA_IMAGE);
  assert.match(
    readFileSync(join(root, "tama", "compose.yaml"), "utf8"),
    new RegExp(PINNED_TAMA_IMAGE.replaceAll(".", "\\."), "u"),
  );
  assert.doesNotThrow(() =>
    createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
  );
});

test("ordinary reruns enforce the persisted provider Tama version range", () => {
  const root = project();
  const contract = validContract();
  contract.supported_tama_versions = ">= 0.13.3 and < 0.14.0";
  const contractPath = writeContract(root, contract);
  const first = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: "ghcr.io/upmaru/tama:0.13.3-server",
    port: 4001,
    mcpApp: {
      requested: true,
      activate: false,
      allowedOrigins: ["http://127.0.0.1:3000"],
    },
    mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
  });
  applyOperations(first.operations);

  assert.throws(
    () => createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /outside the supported Tama range >= 0\.13\.3 and < 0\.14\.0/u.test(error.message) &&
      /persisted provider contract/u.test(error.message),
  );
});

test("project-local provider contract paths remain valid after the project moves", async () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  applyOperations(first.operations);

  const persisted = JSON.parse(readFileSync(join(root, "tama", ".tama-kit.json"), "utf8"));
  assert.equal(
    persisted.mcpAppProvider.contractPath,
    "priv/contracts/tama-mcp-app-bootstrap-v1.json",
  );

  const movedRoot = `${root}-moved`;
  renameSync(root, movedRoot);
  assert.doesNotThrow(() =>
    createBootstrapPlan({ cwd: movedRoot, targetPath: movedRoot, image: PINNED_TAMA_IMAGE }),
  );
  const preparedAfterMove = await prepareFor(movedRoot);
  assert.equal(
    preparedAfterMove.contractPath,
    join(movedRoot, "priv", "contracts", "tama-mcp-app-bootstrap-v1.json"),
  );
});

test("provider fragment paths that collide with managed files are rejected", () => {
  for (const environmentFile of [
    "tama/.tama.env",
    "tama/.tama.env.example",
    "tama/.tama.postgres.env",
    "tama/.gitignore",
    "tama/AGENTS.md",
    "tama/README.md",
    "tama/compose.yaml",
    "tama/.tama-kit.json",
    "tama/contracts/provider.env",
    "tama/main.tf",
    "tama/main.tf.json",
    "tama/terraform.tfvars",
    "tama/.terraform.lock.hcl",
  ]) {
    const document = structuredClone(memoveeContract());
    document.provider.environment_file = environmentFile;
    document.environment_loading.loads = environmentFile;
    assert.throws(
      () => validateMcpAppContract(document),
      (error) =>
        error instanceof CLIError && /collides with a bootstrap-managed/u.test(error.message),
    );
  }
});

test("provider fragment paths outside the Tama directory are rejected", () => {
  for (const environmentFile of [
    ".provider.integration.env",
    ".envrc",
    "config/provider.env",
    ".agents/skills/graph-builder",
  ]) {
    const document = structuredClone(memoveeContract());
    document.provider.environment_file = environmentFile;
    document.environment_loading.loads = environmentFile;
    assert.throws(
      () => validateMcpAppContract(document),
      (error) =>
        error instanceof CLIError && /must be inside the Tama directory/u.test(error.message),
    );
  }
});

test("bootstrap rejects a provider fragment matching a custom selected Compose file", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", "custom-stack.yaml"), "services: {}\n");
  assert.throws(
    () =>
      createBootstrapPlan({
        cwd: root,
        targetPath: root,
        composePath: "tama/custom-stack.yaml",
        image: PINNED_TAMA_IMAGE,
        port: 4001,
        mcpApp: {
          requested: true,
          activate: false,
          providerOrigin: "http://host.docker.internal:4000",
          allowedOrigins: ["http://127.0.0.1:3000"],
        },
        mcpAppPrepared: preparedFor(root, {
          identity: {
            name: "acme",
            environmentPrefix: "ACME",
            environmentFile: "tama/custom-stack.yaml",
            source: "flags",
          },
        }),
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /collides with the selected Compose file/u.test(error.message),
  );
});

test("resolveProviderIdentity rejects reserved and unsafe provider fragment paths", () => {
  const root = project();
  for (const [environmentFile, pattern] of [
    [".tama.env", /must be inside the Tama directory/u],
    ["tama/compose.yaml", /collides with a bootstrap-managed/u],
    ["../evil.env", /safe project-relative path/u],
    ["/etc/passwd", /safe project-relative path/u],
    ["", /non-empty control-free string|safe project-relative path/u],
  ]) {
    // Explicit flag.
    assert.throws(
      () =>
        resolveProviderIdentity({
          root,
          framework: "generic",
          manifestProvider: null,
          contractDocument: null,
          name: "acme",
          environmentFile,
        }),
      (error) => error instanceof CLIError && pattern.test(error.message),
    );
    // Persisted manifest state (the production rerun path).
    assert.throws(
      () =>
        resolveProviderIdentity({
          root,
          framework: "generic",
          manifestProvider: { ...MEMOVEE, source: "manifest", environmentFile },
          contractDocument: null,
        }),
      (error) => error instanceof CLIError && pattern.test(error.message),
    );
  }
  const identity = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: null,
    contractDocument: null,
    name: "acme",
  });
  assert.equal(identity.environmentFile, "tama/.acme.integration.env");
});

test("bootstrap fails closed when a persisted provider fragment path no longer matches", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  // The manifest is disk-resident trusted state: a tampered fragment path
  // must fail closed instead of overwriting a bootstrap-managed file. In the
  // production path resolveProviderIdentity re-validates the persisted path;
  // here the plan-level mismatch guard catches the divergence first.
  const manifestPath = join(root, "tama", ".tama-kit.json");
  const manifest = /** @type {Record<string, any>} */ (
    JSON.parse(readFileSync(manifestPath, "utf8"))
  );
  manifest.mcpAppProvider.environmentFile = "tama/.tama.env";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError && /does not match the resolved identity/u.test(error.message),
  );
});

test("bootstrap rejects a tracked provider fragment even on ordinary reruns", () => {
  const root = project();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);

  // The fragment holds the provider's private signing key: force-adding it to
  // the index must fail every subsequent plan, not only --mcp-app runs.
  execFileSync("git", ["add", "--force", "tama/.memovee.integration.env"], { cwd: root });
  assert.throws(
    () => createBootstrapPlan({ cwd: root, targetPath: root }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("tama/.memovee.integration.env") &&
      error.details.paths.includes("tama/.memovee.integration.env"),
  );
});

test("the bootstrap command plans the provider integration from explicit flags", async () => {
  const root = project();
  const { exitCode, stdout } = await command(root, [
    "bootstrap",
    root,
    "--json",
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--provider-name",
    "acme",
    "--provider-origin",
    "http://host.docker.internal:5000",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.provider, {
    name: "acme",
    environmentPrefix: "ACME",
    environmentFile: "tama/.acme.integration.env",
    identitySource: "flags",
    contractPath: null,
    mode: "prepared",
    modeVariable: "ACME_TAMA_MCP_APP_MODE",
    environmentLoading: "unverified",
  });
  assert.equal(result.mcpApp.mode, "prepared");
  assert.equal(result.mcpApp.activated, false);
  assert.equal(result.mcpApp.providerOrigin, "http://host.docker.internal:5000");
  assert.equal(result.mcpApp.tamaOrigin, "http://127.0.0.1:4001");
  assert.equal(result.mcpApp.resource, "http://127.0.0.1:4001/mcp/app");
  assert.equal(result.mcpApp.introspectionClientId, "http://127.0.0.1:4001/mcp/app/introspection");
  assert.deepEqual(result.providerContract, {
    path: "tama/contracts/mcp-app-provider-v1.json",
    source: "generated",
    sourcePath: null,
    bindingSource: "conventional",
    compatibilityIdentifier: "tama-mcp-app-bootstrap-v1",
    environmentLoading: "unverified",
    environmentLoadingMechanism: null,
    environmentLoadingEvidencePath: null,
    action: "create",
  });
  assert.ok(
    result.changes.some((change) => change.path.endsWith("tama/.acme.integration.env")),
    "the provider fragment should be part of the planned changes",
  );
});

test("the human bootstrap result warns when provider environment loading is unverified", async () => {
  const root = project();
  const { exitCode, stdout } = await command(root, [
    "bootstrap",
    root,
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--provider-name",
    "acme",
    "--provider-origin",
    "http://host.docker.internal:5000",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.match(stdout, /MCP App local contract:/u);
  assert.match(stdout, /tama\/contracts\/mcp-app-provider-v1\.json \(create\)/u);
  assert.match(stdout, /Source:\s+generated/u);
  assert.match(stdout, /Bindings:\s+conventional/u);
  assert.match(stdout, /Provider environment loading is not verified:/u);
  assert.match(stdout, /load tama\/\.acme\.integration\.env before starting or restarting it/u);
});

test("the bootstrap command accepts --provider-env-file for the provider fragment", async () => {
  const root = project();
  const { exitCode, stdout } = await command(root, [
    "bootstrap",
    root,
    "--json",
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--provider-name",
    "acme",
    "--provider-env-file",
    "tama/.acme.custom.env",
    "--provider-origin",
    "http://host.docker.internal:5000",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.provider.environmentFile, "tama/.acme.custom.env");
  assert.ok(
    result.changes.some((change) => change.path.endsWith(".acme.custom.env")),
    "the custom fragment should be part of the planned changes",
  );

  // The flag is MCP App-only, like the rest of the provider identity flags.
  const rejected = await command(root, [
    "bootstrap",
    root,
    "--dry-run",
    "--skills",
    "manual",
    "--provider-env-file",
    "tama/.acme.custom.env",
  ]);
  assert.equal(rejected.exitCode, EXIT_CODES.USAGE);
  assert.match(rejected.stderr, /require --mcp-app/u);

  // A flag fragment path colliding with a bootstrap-managed file is rejected
  // before planning, exactly like the contract-declared one.
  const reserved = await command(root, [
    "bootstrap",
    root,
    "--json",
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--provider-name",
    "acme",
    "--provider-env-file",
    "tama/.tama.env",
    "--provider-origin",
    "http://host.docker.internal:5000",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);
  assert.equal(reserved.exitCode, EXIT_CODES.USAGE);
  const reservedError = /** @type {{error: {message: string}}} */ (JSON.parse(reserved.stdout));
  assert.match(reservedError.error.message, /collides with a bootstrap-managed/u);
});

test("MCP App JSON dry-runs are byte-for-byte deterministic and write no secrets", async () => {
  const root = project();
  const args = [
    "bootstrap",
    root,
    "--json",
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--provider-name",
    "acme",
    "--provider-origin",
    "http://host.docker.internal:5000",
    "--tama-origin",
    "http://127.0.0.1:4001",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ];
  const first = await command(root, args);
  const second = await command(root, args);
  assert.equal(first.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(second.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(second.stdout, first.stdout);
  assert.equal(existsSync(join(root, "tama", ".tama.env")), false);
  assert.equal(existsSync(join(root, "tama", ".acme.integration.env")), false);
  assert.equal(existsSync(join(root, "tama", "contracts", "mcp-app-provider-v1.json")), false);
  assert.doesNotMatch(first.stdout, /"d"\s*:|PRIVATE KEY|pending-secret-material/u);
});

test("the bootstrap command discovers the contract identity for --mcp-app", async () => {
  const root = project();
  const contractPath = writeContract(root);
  const { exitCode, stdout } = await command(root, [
    "bootstrap",
    root,
    "--json",
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
    "--port",
    "4001",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.provider, {
    name: "memovee",
    environmentPrefix: "MEMOVEE",
    environmentFile: "tama/.memovee.integration.env",
    identitySource: "contract",
    contractPath,
    mode: "prepared",
    modeVariable: "MEMOVEE_TAMA_MCP_APP_MODE",
    environmentLoading: "unverified",
  });
  assert.equal(result.providerContract.source, "provider-contract");
  assert.equal(result.providerContract.sourcePath, "priv/contracts/tama-mcp-app-bootstrap-v1.json");
  assert.equal(result.mcpApp.providerOrigin, "http://host.docker.internal:4000");
  assert.ok(result.changes.some((change) => change.path.endsWith("tama/.memovee.integration.env")));
});

test("the bootstrap command fails closed on a detected identity in non-interactive mode", async () => {
  const root = project();
  const { exitCode, stderr } = await command(root, [
    "bootstrap",
    root,
    "--dry-run",
    "--skills",
    "manual",
    "--mcp-app",
  ]);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  assert.match(stderr, /detected as/u);
  assert.match(stderr, /--provider-name/u);
});

test("the bootstrap command gates provider flags behind --mcp-app and --start behind --activate", async () => {
  const root = project();
  const gated = await command(root, [
    "bootstrap",
    root,
    "--provider-origin",
    "http://host.docker.internal:5000",
  ]);
  assert.equal(gated.exitCode, EXIT_CODES.USAGE);
  assert.match(gated.stderr, /require --mcp-app/u);

  const activate = await command(root, ["bootstrap", root, "--mcp-app", "--activate"]);
  assert.equal(activate.exitCode, EXIT_CODES.USAGE);
  assert.match(activate.stderr, /--activate requires --start/u);

  const migration = await command(root, [
    "bootstrap",
    root,
    "--mcp-app",
    "--migrate-provider-identity",
  ]);
  assert.equal(migration.exitCode, EXIT_CODES.USAGE);
  assert.match(migration.stderr, /--provider-name/u);
});
