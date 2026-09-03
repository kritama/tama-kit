import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { resolveEnvironmentPort } from "../../cli/bootstrap/environment.mjs";
import { readMcpAppProvider } from "../../cli/bootstrap/manifest.mjs";
import { prepareMcpApp } from "../../cli/bootstrap/mcp-app.mjs";
import {
  contractLocalOrigin,
  contractTamaPort,
  discoverProviderContract,
  loadTamaContract,
  resolveBindings,
  unsupportedTamaImage,
  validateMcpAppContract,
  verifyEnvironmentLoading,
} from "../../cli/bootstrap/mcp-app-contract.mjs";
import { verifyMcpApp } from "../../cli/bootstrap/mcp-app-verify.mjs";
import { generateOAuthKeyPair } from "../../cli/bootstrap/oauth-key.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import {
  environmentFileForName,
  normalizeEnvironmentPrefix,
  normalizeProviderName,
  prefixFromName,
  resolveProviderIdentity,
} from "../../cli/bootstrap/provider-identity.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/bootstrap/write.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function command(root, args) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(args, {
    cwd: root,
    interactive: false,
    color: false,
    columns: 100,
    write: () => {},
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function project(prefix = "tama-kit-mcp-app-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function memoveeContract(overrides = {}) {
  const bindings = {
    mode: "MEMOVEE_TAMA_MCP_APP_MODE",
    issuer: "MEMOVEE_OAUTH_ISSUER",
    resource: "MEMOVEE_TAMA_MCP_APP_RESOURCE",
    access_token_signing_algorithm: "MEMOVEE_OAUTH_SIGNING_ALGORITHM",
    access_token_signing_key_id: "MEMOVEE_OAUTH_SIGNING_KEY_ID",
    access_token_private_signing_key: "MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY",
    access_token_public_overlap_keys: "MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS",
    introspection_client_id: "MEMOVEE_TAMA_INTROSPECTION_CLIENT_ID",
    introspection_jwks_uri: "MEMOVEE_TAMA_INTROSPECTION_JWKS_URI",
  };
  return {
    schema_version: "1",
    compatibility_identifier: "tama-mcp-app-bootstrap-v1",
    supported_memovee_versions: ">= 0.1.1 and < 0.2.0",
    lifecycle: {
      default_production_mode: "disabled",
      modes: ["disabled", "prepared", "enabled"],
      configured_modes: ["prepared", "enabled"],
      enabled_modes: ["enabled"],
    },
    provider: {
      name: "memovee",
      environment_prefix: "MEMOVEE",
      environment_file: ".memovee.integration.env",
    },
    bindings,
    environment_loading: {
      mechanism: "direnv",
      loader: ".envrc",
      loads: ".memovee.integration.env",
    },
    variables: {
      [bindings.mode]: {
        required: false,
        values: ["disabled", "prepared", "enabled"],
        "x-sensitive": false,
      },
      [bindings.issuer]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-origin",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.resource]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-uri",
        exact_path: "/mcp/app",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.access_token_signing_algorithm]: {
        required_in: ["prepared", "enabled"],
        initial_value: "RS256",
        allowed_values: ["RS256", "PS256", "ES256"],
        "x-sensitive": false,
      },
      [bindings.access_token_signing_key_id]: {
        required_in: ["prepared", "enabled"],
        format: "bounded-identifier",
        max_bytes: 128,
        "x-sensitive": false,
      },
      [bindings.access_token_private_signing_key]: {
        required_in: ["prepared", "enabled"],
        format: "private-json-jwk",
        max_bytes: 65536,
        "x-sensitive": true,
      },
      [bindings.access_token_public_overlap_keys]: {
        required: false,
        default: "[]",
        format: "public-json-jwk-array",
        max_bytes: 2097152,
        max_items: 30,
        "x-sensitive": false,
      },
      [bindings.introspection_client_id]: {
        required_in: ["prepared", "enabled"],
        format: "bounded-identifier",
        max_bytes: 2048,
        "x-sensitive": false,
      },
      [bindings.introspection_jwks_uri]: {
        required_in: ["prepared", "enabled"],
        format: "absolute-uri",
        exact_path: "/.well-known/jwks.json",
        same_origin_as: bindings.resource,
        max_bytes: 2048,
        "x-sensitive": false,
      },
    },
    public_endpoints: {
      authorization_server_metadata: "/.well-known/oauth-authorization-server",
      jwks: "/.well-known/jwks.json",
      introspection: "/auth/introspections",
    },
    availability: {
      disabled: { metadata: false, jwks: false, introspection: false },
      prepared: { metadata: true, jwks: true, introspection: true },
      enabled: { metadata: true, jwks: true, introspection: true },
    },
    local_development: {
      memovee_origin: "http://host.docker.internal:4000",
      tama_origin: "http://127.0.0.1:4001",
      resource: "http://127.0.0.1:4001/mcp/app",
    },
    local_loopback: {
      allowed_environments: ["dev", "test"],
      hosts: ["127.0.0.1", "localhost", "::1"],
    },
    ...overrides,
  };
}

/** @returns {Record<string, unknown>} */
function validContract() {
  return validateMcpAppContract(memoveeContract());
}

function writeContract(root, document = memoveeContract()) {
  const directory = join(root, "priv", "contracts");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "tama-mcp-app-bootstrap-v1.json");
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

const MEMOVEE = {
  name: "memovee",
  environmentPrefix: "MEMOVEE",
  environmentFile: ".memovee.integration.env",
};

/**
 * @param {string} root
 * @param {{
 *   contractPath?: string | null,
 *   contractDocument?: Record<string, unknown> | null,
 *   identity?: {
 *     name: string,
 *     environmentPrefix: string,
 *     environmentFile: string,
 *     source: "manifest" | "contract" | "flags" | "framework" | "git" | "directory",
 *   },
 * }} [extra]
 */
function preparedFor(root, extra = {}) {
  return {
    identity: extra.identity ?? { ...MEMOVEE, source: "flags" },
    persisted: readMcpAppProvider(join(root, "tama")),
    contractPath: extra.contractPath ?? null,
    contractDocument: extra.contractDocument ?? null,
    allowedOrigins: ["http://127.0.0.1:3000"],
  };
}

// The MCP App integration requires a pinned Tama image, so every planned
// integration in the suite uses one inside the bundled supported range.
const PINNED_TAMA_IMAGE = "ghcr.io/upmaru/tama:0.13.1";

/**
 * @param {string} root
 * @param {ReturnType<typeof preparedFor>} prepared
 * @param {Record<string, unknown>} [mcpApp]
 */
function planWithMcp(root, prepared, mcpApp = {}) {
  return createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: PINNED_TAMA_IMAGE,
    port: existsSync(join(root, ".tama.env")) ? undefined : 4001,
    mcpApp: {
      requested: true,
      activate: false,
      allowedOrigins: prepared.allowedOrigins,
      ...mcpApp,
    },
    mcpAppPrepared: prepared,
  });
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} [options]
 * @param {{nonInteractive?: boolean, prompt?: (question: string) => Promise<string>}} [io]
 */
async function prepareFor(root, options = {}, io = {}) {
  return prepareMcpApp({
    root,
    tamaDirectory: join(root, "tama"),
    framework: "generic",
    options: {
      requested: true,
      activate: false,
      allowedOrigins: ["http://127.0.0.1:3000"],
      ...options,
    },
    nonInteractive: io.nonInteractive ?? false,
    io: { prompt: io.prompt ?? (async () => ""), stderr: () => {} },
  });
}

test("discoverProviderContract scans priv/contracts and fails on ambiguity", () => {
  const root = project();
  assert.deepEqual(discoverProviderContract(root, undefined), { path: null, document: null });

  const contractPath = writeContract(root);
  writeFileSync(join(root, "priv", "contracts", "notes.json"), "not json");
  const discovered = discoverProviderContract(root, undefined);
  assert.equal(discovered.path, contractPath);
  assert.equal(discovered.document?.compatibility_identifier, "tama-mcp-app-bootstrap-v1");

  writeFileSync(join(root, "priv", "contracts", "second.json"), JSON.stringify(memoveeContract()));
  assert.throws(
    () => discoverProviderContract(root, undefined),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /--mcp-app-contract/u.test(error.message),
  );

  const explicit = discoverProviderContract(root, contractPath);
  assert.equal(explicit.path, contractPath);

  assert.throws(
    () => discoverProviderContract(root, join(root, "priv", "contracts", "missing.json")),
    (error) => error instanceof CLIError && /does not exist/u.test(error.message),
  );
});

