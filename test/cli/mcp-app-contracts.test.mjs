import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  contractLocalOrigin,
  discoverProviderContract,
  loadTamaContract,
  resolveBindings,
  unsupportedTamaImage,
  validateEmittedMcpAppValues,
  validateMcpAppContract,
  verifyEnvironmentLoading,
  verifyEnvironmentLoadingEvidence,
} from "../../cli/bootstrap/mcp-app-contract.mjs";
import {
  renderMcpAppLocalContract,
  serializeMcpAppLocalContract,
  validateMcpAppLocalContract,
} from "../../cli/bootstrap/mcp-app-local-contract.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import {
  memoveeContract,
  PINNED_TAMA_IMAGE,
  planWithMcp,
  preparedFor,
  project,
  validContract,
  writeContract,
} from "../helpers/mcp-app.mjs";

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

  // Conventional fallback: a contract that declares a provider identity but
  // no bindings map derives the role names from the declared prefix, and
  // those derived names are cross-checked the same way.
  const withoutBindings = /** @type {Record<string, unknown>} */ (structuredClone(base));
  delete withoutBindings.bindings;
  assert.doesNotThrow(() => validateMcpAppContract(withoutBindings));
  const missing = /** @type {Record<string, unknown>} */ (structuredClone(withoutBindings));
  const missingVariables = /** @type {Record<string, unknown>} */ (missing.variables);
  delete missingVariables.MEMOVEE_OAUTH_ISSUER;
  assert.throws(
    () => validateMcpAppContract(missing),
    /binding "issuer" references undeclared variable MEMOVEE_OAUTH_ISSUER/u,
  );
});

test("bootstrap rejects a contract whose declared constraints the planned values violate", () => {
  const base = validContract();
  const cases = [
    [
      "MEMOVEE_TAMA_MCP_APP_RESOURCE",
      (variable) => {
        variable.exact_path = "/different";
      },
      /its path is \/mcp\/app, which must be \/different/u,
    ],
    [
      "MEMOVEE_OAUTH_ISSUER",
      (variable) => {
        variable.max_bytes = 1;
      },
      /exceeding max_bytes 1/u,
    ],
  ];
  for (const [variableName, mutate, pattern] of cases) {
    const root = project();
    const document = /** @type {Record<string, unknown>} */ (structuredClone(base));
    const variables = /** @type {Record<string, Record<string, unknown>>} */ (document.variables);
    mutate(variables[/** @type {string} */ (variableName)]);
    const contractDocument = validateMcpAppContract(document);
    const contractPath = writeContract(root, contractDocument);
    assert.throws(
      () => planWithMcp(root, preparedFor(root, { contractPath, contractDocument })),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.USAGE &&
        pattern.test(error.message),
    );
  }
});

