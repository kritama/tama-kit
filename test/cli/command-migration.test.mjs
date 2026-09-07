import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inspectCurrentConfiguration } from "../../cli/bootstrap/current-config.mjs";
import { validateMcpAppContract } from "../../cli/bootstrap/mcp-app-contract.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { composeUpArguments, probeComposeProviderEndpoint } from "../../cli/bootstrap/start.mjs";
import { run } from "../../cli/index.mjs";
import { contentDigest } from "../../cli/shared/files.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/shared/write.mjs";
import { planTamaModeChange } from "../../cli/workflows/activation.mjs";
import { memoveeContract, planWithMcp, preparedFor, writeContract } from "../helpers/mcp-app.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

async function command(root, ...args) {
  const output = [];
  const code = await run(args, {
    cwd: root,
    interactive: false,
    stdout: (value) => output.push(value),
    stderr: (value) => output.push(value),
  });
  return { code, result: JSON.parse(output.at(-1)) };
}
function snapshot(root) {
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) entries.push(...snapshot(path));
    else {
      const stat = statSync(path);
      entries.push([path, contentDigest(readFileSync(path, "utf8")), stat.mode, stat.mtimeMs]);
    }
  }
  return entries;
}
function standard() {
  const root = temporaryDirectory("tama-current-config-");
  applyOperations(createBootstrapPlan({ cwd: root, skillMode: "manual" }).operations);
  return root;
}
function mcp() {
  const root = temporaryDirectory("tama-current-mcp-");
  const document = memoveeContract();
  const contractPath = writeContract(root, document);
  const prepared = preparedFor(root, {
    contractPath,
    contractDocument: validateMcpAppContract(document),
  });
  const plan = planWithMcp(root, prepared);
  applyOperations(plan.operations);
  return { root, plan };
}