test("validateMcpAppContract enforces the bootstrap schema", () => {
  assert.throws(
    () =>
      validateMcpAppContract({
        schema_version: "2",
        compatibility_identifier: "tama-mcp-app-bootstrap-v1",
        lifecycle: { modes: ["disabled", "prepared", "enabled"] },
      }),
    /schema_version/u,
  );
  assert.throws(
    () =>
      validateMcpAppContract({
        schema_version: "1",
        compatibility_identifier: "nope",
        lifecycle: { modes: ["disabled", "prepared", "enabled"] },
      }),
    /compatibility_identifier/u,
  );
  assert.throws(
    () =>
      validateMcpAppContract({
        schema_version: "1",
        compatibility_identifier: "tama-mcp-app-bootstrap-v1",
        lifecycle: { modes: ["disabled"] },
      }),
    /lifecycle\.modes/u,
  );
  assert.throws(() => validateMcpAppContract("nope"), /JSON object/u);
  assert.equal(validContract().schema_version, "1");
});

test("validateMcpAppContract cross-checks bindings against the declared variables", () => {
  const base = memoveeContract();
  const bindings = base.bindings;
  assert.throws(
    () =>
      validateMcpAppContract(
        memoveeContract({
          bindings: { ...bindings, issuer: "MEMOVEE_UNDECLARED_ISSUER" },
        }),
      ),
    (error) =>
      error instanceof CLIError &&
      /binding "issuer" references undeclared variable MEMOVEE_UNDECLARED_ISSUER/u.test(
        error.message,
      ),
  );
  const withVariables = (variable) =>
    validateMcpAppContract(
      memoveeContract({
        variables: {
          ...base.variables,
          [variable.name]: { ...variable.current, ...variable.next },
        },
      }),
    );
  assert.throws(
    () =>
      withVariables({
        name: bindings.mode,
        current: base.variables[bindings.mode],
        next: { values: ["prepared"] },
      }),
    /must include the lifecycle modes/u,
  );
  assert.throws(
    () =>
      withVariables({
        name: bindings.access_token_signing_algorithm,
        current: base.variables[bindings.access_token_signing_algorithm],
        next: { allowed_values: ["ES256"] },
      }),
    /must accept RS256/u,
  );
  assert.doesNotThrow(() => validateMcpAppContract(base));
});

test("validateMcpAppContract rejects malformed v1 contract sections", () => {
  const mutations = [
    (contract) => delete contract.lifecycle.default_production_mode,
    (contract) => {
      contract.lifecycle.enabled_modes = ["unknown"];
    },
    (contract) => delete contract.variables,
    (contract) => {
      contract.variables.MEMOVEE_OAUTH_ISSUER.required = true;
    },
    (contract) => {
      contract.variables.MEMOVEE_OAUTH_ISSUER.format = "shell-script";
    },
    (contract) => {
      contract.variables.MEMOVEE_TAMA_MCP_APP_RESOURCE.exact_path = "mcp/app";
    },
    (contract) => {
      contract.variables.MEMOVEE_TAMA_INTROSPECTION_JWKS_URI.same_origin_as = "MISSING";
    },
    (contract) => {
      contract.public_endpoints.jwks = "https://example.test/jwks";
    },
    (contract) => delete contract.availability.prepared,
    (contract) => {
      contract.local_development.memovee_origin = "ftp://127.0.0.1:4000";
    },
    (contract) => {
      contract.provider.environment_file = "../escape.env";
    },
    (contract) => {
      contract.environment_loading.loads = ".different.env";
    },
    (contract) => {
      contract.bindings.issuer = contract.bindings.mode;
    },
    (contract) => {
      contract.supported_memovee_versions = 1;
    },
    (contract) => {
      contract.unexpected = true;
    },
  ];
  for (const mutate of mutations) {
    const contract = structuredClone(memoveeContract());
    mutate(contract);
    assert.throws(() => validateMcpAppContract(contract));
  }
});

test("provider contract reads are bounded", () => {
  const root = project();
  const directory = join(root, "priv", "contracts");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "oversized.json");
  writeFileSync(path, " ".repeat(256 * 1024 + 1));
  assert.deepEqual(discoverProviderContract(root, undefined), { path: null, document: null });
  assert.throws(() => discoverProviderContract(root, path), /too large/u);
});

test("resolveBindings prefers contract bindings over the conventional table", () => {
  const conventional = resolveBindings(null, "ACME");
  assert.equal(conventional.source, "conventional");
  assert.equal(conventional.roles.issuer, "ACME_OAUTH_ISSUER");
  assert.equal(conventional.roles.introspection_jwks_uri, "ACME_TAMA_INTROSPECTION_JWKS_URI");

  const contract = resolveBindings(validContract(), "MEMOVEE");
  assert.equal(contract.source, "contract");
  assert.equal(contract.roles.mode, "MEMOVEE_TAMA_MCP_APP_MODE");

  const missing = memoveeContract();
  delete missing.bindings.issuer;
  assert.throws(() => resolveBindings(missing, "MEMOVEE"), /issuer/u);
});

test("verifyEnvironmentLoading confirms application-owned loaders", () => {
  const root = project();
  assert.equal(verifyEnvironmentLoading(root, ".acme.integration.env", null), "unverified");
  writeFileSync(join(root, ".envrc"), 'dotenv_load ".acme.integration.env"\n');
  assert.equal(verifyEnvironmentLoading(root, ".acme.integration.env", null), "verified");

  const composeRoot = project();
  writeFileSync(
    join(composeRoot, "compose.yaml"),
    "services:\n  app:\n    env_file:\n      - .acme.integration.env\n",
  );
  assert.equal(verifyEnvironmentLoading(composeRoot, ".acme.integration.env", null), "verified");
  assert.equal(
    verifyEnvironmentLoading(composeRoot, ".acme.integration.env", {
      environment_loading: { mechanism: "direnv" },
    }),
    "verified",
  );

  const unquotedRoot = project();
  writeFileSync(join(unquotedRoot, ".envrc"), "dotenv .acme.integration.env\n");
  assert.equal(verifyEnvironmentLoading(unquotedRoot, ".acme.integration.env", null), "verified");

  // A bare textual occurrence is not an active loader: a comment or an
  // unrelated command naming the fragment must not verify it, because
  // migration deletes the fragment this check exists to protect.
  const commentRoot = project();
  writeFileSync(
    join(commentRoot, ".envrc"),
    ['# dotenv_load ".acme.integration.env"', 'echo ".acme.integration.env"', ""].join("\n"),
  );
  assert.equal(verifyEnvironmentLoading(commentRoot, ".acme.integration.env", null), "unverified");

  const composeCommentRoot = project();
  writeFileSync(
    join(composeCommentRoot, "compose.yaml"),
    ["services:", "  app:", "    # env_file:", "    #   - .acme.integration.env", ""].join("\n"),
  );
  assert.equal(
    verifyEnvironmentLoading(composeCommentRoot, ".acme.integration.env", null),
    "unverified",
  );

  // A textual mention that is not an env_file entry (command, label, volume)
  // does not load the fragment.
  const decoyRoot = project();
  writeFileSync(
    join(decoyRoot, "compose.yaml"),
    [
      "services:",
      "  app:",
      "    command:",
      "      - cat",
      "      - .acme.integration.env",
      "    labels:",
      "      fragment: .acme.integration.env",
      "    volumes:",
      "      - .acme.integration.env:/frag.env:ro",
      "",
    ].join("\n"),
  );
  assert.equal(verifyEnvironmentLoading(decoyRoot, ".acme.integration.env", null), "unverified");

  const inlineEnvFileRoot = project();
  writeFileSync(
    join(inlineEnvFileRoot, "compose.yaml"),
    "services:\n  app:\n    env_file: .acme.integration.env\n",
  );
  assert.equal(
    verifyEnvironmentLoading(inlineEnvFileRoot, ".acme.integration.env", null),
    "verified",
  );
});

