import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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
import { run } from "../../cli/index.mjs";
import { contentDigest } from "../../cli/shared/files.mjs";
import { applyOperationsTransactionally } from "../../cli/shared/write.mjs";
import { planTamaModeChange } from "../../cli/workflows/activation.mjs";
import { memoveeContract, writeContract } from "../helpers/mcp-app.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

const image = "ghcr.io/upmaru/tama:0.13.2-server";
const http = [
  "--provider-name",
  "example",
  "--provider-origin",
  "http://host.docker.internal:4100",
  "--allowed-origin",
  "http://localhost:4000",
];
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
async function standard() {
  const root = temporaryDirectory("tama-add-mcp-");
  const response = await command(root, "bootstrap", "--image", image, "--json");
  assert.equal(response.code, 0, JSON.stringify(response.result));
  return root;
}
function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? snapshot(path)
      : [[path, contentDigest(readFileSync(path, "utf8")), statSync(path).mode]];
  });
}
const generate = (root, ...args) => command(root, "generate", "mcp-app", ...args, "--json");

for (const source of ["flag", "contract"]) {
  test(`external provider fragments from a ${source} are rejected before writes`, async () => {
    const root = await standard();
    let args;
    if (source === "flag") {
      args = [...http, "--provider-env-file", "config/acme.env"];
    } else {
      const contract = memoveeContract();
      contract.provider.environment_file = "config/acme.env";
      contract.environment_loading.loads = "config/acme.env";
      args = ["--mcp-app-contract", writeContract(root, contract)];
    }
    const before = snapshot(root);
    for (const mode of [[], ["--dry-run"]]) {
      const result = await generate(root, ...args, ...mode);
      assert.equal(result.code, 2, JSON.stringify(result.result));
      assert.match(result.result.error.message, /must be inside the Tama directory/);
      assert.deepEqual(snapshot(root), before);
    }
  });
}

test("additive generation accepts a missing optional baseline environment file", async () => {
  const root = await standard();
  writeFileSync(
    join(root, "optional.yaml"),
    "services:\n  tama:\n    env_file:\n      - path: ./optional.env\n        required: false\n",
  );
  const selection = ["--compose", "compose.yaml", "--compose", "optional.yaml"];
  const before = snapshot(root);
  const preview = await generate(root, ...http, ...selection, "--dry-run");
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.deepEqual(snapshot(root), before);
  const generated = await generate(root, ...http, ...selection);
  assert.equal(generated.code, 0, JSON.stringify(generated.result));
  assert.equal(
    inspectCurrentConfiguration({
      cwd: root,
      composeFiles: ["compose.yaml", "optional.yaml", "tama/compose.mcp-app.yaml"],
    }).mcpApp.lifecycle,
    "prepared",
  );
});

test("additive HTTP generation preserves original scaffold and supports current setup and native Compose", async () => {
  const root = await standard();
  writeFileSync(join(root, "tama/versions.tf"), "# custom provider selection\n");
  unlinkSync(join(root, "tama/main.tf"));
  const before = snapshot(root).filter(([path]) => !path.endsWith("/.gitignore"));
  const preview = await generate(root, ...http, "--dry-run");
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(preview.result.generation.status, "planned");
  assert.deepEqual(
    snapshot(root).filter(([path]) => !path.endsWith("/.gitignore")),
    before,
  );
  const response = await generate(root, ...http);
  assert.equal(response.code, 0, JSON.stringify(response.result));
  const after = snapshot(root);
  for (const entry of before)
    assert.deepEqual(
      after.find(([path]) => path === entry[0]),
      entry,
    );
  for (const name of ["setup", "activate", "doctor"])
    assert.ok(response.result.commands[name].includes("--env-file 'tama/.tama.env'"));
  const guidance = await command(
    root,
    "doctor",
    "--compose",
    "compose.yaml",
    "--compose",
    "tama/compose.mcp-app.yaml",
    "--env-file",
    "tama/.tama.env",
    "--json",
  );
  assert.equal(guidance.code, 0, JSON.stringify(guidance.result));
  const rootSetup = guidance.result.setup.nextActions.find(
    ({ id }) => id === "complete-root-setup",
  );
  assert.ok(rootSetup.description.includes(join(root, "tama/.tama.env")));
  assert.ok(!rootSetup.description.includes(".mcp-app.env"));
  assert.equal(response.result.setup.runtimeVerified, false);
  assert.doesNotMatch(JSON.stringify(response.result), /PRIVATE_KEY|"d":|pending-secret/);
  const selected = { cwd: root, composeFiles: ["compose.yaml", "tama/compose.mcp-app.yaml"] };
  const plan = inspectCurrentConfiguration(selected);
  assert.equal(plan.mcpApp.lifecycle, "prepared");
  assert.equal(plan.runtime.modeSource.path, join(root, "tama/.mcp-app.env"));
  const setup = await command(
    root,
    "setup",
    "--compose",
    "compose.yaml",
    "--compose",
    "tama/compose.mcp-app.yaml",
    "--dry-run",
    "--json",
  );
  assert.equal(setup.code, 0, JSON.stringify(setup.result));
  execFileSync(
    "docker",
    ["compose", "-f", "compose.yaml", "-f", "tama/compose.mcp-app.yaml", "config", "--quiet"],
    { cwd: root },
  );
  // Completed history is never a repair authority, even after output is changed/deleted.
  writeFileSync(join(root, "tama/MCP_APP.md"), "developer docs\n");
  unlinkSync(join(root, "tama/compose.mcp-app.yaml"));
  const edited = snapshot(root);
  assert.equal((await generate(root)).result.generation.status, "existing");
  assert.deepEqual(snapshot(root), edited);
});