test("fresh command emits provenance receipt; v2 reruns preserve customized and deleted output", async () => {
  const root = temporaryDirectory("tama-owned-command-");
  const initial = await command(root, "bootstrap", root, "--json", "--skills", "local");
  assert.equal(initial.code, 0);
  const receipt = JSON.parse(readFileSync(join(root, "tama/.tama-kit.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.managedFiles, undefined);
  for (const name of [
    "tama/versions.tf",
    "tama/compose.yaml",
    "tama/README.md",
    "tama/AGENTS.md",
    ".agents/skills/graph-builder/SKILL.md",
  ])
    writeFileSync(join(root, name), "developer content\n");
  unlinkSync(join(root, "tama/main.tf"));
  const before = snapshot(root);
  for (const args of [["bootstrap"], ["init", "--dry-run"], ["bootstrap", "--skills", "manual"]]) {
    const result = await command(root, ...args, "--json");
    assert.equal(result.code, 0);
    assert.equal(result.result.generation.status, "existing");
    assert.deepEqual(result.result.changes, []);
    assert.deepEqual(snapshot(root), before);
  }
  const changed = await command(root, "bootstrap", "--image", "different:version", "--json");
  assert.equal(changed.code, 2);
  assert.match(changed.result.error.message, /does not upgrade/);
  assert.deepEqual(snapshot(root), before);
});

test("legacy bootstrap recognition ignores noncanonical historical topology and stale hashes", async () => {
  const root = standard();
  const path = join(root, "tama/.tama-kit.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.schemaVersion = 1;
  value.managedFiles = { "tama/versions.tf": `sha256:${"0".repeat(64)}` };
  value.mcpAppProvider = { localHttps: { providerUpstream: "renamed:9999" } };
  writeFileSync(path, JSON.stringify(value));
  unlinkSync(join(root, "tama/versions.tf"));
  const before = snapshot(root);
  assert.equal((await command(root, "bootstrap", "--json")).code, 0);
  assert.deepEqual(snapshot(root), before);
});

test("doctor and setup dry-run ignore absent or malformed receipts and preserve bytes", async () => {
  const root = standard();
  const receipt = join(root, "tama/.tama-kit.json");
  unlinkSync(receipt);
  for (const metadata of [null, "invalid-private-metadata"]) {
    if (metadata) writeFileSync(receipt, metadata);
    const before = snapshot(root);
    for (const args of [
      ["doctor", "--json"],
      ["setup", "--dry-run", "--json"],
    ]) {
      const response = await command(root, ...args);
      assert.equal(response.code, 0);
      assert.equal(response.result.configuration.status, "valid");
      assert.equal(response.result.setup.runtimeHealth, "not-checked");
      assert.deepEqual(snapshot(root), before);
    }
  }
});

test("inspection skips absent optional environment files without selecting them", async () => {
  const root = standard();
  writeFileSync(
    join(root, "optional.yaml"),
    "services:\n  tama:\n    env_file:\n      - path: ./optional.env\n        required: false\n",
  );
  const selection = ["--compose", "compose.yaml", "--compose", "optional.yaml"];
  const before = snapshot(root);
  for (const args of [["doctor"], ["setup", "--dry-run"]]) {
    const response = await command(root, ...args, ...selection, "--json");
    assert.equal(response.code, 0, JSON.stringify(response.result));
    assert.equal(response.result.configuration.status, "valid");
  }
  const plan = inspectCurrentConfiguration({
    cwd: root,
    composeFiles: ["compose.yaml", "optional.yaml"],
  });
  assert.equal(plan.runtime.environmentFile, join(root, "tama/.tama.env"));
  const selected = await command(
    root,
    "doctor",
    ...selection,
    "--env-file",
    "optional.env",
    "--json",
  );
  assert.equal(selected.code, 4);
  assert.match(selected.result.error.message, /not loaded/);
  assert.deepEqual(snapshot(root), before);
});

test("existing optional environment files retain private-file validation", async () => {
  const root = standard();
  writeFileSync(
    join(root, "optional.yaml"),
    "services:\n  tama:\n    env_file:\n      - path: ./optional.env\n        required: false\n",
  );
  const path = join(root, "optional.env");
  writeFileSync(path, "OPTIONAL_SETTING=present\n", { mode: 0o600 });
  const selection = ["--compose", "compose.yaml", "--compose", "optional.yaml"];
  assert.equal((await command(root, "doctor", ...selection, "--json")).code, 0);
  chmodSync(path, 0o644);
  const before = snapshot(root);
  const response = await command(root, "doctor", ...selection, "--json");
  assert.equal(response.code, 4);
  assert.match(response.result.error.message, /owner-only permissions/);
  assert.deepEqual(snapshot(root), before);
});

test("missing required environment files still fail inspection", async () => {
  const root = standard();
  writeFileSync(
    join(root, "required.yaml"),
    "services:\n  tama:\n    env_file:\n      - path: ./required.env\n        required: true\n",
  );
  const before = snapshot(root);
  const response = await command(
    root,
    "doctor",
    "--compose",
    "compose.yaml",
    "--compose",
    "required.yaml",
    "--json",
  );
  assert.equal(response.code, 4);
  assert.deepEqual(snapshot(root), before);
});

test("current inspection follows renamed services, relocated env files and ordered overrides", async () => {
  const root = standard();
  mkdirSync(join(root, "deploy"));
  mkdirSync(join(root, "private"));
  renameSync(join(root, "tama/.tama.env"), join(root, "private/engine.env"));
  const content = readFileSync(join(root, "tama/compose.yaml"), "utf8")
    .replace(/^ {2}tama:$/mu, "  engine:")
    .replaceAll("./.tama.env", "../private/engine.env")
    .replaceAll("./.tama.postgres.env", "../tama/.tama.postgres.env");
  writeFileSync(join(root, "deploy/runtime.yaml"), content);
  writeFileSync(join(root, "deploy/root.yaml"), "include:\n  - ./runtime.yaml\n");
  writeFileSync(
    join(root, "deploy/override.yaml"),
    "services:\n  engine:\n    image: example/custom-tama:v2\n",
  );
  unlinkSync(join(root, "tama/.tama-kit.json"));
  const before = snapshot(root);
  const plan = inspectCurrentConfiguration({
    cwd: root,
    composeFiles: ["deploy/root.yaml", "deploy/override.yaml"],
    service: "engine",
    environmentFile: "private/engine.env",
  });
  assert.equal(plan.tamaImage, "example/custom-tama:v2");
  assert.equal(plan.runtime.environmentFile, join(root, "private/engine.env"));
  assert.deepEqual(composeUpArguments(plan), [
    "compose",
    "-f",
    join(root, "deploy/root.yaml"),
    "-f",
    join(root, "deploy/override.yaml"),
    "up",
    "-d",
    "engine",
  ]);
  let args;
  probeComposeProviderEndpoint(plan, "http://127.0.0.1:3000/metadata", (_command, input) => {
    args = input;
    return "200";
  });
  assert.deepEqual(args.slice(0, 8), [
    "compose",
    "-f",
    join(root, "deploy/root.yaml"),
    "-f",
    join(root, "deploy/override.yaml"),
    "exec",
    "-T",
    "engine",
  ]);
  assert.deepEqual(snapshot(root), before);
});

test("MCP inspection reads current bindings; activation and recovery preserve keys and unrelated edits", async () => {
  const { root } = mcp();
  unlinkSync(join(root, "tama/.tama-kit.json"));
  const current = inspectCurrentConfiguration({ cwd: root });
  const providerPath = join(root, current.mcpApp.provider.environmentFile);
  const providerBefore = contentDigest(readFileSync(providerPath, "utf8"));
  const path = current.runtime.modeSource.path;
  const original = readFileSync(path, "utf8");
  const change = planTamaModeChange(current);
  await applyOperationsTransactionally([change.operation], () => {});
  writeFileSync(path, `${readFileSync(path, "utf8")}\n# developer edit during verification\n`);
  await applyOperationsTransactionally([change.restore()], () => {});
  assert.equal(
    contentDigest(readFileSync(path, "utf8")),
    contentDigest(`${original}\n# developer edit during verification\n`),
  );
  assert.equal(contentDigest(readFileSync(providerPath, "utf8")), providerBefore);
  assert.equal(existsSync(join(root, "tama/.tama-kit.json")), false);
});

test("setup dry-run activation reports only preview progress and preserves both mode files", async () => {
  const { root } = mcp();
  const before = snapshot(root);
  for (const args of [["--dry-run"], ["--dry-run", "--activate"]]) {
    const response = await command(root, "setup", ...args, "--json");
    assert.equal(response.code, 0, JSON.stringify(response.result));
    assert.equal(response.result.setup.phase, "planned");
    assert.equal(response.result.started, false);
    assert.equal(response.result.setup.runtimeVerified, false);
    assert.equal(response.result.setup.runtimeHealth, "not-checked");
    assert.deepEqual(
      response.result.setup.nextActions.map(({ id }) => id),
      ["review-and-prepare"],
    );
    assert.deepEqual(snapshot(root), before);
  }
});

test("disabled MCP integrations still validate current provider configuration", async () => {
  const { root, plan } = mcp();
  const environmentPath = join(root, "tama/.tama.env");
  writeFileSync(
    environmentPath,
    readFileSync(environmentPath, "utf8").replace(
      "TAMA_MCP_APP_MODE=prepared",
      "TAMA_MCP_APP_MODE=disabled",
    ),
  );
  assert.equal(inspectCurrentConfiguration({ cwd: root }).mcpApp.lifecycle, "disabled");
  const providerPath = join(root, plan.mcpApp.provider.environmentFile);
  writeFileSync(providerPath, "# missing provider keys and bindings\n");
  const before = snapshot(root);
  for (const args of [["doctor"], ["setup", "--dry-run"]]) {
    const response = await command(root, ...args, "--json");
    assert.equal(response.code, 4, JSON.stringify(response.result));
    assert.deepEqual(snapshot(root), before);
  }
});

test("the default MCP contract requires validation even without an effective mode", async () => {
  const { root } = mcp();
  const path = join(root, "tama/.tama.env");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^TAMA_MCP_APP_MODE=.*\n/mu, ""));
  const before = snapshot(root);
  const response = await command(root, "doctor", "--json");
  assert.equal(response.code, 4, JSON.stringify(response.result));
  assert.deepEqual(snapshot(root), before);
});

test("a concurrent mode edit blocks recovery without overwriting developer configuration", async () => {
  const { root } = mcp();
  const plan = inspectCurrentConfiguration({ cwd: root });
  const change = planTamaModeChange(plan);
  await applyOperationsTransactionally([change.operation], () => {});
  const path = plan.runtime.modeSource.path;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("TAMA_MCP_APP_MODE=enabled", "TAMA_MCP_APP_MODE=disabled"),
  );
  const before = contentDigest(readFileSync(path, "utf8"));
  assert.throws(change.restore, /mode was edited/);
  assert.equal(contentDigest(readFileSync(path, "utf8")), before);
});

test("shadowed lifecycle sources require explicit manual editing; inspection never reports them writable", () => {
  const { root } = mcp();
  writeFileSync(
    join(root, "override.yaml"),
    "services:\n  tama:\n    environment:\n      TAMA_MCP_APP_MODE: prepared\n",
  );
  const plan = inspectCurrentConfiguration({
    cwd: root,
    composeFiles: ["compose.yaml", "override.yaml"],
  });
  assert.equal(plan.runtime.modeSource, undefined);
  assert.throws(() => planTamaModeChange(plan), /no single safely editable/);
});

test("doctor fails missing secrets and inconsistent public identities without leaking their values", async () => {
  const { root } = mcp();
  const path = join(root, "tama/.tama.env");
  const content = readFileSync(path, "utf8");
  writeFileSync(
    path,
    content.replace(
      /^TAMA_MCP_APP_AUTHORIZATION_SERVER=.*$/mu,
      "TAMA_MCP_APP_AUTHORIZATION_SERVER=https://private-identity.example",
    ),
  );
  const response = await command(root, "doctor", "--json");
  assert.equal(response.code, 4);
  assert.doesNotMatch(JSON.stringify(response), /private-identity|"d":/);
  unlinkSync(path);
  const before = snapshot(root);
  const missing = await command(root, "doctor", "--json");
  assert.equal(missing.code, 4);
  assert.deepEqual(snapshot(root), before);
});

test("unfinished generation requires its operation ID and resumes only pending destinations", async () => {
  const root = temporaryDirectory("tama-resume-command-");
  assert.equal((await command(root, "bootstrap", "--json")).code, 0);
  const path = join(root, "tama/.tama-kit.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  receipt.progress = { status: "incomplete", pendingDestinations: ["tama/README.md"] };
  writeFileSync(path, `${JSON.stringify(receipt)}\n`);
  unlinkSync(join(root, "tama/README.md"));
  writeFileSync(join(root, "tama/AGENTS.md"), "project instructions changed after interruption\n");
  const original = snapshot(root).filter(([name]) => name !== path);
  assert.equal((await command(root, "bootstrap", "--json")).code, 4);
  assert.equal((await command(root, "bootstrap", "--resume", "wrong-id", "--json")).code, 4);
  const result = await command(root, "bootstrap", "--resume", receipt.operation.id, "--json");
  assert.equal(result.code, 0, JSON.stringify(result.result));
  assert.deepEqual(
    snapshot(root).filter(([name]) => name !== path && name !== join(root, "tama/README.md")),
    original,
  );
  assert.equal(JSON.parse(readFileSync(path, "utf8")).progress.status, "complete");
});

for (const [flag, value, pending] of [
  ["--port", "4567", ["tama/compose.yaml", "tama/.tama.env.example", "tama/README.md"]],
  ["--image", "ghcr.io/upmaru/tama:99.0.0-server", ["tama/README.md"]],
]) {
  test(`resume rejects changed ${flag} without writing pending files or completing its receipt`, async () => {
    const root = standard();
    const path = join(root, "tama/.tama-kit.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.progress = { status: "incomplete", pendingDestinations: pending };
    writeFileSync(path, JSON.stringify(receipt));
    for (const destination of pending) unlinkSync(join(root, destination));
    const before = snapshot(root);
    const response = await command(
      root,
      "bootstrap",
      "--resume",
      receipt.operation.id,
      flag,
      value,
      "--json",
    );
    assert.equal(response.code, 4, JSON.stringify(response.result));
    assert.match(response.result.error.message, /original generation options/);
    assert.deepEqual(snapshot(root), before);
    const resumed = await command(root, "bootstrap", "--resume", receipt.operation.id, "--json");
    assert.equal(resumed.code, 0, JSON.stringify(resumed.result));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).progress.status, "complete");
  });
}

test("bootstrap compatibility setup dry-run cannot start services or edit activation mode", async () => {
  const root = standard();
  const before = snapshot(root);
  const result = await command(root, "bootstrap", "--start", "--dry-run", "--json");
  assert.equal(result.code, 2);
  assert.match(result.result.error.message, /--start cannot be combined with --dry-run/);
  assert.deepEqual(snapshot(root), before);
});

test("current contract supports relocated provider fragments and customized endpoint paths", () => {
  const { root } = mcp();
  const path = join(root, "tama/contracts/mcp-app-provider-v1.json");
  const contract = JSON.parse(readFileSync(path, "utf8"));
  mkdirSync(join(root, "private"));
  renameSync(join(root, contract.provider.environment_file), join(root, "private/provider.env"));
  contract.provider.environment_file = "private/provider.env";
  contract.public_endpoints.introspection = "/oauth/token/status";
  writeFileSync(path, JSON.stringify(contract));
  const env = join(root, "tama/.tama.env");
  writeFileSync(
    env,
    readFileSync(env, "utf8").replaceAll("/auth/introspections", "/oauth/token/status"),
  );
  const before = snapshot(root);
  const plan = inspectCurrentConfiguration({ cwd: root });
  assert.equal(plan.mcpApp.provider.environmentFile, "private/provider.env");
  assert.equal(plan.mcpApp.localContract.public_endpoints.introspection, "/oauth/token/status");
  assert.deepEqual(snapshot(root), before);
});

test("setup excludes the provider from automatic Compose startup and recreation", () => {
  const { root } = mcp();
  const contract = JSON.parse(
    readFileSync(join(root, "tama/contracts/mcp-app-provider-v1.json"), "utf8"),
  );
  writeFileSync(
    join(root, "provider.yaml"),
    `services:\n  application:\n    image: node:24-alpine\n    env_file: [./${contract.provider.environment_file}]\n`,
  );
  const plan = inspectCurrentConfiguration({
    cwd: root,
    composeFiles: ["compose.yaml", "provider.yaml"],
  });
  assert.equal(plan.mcpApp.environmentLoading, "verified");
  const args = composeUpArguments(plan);
  assert.ok(args.includes("--no-deps"));
  assert.ok(args.includes("tama"));
  assert.ok(args.includes("tama-postgres"));
  assert.equal(args.includes("application"), false);
});

test("generation journaling refuses a receipt that arrived after the reviewed plan", async () => {
  const { writeScaffold } = await import("../../cli/workflows/scaffold-write.mjs");
  const root = temporaryDirectory("tama-receipt-race-");
  const plan = createBootstrapPlan({
    cwd: root,
    skillMode: "manual",
    generationId: "reviewed-id",
  });
  mkdirSync(join(root, "tama"));
  const path = join(root, "tama/.tama-kit.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      generator: "Generated by Tama Kit",
      operation: { id: "concurrent-operation", kind: "bootstrap" },
      progress: { status: "complete" },
    }),
  );
  const before = snapshot(root);
  await assert.rejects(
    writeScaffold(plan, () => {}),
    { category: "ownership" },
  );
  assert.deepEqual(snapshot(root), before);
});