test("contractLocalOrigin reads the provider-keyed local development origin", () => {
  const contract = memoveeContract();
  assert.equal(contractLocalOrigin(contract, "memovee"), "http://host.docker.internal:4000");
  assert.equal(contractLocalOrigin(contract, "acme"), null);
  assert.equal(contractLocalOrigin(null, "memovee"), null);
});

test("unsupportedTamaImage checks semver tags against the contract range", () => {
  const range = loadTamaContract().supported_tama_versions;
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:latest", range), null);
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1", range), null);
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.5", range), null);
  assert.match(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.0", range) ?? "", /0\.13\.0/u);
  assert.match(unsupportedTamaImage("ghcr.io/upmaru/tama:0.12.0", range) ?? "", /0\.12\.0/u);
  assert.match(unsupportedTamaImage("ghcr.io/upmaru/tama:0.14.0", range) ?? "", /0\.14\.0/u);
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1-rc.1", range) ?? "",
    /prerelease or build tag/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1+build.5", range) ?? "",
    /prerelease or build tag/u,
  );
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1", null), null);
});

test("provider identity normalization derives the prefix and fragment file", () => {
  assert.equal(normalizeProviderName("My__Service  "), "my-service");
  assert.equal(prefixFromName("my-service"), "MY_SERVICE");
  assert.equal(environmentFileForName("my-service"), ".my-service.integration.env");
  assert.throws(() => normalizeProviderName("123"), /begin with a letter/u);
});

test("provider environment prefixes are conservatively bounded and avoid reserved domains", () => {
  assert.equal(normalizeEnvironmentPrefix("my provider"), "MY_PROVIDER");
  assert.throws(() => normalizeEnvironmentPrefix("abcdefghijklmnopqrstuvwxy"), /not valid/u);
  for (const reserved of ["TAMA", "TAMA_MCP", "POSTGRES", "DATABASE"]) {
    assert.throws(() => normalizeEnvironmentPrefix(reserved), /reserved/u);
  }
});

test("resolveProviderIdentity applies manifest, contract, flag, and detection precedence", () => {
  const root = project();
  const contract = validContract();
  const manifest = {
    name: "kept",
    environmentPrefix: "KEPT",
    environmentFile: ".kept.integration.env",
    source: "manifest",
  };
  const fromManifest = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: manifest,
    contractDocument: contract,
    name: "flagged",
    prefix: "FLAGGED",
    environmentFile: ".flagged.integration.env",
  });
  assert.deepEqual(fromManifest, {
    name: "kept",
    environmentPrefix: "KEPT",
    environmentFile: ".kept.integration.env",
    source: "manifest",
  });

  const fromContract = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: null,
    contractDocument: contract,
    name: "flagged",
    prefix: "FLAGGED",
    environmentFile: ".flagged.integration.env",
  });
  assert.equal(fromContract.name, "memovee");
  assert.equal(fromContract.source, "contract");
  assert.equal(fromContract.environmentPrefix, "MEMOVEE");

  const fromFlags = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: null,
    contractDocument: null,
    name: "My Service",
    prefix: undefined,
    environmentFile: undefined,
  });
  assert.deepEqual(fromFlags, {
    name: "my-service",
    environmentPrefix: "MY_SERVICE",
    environmentFile: ".my-service.integration.env",
    source: "flags",
  });

  assert.throws(
    () =>
      resolveProviderIdentity({
        root,
        framework: "generic",
        manifestProvider: null,
        contractDocument: null,
        name: undefined,
        prefix: "ACME",
        environmentFile: undefined,
      }),
    /--provider-name is required/u,
  );

  const detected = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: null,
    contractDocument: null,
    name: undefined,
    prefix: undefined,
    environmentFile: undefined,
  });
  assert.equal(detected.source, "directory");
  assert.equal(detected.name, normalizeProviderName(basename(root)));
});

test("prepareMcpApp fails non-interactive runs on a detected identity", async () => {
  const root = project();
  await assert.rejects(
    prepareFor(root, {}, { nonInteractive: true }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /detected as/u.test(error.message),
  );
});

test("prepareMcpApp confirms a detected identity interactively", async () => {
  const root = project();

  const prompts = [];
  const prepared = await prepareFor(
    root,
    {},
    {
      nonInteractive: false,
      prompt: async (question) => {
        prompts.push(question);
        return "y";
      },
    },
  );
  assert.equal(prepared.identity.source, "directory");
  assert.match(prompts[0] ?? "", /Use detected provider name/u);
});

test("prepareMcpApp accepts a custom name when the detection is rejected", async () => {
  const root = project();
  let calls = 0;
  const prepared = await prepareFor(
    root,
    {},
    {
      nonInteractive: false,
      prompt: async () => {
        calls += 1;
        return calls === 1 ? "n" : "custom provider";
      },
    },
  );
  assert.deepEqual(prepared.identity, {
    name: "custom-provider",
    environmentPrefix: "CUSTOM_PROVIDER",
    environmentFile: ".custom-provider.integration.env",
    source: "flags",
  });
});

test("prepareMcpApp resolves contract and flag identities without prompting", async () => {
  const contractRoot = project();
  const contractPath = writeContract(contractRoot);
  let prompted = false;
  const fromContract = await prepareFor(
    contractRoot,
    {},
    {
      nonInteractive: true,
      prompt: async () => {
        prompted = true;
        return "y";
      },
    },
  );
  assert.equal(fromContract.identity.name, "memovee");
  assert.equal(fromContract.identity.source, "contract");
  assert.equal(fromContract.contractPath, contractPath);
  assert.equal(prompted, false);

  const flagRoot = project();
  const fromFlags = await prepareFor(
    flagRoot,
    { providerName: "acme" },
    {
      nonInteractive: true,
      prompt: async () => {
        prompted = true;
        return "y";
      },
    },
  );
  assert.equal(fromFlags.identity.name, "acme");
  assert.equal(fromFlags.identity.source, "flags");
  assert.equal(fromFlags.contractPath, null);
  assert.equal(prompted, false);
});

test("prepareMcpApp trusts the manifest over later flags", async () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const prepared = await prepareFor(root, { providerName: "acme" }, { nonInteractive: true });
  assert.equal(prepared.identity.name, "memovee");
  assert.equal(prepared.identity.source, "manifest");
  assert.equal(prepared.persisted?.identity.name, "memovee");
});