test("validateEmittedMcpAppValues enforces the value-specific contract constraints", () => {
  const contract = validContract();
  const roles = resolveBindings(contract, "MEMOVEE").roles;
  const compliant = {
    [roles.mode]: "prepared",
    [roles.issuer]: "http://host.docker.internal:4000",
    [roles.resource]: "http://127.0.0.1:4001/mcp/app",
    [roles.access_token_signing_algorithm]: "RS256",
    [roles.access_token_signing_key_id]: "mcp-app-provider-abc123",
    [roles.access_token_private_signing_key]: JSON.stringify({
      kty: "RSA",
      d: "base64url",
      n: "base64url",
      e: "AQAB",
    }),
    [roles.access_token_public_overlap_keys]: "[]",
    [roles.introspection_client_id]: "http://127.0.0.1:4001/mcp/app/introspection",
    [roles.introspection_jwks_uri]: "http://127.0.0.1:4001/.well-known/jwks.json",
  };
  assert.doesNotThrow(() => validateEmittedMcpAppValues(contract, roles, compliant));
  // Conventional planning declares no variables, so there is nothing to check.
  assert.doesNotThrow(() => validateEmittedMcpAppValues(null, roles, compliant));
  // Dry-run placeholder material is validated when it is materialized.
  assert.doesNotThrow(() =>
    validateEmittedMcpAppValues(contract, roles, {
      ...compliant,
      [roles.access_token_private_signing_key]: "__tama-kit-pending-secret-material__",
    }),
  );

  const rejects = (value, variable, pattern) =>
    assert.throws(
      () => validateEmittedMcpAppValues(contract, roles, { ...compliant, [variable]: value }),
      pattern,
    );
  rejects(
    "http://host.docker.internal:4000/oauth",
    roles.issuer,
    /must not include a path, query, or fragment/u,
  );
  rejects("mcp app key", roles.access_token_signing_key_id, /whitespace/u);
  rejects("not json", roles.access_token_private_signing_key, /not valid JSON/u);
  rejects('"[]"', roles.access_token_public_overlap_keys, /must be a JSON array/u);
  rejects("http://127.0.0.1:4001/mcp/other", roles.resource, /which must be \/mcp\/app/u);
  rejects(
    "http://127.0.0.1:9999/.well-known/jwks.json",
    roles.introspection_jwks_uri,
    /share the origin of MEMOVEE_TAMA_MCP_APP_RESOURCE/u,
  );

  const mutated = /** @type {Record<string, unknown>} */ (structuredClone(contract));
  const mutatedVariables = /** @type {Record<string, Record<string, unknown>>} */ (
    mutated.variables
  );
  mutatedVariables[roles.issuer].allowed_values = [compliant[roles.issuer]];
  mutatedVariables[roles.issuer].values = [compliant[roles.issuer]];
  mutatedVariables[roles.access_token_signing_key_id].values =
    compliant[roles.access_token_signing_key_id];
  assert.doesNotThrow(() => validateEmittedMcpAppValues(mutated, roles, compliant));
  assert.throws(
    () =>
      validateEmittedMcpAppValues(mutated, roles, {
        ...compliant,
        [roles.issuer]: "http://different-provider.test:4000",
      }),
    /not one of the declared values/u,
  );
  assert.throws(
    () =>
      validateEmittedMcpAppValues(mutated, roles, {
        ...compliant,
        [roles.access_token_signing_key_id]: "different-key",
      }),
    /not one of the declared values/u,
  );
  mutatedVariables[roles.access_token_public_overlap_keys].max_items = 1;
  assert.throws(
    () =>
      validateEmittedMcpAppValues(mutated, roles, {
        ...compliant,
        [roles.access_token_public_overlap_keys]: JSON.stringify([
          { kty: "RSA", n: "a", e: "AQAB", kid: "a" },
          { kty: "RSA", n: "b", e: "AQAB", kid: "b" },
        ]),
      }),
    /exceeding max_items 1/u,
  );
});