// Reproduce Compose 2.x's ToProject path discarding declarations despite the flag.
function legacyCompose(command, args, options) {
  return execFileSync(
    command,
    args.includes("--no-interpolate")
      ? args
      : args.filter((argument) => argument !== "--no-env-resolution"),
    options,
  );
}

test("legacy Compose declaration fallback preserves mode-source and provider ownership evidence", () => {
  const { root } = mcp();
  const contract = JSON.parse(
    readFileSync(join(root, "tama/contracts/mcp-app-provider-v1.json"), "utf8"),
  );
  writeFileSync(
    join(root, "provider.yaml"),
    `services:\n  application:\n    image: node:24-alpine\n    env_file: [./${contract.provider.environment_file}]\n`,
  );
  const options = {
    cwd: root,
    composeFiles: ["compose.yaml", "provider.yaml"],
    environmentFile: "tama/.tama.env",
  };
  const before = snapshot(root);
  const plan = inspectCurrentConfiguration(options, legacyCompose);
  assert.equal(plan.runtime.modeSource.path, join(root, "tama/.tama.env"));
  assert.equal(plan.mcpApp.environmentLoading, "verified");
  assert.equal(composeUpArguments(plan).includes("application"), false);
  assert.deepEqual(snapshot(root), before);
  writeFileSync(
    join(root, "shadow.yaml"),
    "services:\n  tama:\n    environment:\n      TAMA_MCP_APP_MODE: prepared\n",
  );
  const shadowed = inspectCurrentConfiguration(
    { ...options, composeFiles: [...options.composeFiles, "shadow.yaml"] },
    legacyCompose,
  );
  assert.equal(shadowed.runtime.modeSource, undefined);
});