test("bootstrap plans a complete MCP App provider integration from a discovered contract", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const plan = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  applyOperations(plan.operations);

  const mcp = plan.mcpApp;
  assert.ok(mcp);
  assert.equal(plan.framework, "generic");
  assert.equal(mcp.lifecycle, "prepared");
  assert.equal(mcp.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(mcp.tamaOrigin, "http://127.0.0.1:4001");
  assert.equal(mcp.resource, "http://127.0.0.1:4001/mcp/app");
  assert.equal(mcp.introspectionClientId, "http://127.0.0.1:4001/mcp/app/introspection");
  assert.deepEqual(mcp.allowedOrigins, ["http://127.0.0.1:3000"]);
  assert.equal(mcp.contractSource, "contract");
  assert.equal(mcp.bindings.source, "contract");
  assert.equal(mcp.environmentLoading, "verified");
  assert.ok(mcp.providerSigningKeyId.startsWith("mcp-app-provider-"));
  assert.ok(mcp.introspectionSigningKeyId.startsWith("mcp-app-tama-"));

  const fragmentPath = join(root, ".memovee.integration.env");
  const fragment = readFileSync(fragmentPath, "utf8");
  assert.match(fragment, /^# Generated by Tama Kit/mu);
  assert.equal(statSync(fragmentPath).mode & 0o777, 0o600);
  const fragmentValues = parseEnv(fragment);
  assert.equal(fragmentValues.MEMOVEE_TAMA_MCP_APP_MODE, "prepared");
  assert.equal(fragmentValues.MEMOVEE_OAUTH_ISSUER, "http://host.docker.internal:4000");
  assert.equal(fragmentValues.MEMOVEE_TAMA_MCP_APP_RESOURCE, "http://127.0.0.1:4001/mcp/app");
  assert.equal(fragmentValues.MEMOVEE_OAUTH_SIGNING_ALGORITHM, "RS256");
  assert.equal(fragmentValues.MEMOVEE_OAUTH_SIGNING_KEY_ID, mcp.providerSigningKeyId);
  assert.equal(fragmentValues.MEMOVEE_TAMA_INTROSPECTION_CLIENT_ID, mcp.introspectionClientId);
  assert.equal(
    fragmentValues.MEMOVEE_TAMA_INTROSPECTION_JWKS_URI,
    "http://127.0.0.1:4001/.well-known/jwks.json",
  );

  const providerJwk = JSON.parse(fragmentValues.MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY);
  assert.equal(providerJwk.kty, "RSA");
  assert.equal(providerJwk.kid, mcp.providerSigningKeyId);
  assert.equal(Buffer.from(providerJwk.n, "base64url").length, 384);

  assert.deepEqual(JSON.parse(fragmentValues.MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS), []);

  const tamaValues = parseEnv(readFileSync(join(root, ".tama.env"), "utf8"));
  assert.equal(tamaValues.TAMA_MCP_APP_MODE, "prepared");
  assert.equal(tamaValues.TAMA_MCP_APP_RESOURCE, "http://127.0.0.1:4001/mcp/app");
  assert.equal(tamaValues.TAMA_MCP_APP_ALLOWED_ORIGINS, "http://127.0.0.1:3000");
  assert.equal(tamaValues.TAMA_MCP_APP_AUTHORIZATION_SERVER, "http://host.docker.internal:4000");
  assert.equal(
    tamaValues.TAMA_MCP_APP_JWKS_URI,
    "http://host.docker.internal:4000/.well-known/jwks.json",
  );
  assert.equal(
    tamaValues.TAMA_MCP_APP_INTROSPECTION_ENDPOINT,
    "http://host.docker.internal:4000/auth/introspections",
  );
  assert.equal(tamaValues.TAMA_MCP_APP_SIGNING_ALGORITHMS, "RS256");
  assert.equal(tamaValues.TAMA_MCP_APP_INTROSPECTION_CLIENT_ID, mcp.introspectionClientId);
  assert.equal(tamaValues.TAMA_MCP_APP_INTROSPECTION_SIGNING_ALGORITHM, "RS256");
  assert.equal(tamaValues.TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID, mcp.introspectionSigningKeyId);

  const tamaJwk = JSON.parse(tamaValues.TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY);
  assert.equal(tamaJwk.kty, "RSA");
  assert.equal(tamaJwk.kid, mcp.introspectionSigningKeyId);
  assert.equal(Buffer.from(tamaJwk.n, "base64url").length, 384);
  assert.notEqual(tamaJwk.kid, mcp.providerSigningKeyId);
  assert.deepEqual(JSON.parse(tamaValues.TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS), []);

  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/\.tama\.env$/mu);
  assert.match(gitignore, /^\/\.memovee\.integration\.env$/mu);
  const manifest = JSON.parse(readFileSync(join(root, "tama", ".tama-kit.json"), "utf8"));
  assert.equal(manifest.mcpAppProvider.name, "memovee");
  assert.equal(manifest.mcpAppProvider.contractSource, "contract");
  assert.equal(manifest.mcpAppProvider.environmentLoading, "verified");
  assert.equal(manifest.mcpAppProvider.bindings.mode, "MEMOVEE_TAMA_MCP_APP_MODE");
  assert.equal(manifest.mcpAppProvider.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(manifest.mcpAppProvider.tamaOrigin, "http://127.0.0.1:4001");
  assert.deepEqual(manifest.mcpAppProvider.allowedOrigins, ["http://127.0.0.1:3000"]);
  const example = readFileSync(join(root, ".tama.env.example"), "utf8");
  assert.match(example, /TAMA_MCP_APP_RESOURCE=http:\/\/127\.0\.0\.1:4001\/mcp\/app/u);
  assert.doesNotMatch(example, /TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY=/u);
  const generatedReadme = readFileSync(join(root, "tama", "README.md"), "utf8");
  assert.match(generatedReadme, /MCP App provider integration/u);
  const discoveredCompose = readFileSync(join(root, "tama", "compose.yaml"), "utf8");
  assert.match(discoveredCompose, /host\.docker\.internal:host-gateway/u);

  const second = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  assert.equal(readFileSync(fragmentPath, "utf8"), fragment);
});

test("bootstrap activates the MCP App integration when requested", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const activated = planWithMcp(
    root,
    preparedFor(root, { contractPath, contractDocument: contract }),
    { activate: true },
  );
  assert.equal(activated.mcpApp?.lifecycle, "enabled");
  applyOperations(activated.operations);
  const fragment = parseEnv(readFileSync(join(root, ".memovee.integration.env"), "utf8"));
  assert.equal(fragment.MEMOVEE_TAMA_MCP_APP_MODE, "enabled");
  const tama = parseEnv(readFileSync(join(root, ".tama.env"), "utf8"));
  assert.equal(tama.TAMA_MCP_APP_MODE, "enabled");
});

test("bootstrap keeps provider endpoints on one shared origin and rejects loopback", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const plan = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(plan.operations);

  const mcp = plan.mcpApp;
  assert.ok(mcp);
  assert.equal(mcp.providerOrigin, "http://host.docker.internal:4000");
  const tama = parseEnv(readFileSync(join(root, ".tama.env"), "utf8"));
  assert.equal(tama.TAMA_MCP_APP_AUTHORIZATION_SERVER, "http://host.docker.internal:4000");
  assert.equal(
    tama.TAMA_MCP_APP_JWKS_URI,
    "http://host.docker.internal:4000/.well-known/jwks.json",
  );
  assert.equal(
    tama.TAMA_MCP_APP_INTROSPECTION_ENDPOINT,
    "http://host.docker.internal:4000/auth/introspections",
  );
  const compose = readFileSync(join(root, "tama", "compose.yaml"), "utf8");
  assert.match(compose, /host\.docker\.internal:host-gateway/u);

  for (const loopbackOrigin of [
    "http://127.0.0.1:4000",
    "http://127.1.2.3:4000",
    "http://localhost:4000",
    "http://[::1]:4000",
    "http://[::ffff:127.0.0.1]:4000",
  ]) {
    const loopbackRoot = project();
    const loopbackContractPath = writeContract(loopbackRoot);
    const loopbackContract = validContract();
    assert.throws(
      () =>
        planWithMcp(
          loopbackRoot,
          preparedFor(loopbackRoot, {
            contractPath: loopbackContractPath,
            contractDocument: loopbackContract,
          }),
          { providerOrigin: loopbackOrigin },
        ),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.USAGE &&
        /loopback and cannot be reached from the Tama container/u.test(error.message) &&
        /host\.docker\.internal/u.test(error.message),
    );
  }
});

test("bootstrap rejects unspecified provider bind addresses", () => {
  for (const providerOrigin of [
    "http://0.0.0.0:4000",
    "http://[::]:4000",
    "http://[::ffff:0.0.0.0]:4000",
  ]) {
    const root = project();
    const contractPath = writeContract(root);
    const contract = validContract();
    assert.throws(
      () =>
        planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
          providerOrigin,
        }),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.USAGE &&
        /unspecified address/u.test(error.message) &&
        /cannot be reached from the Tama container/u.test(error.message),
    );
  }
});

test("bootstrap requires a provider origin when no contract declares one", () => {
  const root = project();
  const prepared = preparedFor(root, {
    identity: {
      name: "acme",
      environmentPrefix: "ACME",
      environmentFile: ".acme.integration.env",
      source: "flags",
    },
  });
  assert.throws(
    () => planWithMcp(root, prepared),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /provider origin is required/u.test(error.message),
  );
});