test("core env-file selection leaves separate activation mode discovery unambiguous", async () => {
  const root = await standard();
  assert.equal((await generate(root, ...http)).code, 0);
  const composeFiles = ["compose.yaml", "tama/compose.mcp-app.yaml"];
  const environmentFile = "tama/.tama.env";
  const corePath = join(root, environmentFile);
  const core = readFileSync(corePath, "utf8");
  const selection = { cwd: root, composeFiles, environmentFile };
  const plan = inspectCurrentConfiguration(selection);
  assert.equal(plan.runtime.environmentFile, corePath);
  assert.equal(plan.runtime.modeSource.path, join(root, "tama/.mcp-app.env"));
  const before = snapshot(root);
  const preview = await command(
    root,
    "setup",
    "--dry-run",
    "--activate",
    "--compose",
    composeFiles[0],
    "--compose",
    composeFiles[1],
    "--env-file",
    environmentFile,
    "--json",
  );
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(preview.result.setup.phase, "planned");
  assert.deepEqual(snapshot(root), before);
  const change = planTamaModeChange(plan);
  await applyOperationsTransactionally([change.operation], () => {});
  assert.equal(readFileSync(corePath, "utf8"), core);
  assert.deepEqual(
    snapshot(root).filter(([path]) => path !== change.operation.path),
    before.filter(([path]) => path !== change.operation.path),
  );
  assert.equal(inspectCurrentConfiguration(selection).mcpApp.lifecycle, "enabled");
  await applyOperationsTransactionally([change.restore()], () => {});
  assert.deepEqual(snapshot(root), before);

  // Explicit selection must not bypass either multiple mode files or inline shadowing.
  writeFileSync(corePath, `${core}\nTAMA_MCP_APP_MODE=prepared\n`);
  const ambiguous = inspectCurrentConfiguration(selection);
  assert.equal(ambiguous.runtime.modeSource, undefined);
  assert.throws(() => planTamaModeChange(ambiguous), /no single safely editable/);
  writeFileSync(corePath, core);
  writeFileSync(
    join(root, "shadow.yaml"),
    "services:\n  tama:\n    environment:\n      TAMA_MCP_APP_MODE: prepared\n",
  );
  const shadowed = inspectCurrentConfiguration({
    ...selection,
    composeFiles: [...composeFiles, "shadow.yaml"],
  });
  assert.equal(shadowed.runtime.modeSource, undefined);
  assert.throws(() => planTamaModeChange(shadowed), /no single safely editable/);
});

test("conflicts, unsupported actions, and shadowed environment fail before writing", async () => {
  const root = await standard();
  writeFileSync(join(root, "tama/MCP_APP.md"), "developer content\n");
  const before = snapshot(root);
  assert.notEqual((await generate(root, ...http)).code, 0);
  assert.deepEqual(snapshot(root), before);
  for (const flag of ["--start", "--activate", "--migrate-local-https"])
    assert.equal((await generate(root, flag)).code, 2);
  unlinkSync(join(root, "tama/MCP_APP.md"));
  writeFileSync(
    join(root, "shadow.yaml"),
    "services:\n  tama:\n    environment:\n      TAMA_MCP_APP_MODE: disabled\n",
  );
  const shadowed = snapshot(root);
  const result = await generate(
    root,
    ...http,
    "--compose",
    "compose.yaml",
    "--compose",
    "shadow.yaml",
    "--dry-run",
  );
  assert.notEqual(result.code, 0);
  assert.match(result.result.error.message, /requires its current local contract/);
  assert.deepEqual(snapshot(root), shadowed);
});