test("legacy Compose fallback diagnoses unresolved env_file interpolation without guessing a path", () => {
  const root = standard();
  const path = join(root, "tama/compose.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("./.tama.env", `\${TAMA_ENV_FILE:-./.tama.env}`),
  );
  const before = snapshot(root);
  assert.throws(
    () => inspectCurrentConfiguration({ cwd: root }, legacyCompose),
    (error) =>
      error.category === "prerequisite" && /interpolated env_file paths/.test(error.message),
  );
  assert.deepEqual(snapshot(root), before);
});

test("current inspection and activation validate absolute secret paths inside a Git worktree", async () => {
  const { root } = mcp();
  execFileSync("git", ["init", "--quiet", root]);
  const plan = inspectCurrentConfiguration({ cwd: root });
  const change = planTamaModeChange(plan);
  await applyOperationsTransactionally([change.operation], () => {});
  await applyOperationsTransactionally([change.restore()], () => {});
  execFileSync("git", ["-C", root, "add", "--force", "tama/.tama.env"]);
  assert.throws(() => inspectCurrentConfiguration({ cwd: root }), /tracked by Git/);
  execFileSync("git", ["-C", root, "rm", "--cached", "--force", "tama/.tama.env"]);
  const ignore = join(root, "tama/.gitignore");
  writeFileSync(ignore, `${readFileSync(ignore, "utf8")}\n!.tama.env\n`);
  assert.throws(() => inspectCurrentConfiguration({ cwd: root }), /not effectively ignored/);
});