test("bootstrap derives conventional bindings for providers without a contract", () => {
  const root = project();
  const prepared = preparedFor(root, {
    identity: {
      name: "acme",
      environmentPrefix: "ACME",
      environmentFile: ".acme.integration.env",
      source: "flags",
    },
  });
  const plan = planWithMcp(root, prepared, { providerOrigin: "http://host.docker.internal:5000" });
  applyOperations(plan.operations);

  const mcp = plan.mcpApp;
  assert.ok(mcp);
  assert.equal(mcp.contractSource, "conventional");
  assert.equal(mcp.contractPath, null);
  assert.equal(mcp.bindings.source, "conventional");
  assert.equal(mcp.bindings.roles.issuer, "ACME_OAUTH_ISSUER");
  assert.equal(mcp.environmentLoading, "unverified");
  const fragment = parseEnv(readFileSync(join(root, ".acme.integration.env"), "utf8"));
  assert.equal(fragment.ACME_TAMA_MCP_APP_MODE, "prepared");
  assert.equal(fragment.ACME_OAUTH_ISSUER, "http://host.docker.internal:5000");
  const manifest = JSON.parse(readFileSync(join(root, "tama", ".tama-kit.json"), "utf8"));
  assert.equal(manifest.mcpAppProvider.contractSource, "conventional");
  assert.equal(manifest.mcpAppProvider.contractPath, null);
});

test("bootstrap rejects Tama image tags outside the supported contract range", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  assert.throws(
    () =>
      createBootstrapPlan({
        cwd: root,
        targetPath: root,
        image: "ghcr.io/upmaru/tama:0.12.0",
        mcpApp: { requested: true, activate: false },
        mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /outside the supported Tama range/u.test(error.message),
  );
  assert.ok(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).mcpApp,
  );
});

test("bootstrap rejects an unpinned Tama image for the MCP App integration", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  for (const image of ["ghcr.io/upmaru/tama:latest", "ghcr.io/upmaru/tama"]) {
    assert.throws(
      () =>
        createBootstrapPlan({
          cwd: root,
          targetPath: root,
          image,
          mcpApp: { requested: true, activate: false },
          mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
        }),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.USAGE &&
        /requires a pinned Tama image/u.test(error.message) &&
        /unresolvable tag/u.test(error.message),
    );
  }
});

test("bootstrap fails closed when the provider identity or contract bindings drift", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const driftedIdentity = preparedFor(root, {
    contractPath,
    contractDocument: contract,
    identity: {
      name: "other",
      environmentPrefix: "OTHER",
      environmentFile: ".other.integration.env",
      source: "flags",
    },
  });
  assert.throws(
    () => planWithMcp(root, driftedIdentity),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /does not match the resolved identity/u.test(error.message),
  );

  // Undeclared variables are rejected by the contract validator itself, so a
  // drifted binding that still validates must swap two declared variables.
  const memoveeBindings = memoveeContract().bindings;
  const driftedBindings = preparedFor(root, {
    contractPath,
    contractDocument: validateMcpAppContract(
      memoveeContract({
        bindings: {
          ...memoveeBindings,
          issuer: memoveeBindings.resource,
          resource: memoveeBindings.issuer,
        },
      }),
    ),
  });
  assert.throws(
    () => planWithMcp(root, driftedBindings),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /bindings changed/u.test(error.message),
  );
});

test("bootstrap requires the provider fragment key and kid together", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  writeFileSync(
    join(root, ".memovee.integration.env"),
    "MEMOVEE_OAUTH_SIGNING_KEY_ID=mcp-app-provider-orphan\n",
  );
  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /must define/u.test(error.message),
  );
});

test("bootstrap refuses a user-modified provider fragment", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );
  const fragmentPath = join(root, ".memovee.integration.env");
  writeFileSync(
    fragmentPath,
    readFileSync(fragmentPath, "utf8").replace(
      "MEMOVEE_TAMA_MCP_APP_MODE=prepared",
      "MEMOVEE_TAMA_MCP_APP_MODE=disabled",
    ),
  );
  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /user-modified content/u.test(error.message),
  );
});

test("bootstrap preserves unrelated provider fragment entries and comments", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );
  const fragmentPath = join(root, ".memovee.integration.env");
  writeFileSync(
    fragmentPath,
    `${readFileSync(fragmentPath, "utf8")}# Provider-owned setting\nMEMOVEE_OTHER_VALUE=kept\n`,
  );
  const rerun = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  const operation = rerun.operations.find(({ path }) => path === fragmentPath);
  assert.equal(operation?.action, "unchanged");
  assert.match(
    operation?.content ?? readFileSync(fragmentPath, "utf8"),
    /MEMOVEE_OTHER_VALUE=kept/u,
  );
});

test("bootstrap explicitly migrates provider identity without rotating trust material", async () => {
  const root = project();
  const originalPrepared = await prepareFor(root, {
    providerName: "acme",
    providerOrigin: "http://host.docker.internal:5000",
  });
  const original = planWithMcp(root, originalPrepared, {
    providerOrigin: "http://host.docker.internal:5000",
  });
  applyOperations(original.operations);
  const oldPath = join(root, ".acme.integration.env");
  const originalValues = parseEnv(readFileSync(oldPath, "utf8"));

  writeFileSync(oldPath, `${readFileSync(oldPath, "utf8")}# Provider-owned\nACME_OTHER=kept\n`);
  const adopted = planWithMcp(root, await prepareFor(root), {
    providerOrigin: "http://host.docker.internal:5000",
  });
  applyOperations(adopted.operations);
  writeFileSync(join(root, ".envrc"), 'dotenv_load ".beta.integration.env"\n');

  const migratedPrepared = await prepareFor(root, {
    providerName: "beta",
    providerPrefix: "BETA",
    providerOrigin: "http://host.docker.internal:5000",
    migrateProviderIdentity: true,
  });
  const migrated = planWithMcp(root, migratedPrepared, {
    providerOrigin: "http://host.docker.internal:5000",
    migrateProviderIdentity: true,
  });
  assert.ok(
    migrated.operations.some(({ action, path }) => action === "delete" && path === oldPath),
  );
  await assert.rejects(
    () =>
      applyOperationsTransactionally(migrated.operations, () => {
        throw new Error("forced post-write failure");
      }),
    /forced post-write failure/u,
  );
  assert.equal(existsSync(oldPath), true);
  assert.equal(existsSync(join(root, ".beta.integration.env")), false);
  assert.equal(readMcpAppProvider(join(root, "tama"))?.identity.name, "acme");

  const retry = planWithMcp(root, migratedPrepared, {
    providerOrigin: "http://host.docker.internal:5000",
    migrateProviderIdentity: true,
  });
  applyOperations(retry.operations);

  const newPath = join(root, ".beta.integration.env");
  assert.equal(existsSync(oldPath), false);
  const migratedValues = parseEnv(readFileSync(newPath, "utf8"));
  assert.equal(
    migratedValues.BETA_OAUTH_PRIVATE_SIGNING_KEY,
    originalValues.ACME_OAUTH_PRIVATE_SIGNING_KEY,
  );
  assert.equal(migratedValues.BETA_OAUTH_SIGNING_KEY_ID, originalValues.ACME_OAUTH_SIGNING_KEY_ID);
  assert.equal(migratedValues.ACME_OTHER, "kept");
  assert.equal(migratedValues.ACME_OAUTH_PRIVATE_SIGNING_KEY, undefined);
  assert.equal(readMcpAppProvider(join(root, "tama"))?.identity.name, "beta");

  const convergedPrepared = await prepareFor(root);
  const converged = planWithMcp(root, convergedPrepared, {
    providerOrigin: "http://host.docker.internal:5000",
  });
  assert.ok(converged.operations.every(({ action }) => action === "unchanged"));
});

