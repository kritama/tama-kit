import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import {
  environmentFileForName,
  normalizeEnvironmentPrefix,
  normalizeProviderName,
  prefixFromName,
  resolveProviderIdentity,
} from "../../cli/bootstrap/provider-identity.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import {
  memoveeContract,
  planWithMcp,
  preparedFor,
  prepareFor,
  project,
  validContract,
  writeContract,
} from "../helpers/mcp-app.mjs";

test("provider identity normalization derives the prefix and fragment file", () => {
  assert.equal(normalizeProviderName("My__Service  "), "my-service");
  assert.equal(prefixFromName("my-service"), "MY_SERVICE");
  assert.equal(environmentFileForName("my-service"), "tama/.my-service.integration.env");
  assert.throws(() => normalizeProviderName("123"), /begin with a letter/u);
});

test("provider environment prefixes are conservatively bounded and avoid reserved domains", () => {
  assert.equal(normalizeEnvironmentPrefix("my provider"), "MY_PROVIDER");
  assert.throws(() => normalizeEnvironmentPrefix("abcdefghijklmnopqrstuvwxy"), /not valid/u);
  for (const reserved of ["TAMA", "TAMA_MCP", "POSTGRES", "DATABASE"]) {
    assert.throws(() => normalizeEnvironmentPrefix(reserved), /reserved/u);
  }
});

test("resolveProviderIdentity applies precedence when explicit identity signals agree", () => {
  const root = project();
  const contract = validContract();
  const manifest = {
    name: "memovee",
    environmentPrefix: "MEMOVEE",
    environmentFile: "tama/.memovee.integration.env",
    source: "manifest",
  };
  const fromManifest = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: manifest,
    contractDocument: contract,
    name: "memovee",
    prefix: "MEMOVEE",
    environmentFile: "tama/.memovee.integration.env",
  });
  assert.deepEqual(fromManifest, {
    name: "memovee",
    environmentPrefix: "MEMOVEE",
    environmentFile: "tama/.memovee.integration.env",
    source: "manifest",
  });

  const fromContract = resolveProviderIdentity({
    root,
    framework: "generic",
    manifestProvider: null,
    contractDocument: contract,
    name: "flagged",
    prefix: "FLAGGED",
    environmentFile: "tama/.flagged.integration.env",
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
    environmentFile: "tama/.my-service.integration.env",
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
    environmentFile: "tama/.custom-provider.integration.env",
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

test("prepareMcpApp rejects identity drift from flags or a contract", async () => {
  const root = project();
  const contractPath = writeContract(root);
  const contract = validContract();
  applyOperations(
    planWithMcp(root, preparedFor(root, { contractPath, contractDocument: contract })).operations,
  );

  const prepared = await prepareFor(root, { providerName: "memovee" }, { nonInteractive: true });
  assert.equal(prepared.identity.name, "memovee");
  assert.equal(prepared.identity.source, "manifest");
  assert.equal(prepared.persisted?.identity.name, "memovee");

  await assert.rejects(
    () => prepareFor(root, { providerName: "acme" }, { nonInteractive: true }),
    /provider flags resolve a different identity.*--migrate-provider-identity/u,
  );

  const driftedContract = memoveeContract();
  driftedContract.provider = {
    name: "acme",
    environment_prefix: "ACME",
    environment_file: "tama/.acme.integration.env",
  };
  driftedContract.environment_loading.loads = "tama/.acme.integration.env";
  writeContract(root, driftedContract);
  await assert.rejects(
    () => prepareFor(root, {}, { nonInteractive: true }),
    /provider contract resolves a different identity.*--migrate-provider-identity/u,
  );
});