test("validateMcpAppContract rejects malformed v1 contract sections", () => {
  const mutations = [
    (contract) => delete contract.lifecycle.default_production_mode,
    (contract) => {
      contract.lifecycle.enabled_modes = ["unknown"];
    },
    (contract) => {
      contract.lifecycle.configured_modes = ["disabled"];
    },
    (contract) => {
      contract.lifecycle.enabled_modes = ["prepared", "enabled"];
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
    (contract) => {
      contract.public_endpoints.introspection = "/oauth/introspect";
    },
    (contract) => delete contract.availability.prepared,
    (contract) => {
      contract.availability.prepared.jwks = false;
    },
    (contract) => {
      contract.availability.enabled.introspection = false;
    },
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
      contract.supported_tama_versions = "^0.14.0";
    },
    (contract) => {
      contract.supported_tama_versions = ">= 0.13.1 garbage < 0.14.0";
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

test("local MCP App contract render, validation, and serialization are stable", () => {
  const root = project();
  const bindings = resolveBindings(null, "ACME").roles;
  const contract = renderMcpAppLocalContract({
    root,
    identity: {
      name: "acme",
      environmentPrefix: "ACME",
      environmentFile: "tama/.acme.integration.env",
      source: "flags",
    },
    bindings,
    providerContractPath: null,
    providerContractDocument: null,
    environmentLoading: { status: "unverified", mechanism: null, evidencePath: null },
  });
  const serialized = serializeMcpAppLocalContract(contract);
  const parsed = validateMcpAppLocalContract(JSON.parse(serialized));
  assert.deepEqual(parsed, contract);
  assert.equal(serializeMcpAppLocalContract(parsed), serialized);

  const invalid = structuredClone(contract);
  invalid.environment_loading = {
    status: "unverified",
    mechanism: "direnv",
    evidence_path: ".envrc",
  };
  assert.throws(() => validateMcpAppLocalContract(invalid), /cannot claim evidence/u);
});

test("verifyEnvironmentLoading confirms application-owned loaders", () => {
  const root = project();
  assert.equal(verifyEnvironmentLoading(root, "tama/.acme.integration.env", null), "unverified");
  writeFileSync(join(root, ".envrc"), 'dotenv_load "tama/.acme.integration.env"\n');
  assert.equal(verifyEnvironmentLoading(root, "tama/.acme.integration.env", null), "verified");
  assert.deepEqual(verifyEnvironmentLoadingEvidence(root, "tama/.acme.integration.env", null), {
    status: "verified",
    mechanism: "direnv",
    evidencePath: ".envrc",
  });

  const composeRoot = project();
  writeFileSync(
    join(composeRoot, "compose.yaml"),
    "services:\n  app:\n    env_file:\n      - tama/.acme.integration.env\n",
  );
  assert.equal(
    verifyEnvironmentLoading(composeRoot, "tama/.acme.integration.env", null),
    "verified",
  );
  assert.equal(
    verifyEnvironmentLoading(composeRoot, "tama/.acme.integration.env", {
      environment_loading: { mechanism: "direnv" },
    }),
    "verified",
  );

  const unquotedRoot = project();
  writeFileSync(join(unquotedRoot, ".envrc"), "dotenv tama/.acme.integration.env\n");
  assert.equal(
    verifyEnvironmentLoading(unquotedRoot, "tama/.acme.integration.env", null),
    "verified",
  );

  // A bare textual occurrence is not an active loader: a comment or an
  // unrelated command naming the fragment must not verify it, because
  // migration deletes the fragment this check exists to protect.
  const commentRoot = project();
  writeFileSync(
    join(commentRoot, ".envrc"),
    ['# dotenv_load "tama/.acme.integration.env"', 'echo "tama/.acme.integration.env"', ""].join(
      "\n",
    ),
  );
  assert.equal(
    verifyEnvironmentLoading(commentRoot, "tama/.acme.integration.env", null),
    "unverified",
  );

  const composeCommentRoot = project();
  writeFileSync(
    join(composeCommentRoot, "compose.yaml"),
    ["services:", "  app:", "    # env_file:", "    #   - tama/.acme.integration.env", ""].join(
      "\n",
    ),
  );
  assert.equal(
    verifyEnvironmentLoading(composeCommentRoot, "tama/.acme.integration.env", null),
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
      "      - tama/.acme.integration.env",
      "    labels:",
      "      fragment: tama/.acme.integration.env",
      "    volumes:",
      "      - tama/.acme.integration.env:/frag.env:ro",
      "",
    ].join("\n"),
  );
  assert.equal(
    verifyEnvironmentLoading(decoyRoot, "tama/.acme.integration.env", null),
    "unverified",
  );

  const inlineEnvFileRoot = project();
  writeFileSync(
    join(inlineEnvFileRoot, "compose.yaml"),
    "services:\n  app:\n    env_file: tama/.acme.integration.env\n",
  );
  assert.equal(
    verifyEnvironmentLoading(inlineEnvFileRoot, "tama/.acme.integration.env", null),
    "verified",
  );

  const selectedComposeRoot = project();
  mkdirSync(join(selectedComposeRoot, "ops"));
  const selectedCompose = join(selectedComposeRoot, "ops", "dev.yaml");
  writeFileSync(
    selectedCompose,
    "services:\n  app:\n    env_file:\n      - ../tama/.acme.integration.env\n      - ../tama/.memovee.integration.env\n",
  );
  assert.equal(
    verifyEnvironmentLoading(
      selectedComposeRoot,
      "tama/.acme.integration.env",
      null,
      selectedCompose,
    ),
    "verified",
  );
  assert.deepEqual(
    verifyEnvironmentLoadingEvidence(
      selectedComposeRoot,
      "tama/.acme.integration.env",
      null,
      selectedCompose,
    ),
    { status: "verified", mechanism: "compose-env-file", evidencePath: "ops/dev.yaml" },
  );

  const selectedPlan = createBootstrapPlan({
    cwd: selectedComposeRoot,
    targetPath: selectedComposeRoot,
    composePath: selectedCompose,
    image: PINNED_TAMA_IMAGE,
    port: 4001,
    mcpApp: {
      requested: true,
      activate: false,
      providerOrigin: "http://host.docker.internal:4000",
      allowedOrigins: ["http://127.0.0.1:3000"],
    },
    mcpAppPrepared: preparedFor(selectedComposeRoot),
  });
  assert.equal(selectedPlan.mcpApp?.environmentLoading, "verified");
  assert.deepEqual(selectedPlan.mcpApp?.localContract?.environment_loading, {
    status: "verified",
    mechanism: "compose-env-file",
    evidence_path: "ops/dev.yaml",
  });
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
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.2-server", range), null);
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.5-server", range), null);
  assert.equal(unsupportedTamaImage("example.com/tama:0.13.2", range), null);
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1", range) ?? "",
    /missing the required -server suffix/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.0-server", range) ?? "",
    /0\.13\.0-server/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.12.0-server", range) ?? "",
    /0\.12\.0-server/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.14.0-server", range) ?? "",
    /0\.14\.0-server/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1-rc.1-server", range) ?? "",
    /prerelease or build tag/u,
  );
  assert.match(
    unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.1+build.5-server", range) ?? "",
    /prerelease or build tag/u,
  );
  assert.equal(unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.2-server", null), null);
  assert.throws(
    () => unsupportedTamaImage("ghcr.io/upmaru/tama:0.13.2-server", "^0.14.0"),
    /comparison range/u,
  );
});

test("bundled Tama contract derives local HTTPS identities from PHX_HOST", () => {
  const contract = loadTamaContract();

  assert.equal(contract.supported_tama_versions, ">= 0.13.2 and < 0.14.0");
  assert.equal(Object.hasOwn(contract, "local_development"), false);
  assert.deepEqual(contract.variables.PHX_HOST, {
    required_in: ["prepared", "enabled"],
    format: "hostname",
    max_bytes: 253,
    "x-sensitive": false,
  });
  assert.deepEqual(contract.variables.TAMA_MCP_APP_RESOURCE, {
    required: false,
    format: "absolute-uri",
    exact_path: "/mcp/app",
    derived_from: "PHX_HOST",
    derived_template: "https://{PHX_HOST}/mcp/app",
    migration_assertion: true,
    max_bytes: 2048,
    "x-sensitive": false,
  });
  assert.deepEqual(contract.variables.TAMA_MCP_APP_INTROSPECTION_CLIENT_ID, {
    required: false,
    format: "bounded-identifier",
    derived_from: "PHX_HOST",
    derived_template: "https://{PHX_HOST}/mcp/app/introspection",
    migration_assertion: true,
    max_bytes: 2048,
    "x-sensitive": false,
  });
});

test("derived Tama variables require a safe declared source and migration assertion", () => {
  const mutations = [
    [
      "missing template",
      (contract) => delete contract.variables.TAMA_MCP_APP_RESOURCE.derived_template,
    ],
    [
      "unknown source",
      (contract) => {
        contract.variables.TAMA_MCP_APP_RESOURCE.derived_from = "UNKNOWN_HOST";
      },
    ],
    [
      "missing placeholder",
      (contract) => {
        contract.variables.TAMA_MCP_APP_RESOURCE.derived_template = "https://example/mcp/app";
      },
    ],
    [
      "required derived value",
      (contract) => {
        contract.variables.TAMA_MCP_APP_RESOURCE.required = true;
      },
    ],
    [
      "non-asserting legacy value",
      (contract) => {
        contract.variables.TAMA_MCP_APP_RESOURCE.migration_assertion = false;
      },
    ],
  ];

  for (const [label, mutate] of mutations) {
    const contract = structuredClone(loadTamaContract());
    mutate(contract);
    assert.throws(() => validateMcpAppContract(contract), /derived|declared/u, label);
  }
});