test("bootstrap preserves a valid persisted public JWK overlap set byte-for-byte", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const rotated = generateOAuthKeyPair("rotated");
  const rotatedKey = { ...JSON.parse(rotated.publicJwk), kid: "rotated-overlap-key" };

  const fragmentPath = join(root, ".memovee.integration.env");
  const fragment = readFileSync(fragmentPath, "utf8")
    .split("\n")
    .map((line) =>
      line.startsWith("MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS=")
        ? `MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS='${JSON.stringify([rotatedKey])}'`
        : line,
    )
    .join("\n");
  writeFileSync(fragmentPath, fragment);

  const tamaPath = join(root, ".tama.env");
  const tamaEnv = readFileSync(tamaPath, "utf8")
    .split("\n")
    .map((line) =>
      line.startsWith("TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS=")
        ? `TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS=${JSON.stringify([rotatedKey])}`
        : line,
    )
    .join("\n");
  writeFileSync(tamaPath, tamaEnv);

  const second = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  for (const operation of second.operations) {
    if (operation.path === fragmentPath || operation.path === tamaPath) {
      assert.equal(operation.action, "unchanged", operation.path);
    } else if (operation.action !== "unchanged") {
      assert.match(basename(operation.path), /\.tama-kit\.json$/u);
    }
  }
  assert.equal(readFileSync(fragmentPath, "utf8"), fragment);
  assert.equal(readFileSync(tamaPath, "utf8"), tamaEnv);
  assert.deepEqual(
    JSON.parse(parseEnv(readFileSync(fragmentPath, "utf8")).MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS),
    [rotatedKey],
  );
  assert.deepEqual(
    JSON.parse(parseEnv(readFileSync(tamaPath, "utf8")).TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS),
    [rotatedKey],
  );

  applyOperations(second.operations);
  const third = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  assert.ok(third.operations.every((operation) => operation.action === "unchanged"));
  assert.equal(readFileSync(fragmentPath, "utf8"), fragment);
  assert.equal(readFileSync(tamaPath, "utf8"), tamaEnv);
});

test("bootstrap fails closed on an invalid persisted public JWK overlap set", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const fragmentPath = join(root, ".memovee.integration.env");
  const fragmentLines = readFileSync(fragmentPath, "utf8").split("\n");
  const overlapIndex = fragmentLines.findIndex((line) =>
    line.startsWith("MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS="),
  );
  fragmentLines[overlapIndex] =
    'MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS=\'[{"kty":"RSA","n":"AQ","e":"AQ","kid":"bad","d":"AQ"}]\'';
  writeFileSync(fragmentPath, fragmentLines.join("\n"));
  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS/u.test(error.message),
  );

  fragmentLines[overlapIndex] = "MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS='[]'";
  writeFileSync(fragmentPath, fragmentLines.join("\n"));

  const tamaPath = join(root, ".tama.env");
  const tamaLines = readFileSync(tamaPath, "utf8").split("\n");
  const tamaIndex = tamaLines.findIndex((line) =>
    line.startsWith("TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS="),
  );
  tamaLines[tamaIndex] = 'TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS=[{"kty":"EC","kid":"bad"}]';
  writeFileSync(tamaPath, tamaLines.join("\n"));
  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS/u.test(error.message),
  );
});

test("bootstrap rejects a weak RSA key persisted in the public overlap set", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  // The runtime republishes overlap members as trusted RS256 material, so a
  // factorable 1024-bit key must fail the re-bootstrap exactly like any other
  // invalid persisted set.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const weak = publicKey.export({ format: "jwk" });
  const weakKey = { .../** @type {Record<string, string>} */ (weak), kid: "weak-overlap-key" };
  const fragmentPath = join(root, ".memovee.integration.env");
  const fragment = readFileSync(fragmentPath, "utf8")
    .split("\n")
    .map((line) =>
      line.startsWith("MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS=")
        ? `MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS='${JSON.stringify([weakKey])}'`
        : line,
    )
    .join("\n");
  writeFileSync(fragmentPath, fragment);

  assert.throws(
    () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS/u.test(error.message),
  );
});

test("bootstrap derives MCP App origins from the persisted Tama port", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: PINNED_TAMA_IMAGE,
    port: 4567,
    mcpApp: {
      requested: true,
      activate: false,
      allowedOrigins: ["http://127.0.0.1:3000"],
    },
    mcpAppPrepared: preparedFor(root, { contractPath, contractDocument: contract }),
  });
  applyOperations(first.operations);
  assert.equal(first.mcpApp?.tamaOrigin, "http://127.0.0.1:4567");
  assert.equal(first.mcpApp?.resource, "http://127.0.0.1:4567/mcp/app");

  const second = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  assert.equal(second.port, 4567);
  assert.equal(second.mcpApp?.tamaOrigin, "http://127.0.0.1:4567");
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap preserves exact public origins and never infers allowed origins", () => {
  for (const tamaOrigin of [
    "http://localhost:4001",
    "http://127.0.0.1:4001",
    "http://[::1]:4001",
  ]) {
    const root = project();
    const plan = planWithMcp(root, preparedFor(root), { tamaOrigin });
    assert.equal(plan.mcpApp?.tamaOrigin, tamaOrigin);
    assert.equal(plan.mcpApp?.resource, `${tamaOrigin}/mcp/app`);
    assert.deepEqual(plan.mcpApp?.allowedOrigins, ["http://127.0.0.1:3000"]);
    assert.equal(plan.mcpApp?.allowedOrigins.includes(tamaOrigin), false);
  }

  const root = project();
  const first = planWithMcp(root, preparedFor(root), {
    tamaOrigin: "http://127.0.0.1:4001",
  });
  applyOperations(first.operations);
  const persisted = readMcpAppProvider(join(root, "tama"));
  assert.equal(persisted?.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(persisted?.tamaOrigin, "http://127.0.0.1:4001");
  assert.deepEqual(persisted?.allowedOrigins, ["http://127.0.0.1:3000"]);
  assert.throws(
    () =>
      planWithMcp(root, preparedFor(root), {
        tamaOrigin: "http://localhost:4001",
      }),
    /origin migration|topology migration/u,
  );
});