test("selection supports renamed services, relocated secrets, absent bootstrap receipt and ordered overrides", async () => {
  const root = await standard();
  mkdirSync(join(root, "private"));
  renameSync(join(root, "tama/.tama.env"), join(root, "private/engine.env"));
  writeFileSync(join(root, ".gitignore"), "/private/\n");
  const runtime = join(root, "tama/compose.yaml");
  writeFileSync(
    runtime,
    readFileSync(runtime, "utf8")
      .replace(/^ {2}tama:$/mu, "  engine:")
      .replace("./.tama.env", "../private/engine.env"),
  );
  writeFileSync(join(root, "override.yaml"), `services:\n  engine:\n    image: ${image}\n`);
  unlinkSync(join(root, "tama/.tama-kit.json"));
  const response = await generate(
    root,
    ...http,
    "--service",
    "engine",
    "--env-file",
    "private/engine.env",
    "--compose",
    "compose.yaml",
    "--compose",
    "override.yaml",
  );
  assert.equal(response.code, 0, JSON.stringify(response.result));
  assert.match(response.result.commands.setup, /override.yaml.*compose.mcp-app.yaml/);
  for (const name of ["setup", "activate", "doctor"])
    assert.ok(response.result.commands[name].includes("--env-file 'private/engine.env'"));
  const guidance = await command(
    root,
    "doctor",
    "--compose",
    "compose.yaml",
    "--compose",
    "override.yaml",
    "--compose",
    "tama/compose.mcp-app.yaml",
    "--service",
    "engine",
    "--env-file",
    "private/engine.env",
    "--json",
  );
  assert.equal(guidance.code, 0, JSON.stringify(guidance.result));
  assert.ok(
    guidance.result.setup.nextActions
      .find(({ id }) => id === "complete-root-setup")
      .description.includes(join(root, "private/engine.env")),
  );

  assert.equal(
    inspectCurrentConfiguration({
      cwd: root,
      composeFiles: ["compose.yaml", "override.yaml", "tama/compose.mcp-app.yaml"],
      service: "engine",
    }).mcpApp.lifecycle,
    "prepared",
  );
});

test("explicit resume preserves existing additions and keys and creates only pending output", async () => {
  const root = await standard();
  assert.equal((await generate(root, ...http)).code, 0);
  const receiptPath = join(root, "tama/.tama-kit-mcp-app.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.progress = { status: "incomplete", pendingDestinations: ["tama/MCP_APP.md"] };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  unlinkSync(join(root, "tama/MCP_APP.md"));
  const keys = readFileSync(join(root, "tama/.mcp-app.env"), "utf8");
  const before = snapshot(root);
  assert.notEqual((await generate(root, ...http)).code, 0);
  assert.deepEqual(snapshot(root), before);
  const response = await generate(root, ...http, "--resume", receipt.operation.id);
  assert.equal(response.code, 0, JSON.stringify(response.result));
  assert.equal(readFileSync(join(root, "tama/.mcp-app.env"), "utf8"), keys);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).progress.status, "complete");
});

test("HTTPS preview preserves original ports and keys on disk and describes override destinations", async () => {
  const root = await standard();
  const before = snapshot(root);
  const response = await generate(root, "--provider-name", "example", "--dry-run");
  assert.equal(response.code, 0, JSON.stringify(response.result));
  assert.ok(response.result.changes.some(({ path }) => path.endsWith("/tama/Caddyfile")));
  assert.deepEqual(snapshot(root), before);
});

test("a negated secret ignore rolls back the entire addition including its receipt", async () => {
  const root = await standard();
  mkdirSync(join(root, "tama/contracts"));
  writeFileSync(
    join(root, "tama/.gitignore"),
    `${readFileSync(join(root, "tama/.gitignore"), "utf8")}!/.mcp-app.env\n`,
  );
  // A later scoped ignore can defeat an otherwise present top-level ignore.
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, ".git/info/exclude"), "");
  // Keep a literal positive entry above the negation, so generation must validate Git semantics.
  const path = join(root, "tama/.gitignore");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("!/.mcp-app.env", "/.mcp-app.env\n!/.mcp-app.env"),
  );
  const before = snapshot(root);
  const result = await generate(root, ...http);
  assert.notEqual(result.code, 0);
  assert.deepEqual(snapshot(root), before);
});

test("JSON generation never prompts even when an interactive IO is available", async () => {
  const root = await standard();
  const output = [];
  assert.equal(
    await run(["generate", "mcp-app", ...http, "--dry-run", "--json"], {
      cwd: root,
      interactive: true,
      prompt() {
        throw new Error("must not prompt");
      },
      stdout: (value) => output.push(value),
      stderr: (value) => output.push(value),
    }),
    0,
  );
  assert.equal(JSON.parse(output.at(-1)).generation.status, "planned");
});