test("resolveEnvironmentPort preserves a configured port and fails closed on invalid values", () => {
  const root = project();
  assert.equal(resolveEnvironmentPort(root, undefined), 4000);
  assert.equal(resolveEnvironmentPort(root, 5000), 5000);
  writeFileSync(join(root, ".tama.env"), "TAMA_PORT=4567\n");
  assert.equal(resolveEnvironmentPort(root, undefined), 4567);
  assert.equal(resolveEnvironmentPort(root, 6000), 6000);
  writeFileSync(join(root, ".tama.env"), "TAMA_PORT=not-a-port\n");
  assert.throws(
    () => resolveEnvironmentPort(root, undefined),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("readMcpAppProvider fails closed on a malformed persisted provider block", () => {
  const root = project();
  const tamaDirectory = join(root, "tama");
  mkdirSync(tamaDirectory, { recursive: true });
  assert.equal(readMcpAppProvider(tamaDirectory), null);
  writeFileSync(
    join(tamaDirectory, ".tama-kit.json"),
    JSON.stringify({
      mcpAppProvider: {
        name: "memovee",
        environmentPrefix: "MEMOVEE",
        environmentFile: ".memovee.integration.env",
        contractSource: "bogus",
        contractPath: null,
        bindings: { mode: "MEMOVEE_TAMA_MCP_APP_MODE" },
        environmentLoading: "verified",
      },
    }),
  );
  assert.throws(
    () => readMcpAppProvider(tamaDirectory),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /invalid mcpAppProvider/u.test(error.message),
  );
});

/**
 * Builds a JWKS document publishing the public members of a private JWK
 * under `kid`, or a placeholder key when no JWK is supplied.
 *
 * @param {string} kid
 * @param {string} [privateJwk]
 * @returns {Record<string, unknown>}
 */
function jwksDocument(kid, privateJwk) {
  const key = privateJwk === undefined ? { n: "AQAB", e: "AQAB" } : JSON.parse(privateJwk);
  return { keys: [{ kid, kty: "RSA", alg: "RS256", n: key.n, e: key.e }] };
}

/** @param {NonNullable<ReturnType<typeof planWithMcp>["mcpApp"]>} plan */
function providerMetadata(plan) {
  return {
    issuer: plan.providerOrigin,
    jwks_uri: `${plan.providerOrigin}/.well-known/jwks.json`,
  };
}

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

/**
 * Keeps the container-reachability probe out of the deterministic
 * verification tests: "unknown" skips the probe exactly like a non-Linux
 * host would.
 */
const noContainerInspection = async () => "unknown";

/**
 * Wraps a fake fetch so the provider's introspection endpoint enforces client
 * authentication the way a real provider must: a client assertion that is not
 * a signed JWT is rejected with HTTP 400.
 *
 * @param {(input: URL, init?: RequestInit) => Promise<Response>} fetch
 */
function enforcingIntrospection(fetch) {
  return async (input, init) => {
    if (/** @type {URL} */ (input).href.endsWith("/auth/introspections")) {
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("client_assertion") ?? "";
      if (!JWT_PATTERN.test(assertion)) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return fetch(input, init);
  };
}

/** @returns {Promise<{root: string, plan: NonNullable<ReturnType<typeof planWithMcp>["mcpApp"]>, providerJwk: string, tamaJwk: string}>} */
async function buildVerifiedRoot() {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const plan = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }));
  applyOperations(plan.operations);
  const mcp = plan.mcpApp;
  assert.ok(mcp);
  const fragment = parseEnv(readFileSync(join(root, mcp.provider.environmentFile), "utf8"));
  const tamaValues = parseEnv(readFileSync(join(root, ".tama.env"), "utf8"));
  const providerJwk = fragment[mcp.bindings.roles.access_token_private_signing_key];
  const tamaJwk = tamaValues.TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY;
  assert.equal(typeof providerJwk, "string");
  assert.equal(typeof tamaJwk, "string");
  return {
    root,
    plan: mcp,
    providerJwk: /** @type {string} */ (providerJwk),
    tamaJwk: /** @type {string} */ (tamaJwk),
  };
}

test("verifyMcpApp verifies both JWKS and the inactive introspection probe", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const calls = [];
  const fetch = async (input, init) => {
    const url = input.href;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.endsWith("/auth/introspections")) {
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("client_assertion") ?? "";
      if (!JWT_PATTERN.test(assertion)) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(providerMetadata(plan));
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      const body = url.startsWith(plan.tamaOrigin)
        ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
        : jwksDocument(plan.providerSigningKeyId, providerJwk);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ active: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await verifyMcpApp({
    root,
    plan,
    fetch,
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.mode, "prepared");
  assert.equal(result.providerReachable, true);
  assert.equal(result.tamaReachable, true);
  assert.equal(result.verified, true);
  assert.deepEqual(
    result.probes.map(({ name, ok }) => ({ name, ok })),
    [
      { name: "provider_metadata", ok: true },
      { name: "provider_jwks", ok: true },
      { name: "tama_jwks", ok: true },
      { name: "inactive_introspection", ok: true },
    ],
  );
  const introspectionCalls = calls.filter((call) => call.url.endsWith("/auth/introspections"));
  assert.equal(introspectionCalls.length, 2);
  const controlBody = new URLSearchParams(String(introspectionCalls[0]?.body));
  assert.doesNotMatch(String(controlBody.get("client_assertion")), JWT_PATTERN);
  const body = new URLSearchParams(String(introspectionCalls[1]?.body));
  assert.equal(body.get("token"), "tama-kit-bootstrap-inactive-probe");
  assert.equal(
    body.get("client_assertion_type"),
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  );
  assert.match(body.get("client_assertion"), JWT_PATTERN);
});

test("verifyMcpApp rejects an introspection endpoint that accepts invalid client assertions", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const result = await verifyMcpApp({
    root,
    plan,
    // A public endpoint answers the negative control exactly like the
    // authenticated request, so the probe must fail before trusting it.
    fetch: async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json(
          url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId, providerJwk),
        );
      }
      return Response.json({ active: false });
    },
    inspectProviderListener: noContainerInspection,
  });
  const probe = result.probes.find(({ name }) => name === "inactive_introspection");
  assert.equal(probe?.ok, false);
  assert.match(probe?.reason ?? "", /invalid client assertion/u);
  assert.equal(result.verified, false);
});

test("verifyMcpApp reports each failed probe independently", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();

  const wrongProvider = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      const body = url.startsWith(plan.tamaOrigin)
        ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
        : jwksDocument("wrong-kid");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(wrongProvider.mode, "prepared");
  assert.equal(wrongProvider.providerReachable, false);
  assert.equal(wrongProvider.tamaReachable, true);
  assert.equal(wrongProvider.verified, false);
  assert.equal(wrongProvider.probes.find(({ name }) => name === "provider_metadata")?.ok, true);
  assert.equal(wrongProvider.probes.find(({ name }) => name === "provider_jwks")?.ok, false);

  const activeToken = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return new Response(
          JSON.stringify(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(activeToken.verified, false);

  const unreachable = await verifyMcpApp({
    root,
    plan,
    fetch: async (input) => {
      const url = input.href;
      if (url.startsWith(plan.tamaOrigin)) {
        return new Response(JSON.stringify(jwksDocument(plan.introspectionSigningKeyId, tamaJwk)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("ECONNREFUSED");
    },
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(unreachable.mode, "prepared");
  assert.equal(unreachable.providerReachable, false);
  assert.equal(unreachable.tamaReachable, true);
  assert.equal(unreachable.verified, false);
  assert.equal(unreachable.probes.find(({ name }) => name === "provider_metadata")?.ok, false);
});

test("verifyMcpApp gates enabled metadata, route, and exact provider advertisement", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const enabledPlan = { ...plan, lifecycle: "enabled", providerLifecycle: "enabled" };
  const result = await verifyMcpApp({
    root,
    plan: enabledPlan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          ...providerMetadata(enabledPlan),
          protected_resources: [enabledPlan.resource],
        });
      }
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp/app")) {
        return Response.json({
          resource: enabledPlan.resource,
          authorization_servers: [enabledPlan.providerOrigin],
        });
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json(
          url.startsWith(enabledPlan.tamaOrigin)
            ? jwksDocument(enabledPlan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(enabledPlan.providerSigningKeyId, providerJwk),
        );
      }
      if (url === enabledPlan.resource) {
        return Response.json({ error: "missing_token" }, { status: 401 });
      }
      return Response.json({ active: false });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(
    result.probes.map(({ name }) => name),
    [
      "provider_metadata",
      "provider_jwks",
      "tama_jwks",
      "inactive_introspection",
      "tama_protected_resource_metadata",
      "tama_resource_route",
      "provider_resource_advertisement",
    ],
  );
});

test("verifyMcpApp rejects a JWKS whose key material does not match the persisted key", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();

  const staleProvider = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json(
          url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId),
        );
      }
      return Response.json({ active: false });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(staleProvider.verified, false);
  assert.equal(staleProvider.providerReachable, false);
  assert.equal(staleProvider.tamaReachable, true);
  const staleProbe = staleProvider.probes.find(({ name }) => name === "provider_jwks");
  assert.equal(staleProbe?.ok, false);
  assert.match(staleProbe?.reason ?? "", /different key under the expected identifier/u);

  const staleTama = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json(
          url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId)
            : jwksDocument(plan.providerSigningKeyId, providerJwk),
        );
      }
      return Response.json({ active: false });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(staleTama.verified, false);
  assert.equal(staleTama.providerReachable, true);
  assert.equal(staleTama.tamaReachable, false);
  const staleTamaProbe = staleTama.probes.find(({ name }) => name === "tama_jwks");
  assert.equal(staleTamaProbe?.ok, false);
  assert.match(
    staleTamaProbe?.reason ?? "",
    /different introspection key under the expected identifier/u,
  );
});

test("verifyMcpApp rejects a JWKS that exposes private members under the expected identifier", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const leaked = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        const body = url.startsWith(plan.tamaOrigin)
          ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
          : jwksDocument(plan.providerSigningKeyId, providerJwk);
        body.keys[0].d = "leaked-private-exponent";
        return Response.json(body);
      }
      return Response.json({ active: false });
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(leaked.verified, false);
  assert.equal(leaked.providerReachable, false);
  const leakedProbe = leaked.probes.find(({ name }) => name === "provider_jwks");
  assert.equal(leakedProbe?.ok, false);
  assert.match(leakedProbe?.reason ?? "", /different key under the expected identifier/u);
});

test("verifyMcpApp probes the host-native provider over the loopback transport", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const fetchWith = (metadata) =>
    enforcingIntrospection(
      async (/** @type {URL} */ input, /** @type {RequestInit | undefined} */ init) => {
        const url = input.href;
        calls.push({ url, method: init?.method ?? "GET", body: init?.body });
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(metadata);
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          const body = url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId, providerJwk);
          return Response.json(body);
        }
        return Response.json({ active: false });
      },
    );
  const calls = [];
  const result = await verifyMcpApp({
    root,
    plan,
    fetch: fetchWith(providerMetadata(plan)),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(plan.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(result.verified, true);
  assert.equal(
    calls.find((call) => call.url.endsWith("/.well-known/oauth-authorization-server"))?.url,
    "http://127.0.0.1:4000/.well-known/oauth-authorization-server",
  );
  assert.equal(
    calls.find(
      (call) =>
        call.url.endsWith("/.well-known/jwks.json") && !call.url.startsWith(plan.tamaOrigin),
    )?.url,
    "http://127.0.0.1:4000/.well-known/jwks.json",
  );
  const authenticated = calls.filter((call) => call.url.endsWith("/auth/introspections")).at(-1);
  assert.equal(authenticated?.url, "http://127.0.0.1:4000/auth/introspections");
  const assertion = new URLSearchParams(String(authenticated?.body)).get("client_assertion");
  const payload = JSON.parse(
    Buffer.from(/** @type {string} */ (assertion).split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(payload.aud, "http://host.docker.internal:4000/auth/introspections");

  const mismatched = await verifyMcpApp({
    root,
    plan,
    fetch: fetchWith({ ...providerMetadata(plan), issuer: "http://127.0.0.1:4000" }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.probes.find(({ name }) => name === "provider_metadata")?.ok, false);
});

test("verifyMcpApp fails the host-gateway topology when the provider bind is loopback-only", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const withListener = (inspection) =>
    verifyMcpApp({
      root,
      plan,
      fetch: enforcingIntrospection(async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        return Response.json({ active: false });
      }),
      inspectProviderListener: async () => inspection,
    });

  const loopbackOnly = await withListener("loopback-only");
  assert.equal(loopbackOnly.verified, false);
  const probe = loopbackOnly.probes.find(({ name }) => name === "provider_container_reachability");
  assert.equal(probe?.ok, false);
  assert.match(probe?.reason ?? "", /loopback/u);

  const wide = await withListener("wide");
  assert.equal(wide.verified, true);
  assert.equal(
    wide.probes.find(({ name }) => name === "provider_container_reachability")?.ok,
    true,
  );

  const unknown = await withListener("unknown");
  assert.equal(unknown.verified, true);
  assert.equal(
    unknown.probes.find(({ name }) => name === "provider_container_reachability"),
    undefined,
  );
});

test("verifyMcpApp requires the protected route to reject anonymous requests", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const enabledPlan = { ...plan, lifecycle: "enabled", providerLifecycle: "prepared" };
  const withRouteStatus = (status) =>
    verifyMcpApp({
      root,
      plan: enabledPlan,
      fetch: enforcingIntrospection(async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/oauth-protected-resource/mcp/app")) {
          return Response.json({
            resource: plan.resource,
            authorization_servers: [plan.providerOrigin],
          });
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        if (url === plan.resource) {
          return new Response(null, { status });
        }
        return Response.json({ active: false });
      }),
      inspectProviderListener: noContainerInspection,
    });
  for (const status of [200, 400, 404, 503]) {
    const result = await withRouteStatus(status);
    const routeProbe = result.probes.find(({ name }) => name === "tama_resource_route");
    assert.equal(routeProbe?.ok, false, `HTTP ${status} must not count as a protected route`);
    assert.match(routeProbe?.reason ?? "", /401 or 403/u);
  }
  for (const status of [401, 403]) {
    const result = await withRouteStatus(status);
    assert.equal(result.probes.find(({ name }) => name === "tama_resource_route")?.ok, true);
  }
});

test("verifyMcpApp requires an RSA signing member for the expected identifier", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const providerKey = JSON.parse(providerJwk);
  const variants = [
    { kid: plan.providerSigningKeyId, n: providerKey.n, e: providerKey.e },
    { kid: plan.providerSigningKeyId, kty: "EC", n: providerKey.n, e: providerKey.e },
    {
      kid: plan.providerSigningKeyId,
      kty: "RSA",
      alg: "HS256",
      n: providerKey.n,
      e: providerKey.e,
    },
    { kid: plan.providerSigningKeyId, kty: "RSA", use: "enc", n: providerKey.n, e: providerKey.e },
  ];
  for (const member of variants) {
    const result = await verifyMcpApp({
      root,
      plan,
      fetch: enforcingIntrospection(async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          const body = url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : { keys: [member] };
          return Response.json(body);
        }
        return Response.json({ active: false });
      }),
      inspectProviderListener: noContainerInspection,
    });
    assert.equal(result.providerReachable, false, JSON.stringify(member));
    assert.equal(result.probes.find(({ name }) => name === "provider_jwks")?.ok, false);
  }
});

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
  const gitignorePath = join(root, ".gitignore");
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

  writeFileSync(join(root, ".envrc"), 'dotenv_load ".beta.integration.env"\n');
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
  assert.equal(contractTamaPort(null, loadTamaContract()), 4001);
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
  assert.match(readFileSync(join(root, ".tama.env.example"), "utf8"), /host\.docker\.internal/u);

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

test("an ordinary rerun keeps the pinned image for a persisted MCP App integration", () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  const first = planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract }), {
    providerOrigin: "http://host.docker.internal:4000",
  });
  applyOperations(first.operations);

  // The default floating tag must not silently replace the pinned runtime.
  assert.throws(
    () => createBootstrapPlan({ cwd: root, targetPath: root }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /requires a pinned Tama image/u.test(error.message) &&
      /unresolvable tag latest/u.test(error.message),
  );
  assert.doesNotThrow(() =>
    createBootstrapPlan({ cwd: root, targetPath: root, image: PINNED_TAMA_IMAGE }),
  );
});

test("provider fragment paths that collide with managed files are rejected", () => {
  for (const environmentFile of [
    ".tama.env",
    ".tama.postgres.env",
    ".envrc",
    ".gitignore",
    "tama/compose.yaml",
    "tama/.tama-kit.json",
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
  execFileSync("git", ["add", "--force", ".memovee.integration.env"], { cwd: root });
  assert.throws(
    () => createBootstrapPlan({ cwd: root, targetPath: root }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes(".memovee.integration.env") &&
      error.details.paths.includes(".memovee.integration.env"),
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
    "ghcr.io/upmaru/tama:0.13.1",
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
    environmentFile: ".acme.integration.env",
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
  assert.ok(
    result.changes.some((change) => change.path.endsWith(".acme.integration.env")),
    "the provider fragment should be part of the planned changes",
  );
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
    "ghcr.io/upmaru/tama:0.13.1",
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
  assert.equal(existsSync(join(root, ".tama.env")), false);
  assert.equal(existsSync(join(root, ".acme.integration.env")), false);
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
    "ghcr.io/upmaru/tama:0.13.1",
    "--allowed-origin",
    "http://127.0.0.1:3000",
  ]);
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.provider, {
    name: "memovee",
    environmentPrefix: "MEMOVEE",
    environmentFile: ".memovee.integration.env",
    identitySource: "contract",
    contractPath,
    mode: "prepared",
    modeVariable: "MEMOVEE_TAMA_MCP_APP_MODE",
    environmentLoading: "verified",
  });
  assert.equal(result.mcpApp.providerOrigin, "http://host.docker.internal:4000");
  assert.ok(result.changes.some((change) => change.path.endsWith(".memovee.integration.env")));
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
