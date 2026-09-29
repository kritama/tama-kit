import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateMcpAppContract } from "../../cli/bootstrap/mcp-app-contract.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import {
  classifyEnvironmentReference,
  environmentCommand,
  environmentPreflight,
  missingEnvironmentDiagnosis,
} from "../../cli/domain/environment.mjs";
import { run } from "../../cli/index.mjs";
import { contentDigest } from "../../cli/shared/files.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import { memoveeContract, planWithMcp, preparedFor, writeContract } from "../helpers/mcp-app.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

/** @param {string[]} args @param {string} [cwd] */
async function command(args, cwd) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(args, {
    cwd: cwd ?? process.cwd(),
    interactive: false,
    color: false,
    columns: 100,
    write: () => {},
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function standardRoot() {
  const root = temporaryDirectory("tama-env-");
  applyOperations(createBootstrapPlan({ cwd: root, skillMode: "manual" }).operations);
  return root;
}

function mcpFixture() {
  const root = temporaryDirectory("tama-env-mcp-");
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

function snapshot(root) {
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) entries.push(...snapshot(path));
    else {
      const stat = statSync(path);
      entries.push([path, contentDigest(readFileSync(path, "utf8")), stat.mode]);
    }
  }
  return entries;
}

test("env doctor reconstructs the required-file diagnosis from current declarations", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const before = snapshot(root);
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  assert.equal(document.ok, false);
  assert.equal(document.mode, "inspect");
  assert.deepEqual(document.changes, []);
  assert.deepEqual(document.persistence, { status: "not-checked" });
  const byRole = Object.fromEntries(document.files.map((file) => [file.role, file]));
  assert.equal(byRole.core.status, "missing");
  assert.equal(byRole.core.required, true);
  assert.equal(byRole.core.source, "compose");
  assert.equal(byRole.postgres.status, "missing");
  assert.match(result.stdout, /tama\/.tama\.env/u);
  assert.match(document.nextActions.join("\n"), /Restore tama\/\.tama\.env/u);
  assert.deepEqual(snapshot(root), before);
});

test("env doctor reports a healthy standard runtime and remaining manual work", async () => {
  const root = standardRoot();
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(document.ok, true);
  for (const file of document.files) assert.equal(file.status, "valid");
  assert.match(document.nextActions.join("\n"), /TAMA_CLIENT_ID and TAMA_CLIENT_SECRET/u);
  const password = readFileSync(join(root, "tama/.tama.env"), "utf8").match(
    /^POSTGRES_PASSWORD=(.*)$/mu,
  )?.[1];
  assert.ok(password && !result.stdout.includes(password));
});

test("env doctor never rewrites invalid existing files and diagnoses them", async () => {
  const root = standardRoot();
  const envPath = join(root, "tama/.tama.env");
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}\nPORT=4000\n`);
  const before = snapshot(root);
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  const core = document.files.find((file) => file.role === "core");
  assert.equal(core.status, "invalid");
  assert.match(core.issues.join("\n"), /duplicate/u);
  assert.deepEqual(snapshot(root), before);
});

test("env doctor flags unsafe permissions without repairing them", async () => {
  const root = standardRoot();
  const envPath = join(root, "tama/.tama.env");
  chmodSync(envPath, 0o644);
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  const core = document.files.find((file) => file.role === "core");
  assert.equal(core.status, "invalid");
  assert.match(core.issues.join("\n"), /chmod 600/u);
  assert.equal(statSync(envPath).mode & 0o777, 0o644);
});

test("env doctor separates core and PostgreSQL credential agreement", async () => {
  const root = standardRoot();
  const envPath = join(root, "tama/.tama.postgres.env");
  const content = readFileSync(envPath, "utf8");
  const user = content.match(/^POSTGRES_USER=(.*)$/mu)?.[1];
  writeFileSync(envPath, content.replace(`POSTGRES_USER=${user}`, `POSTGRES_USER=someone-else`));
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  const postgres = document.files.find((file) => file.role === "postgres");
  assert.equal(postgres.status, "invalid");
  assert.match(postgres.issues.join("\n"), /POSTGRES_USER disagrees/u);
});

test("env doctor reports the contract provider fragment and incomplete receipts", async () => {
  const { root } = mcpFixture();
  const fragment = join(root, "tama/.memovee.integration.env");
  rmSync(fragment);
  const receipt = join(root, "tama/.tama-kit.json");
  const value = JSON.parse(readFileSync(receipt, "utf8"));
  value.progress = { status: "incomplete", pendingDestinations: ["tama/.tama.env"] };
  writeFileSync(receipt, JSON.stringify(value));
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  const provider = document.files.find((file) => file.role === "provider");
  assert.equal(provider.source, "contract");
  assert.equal(provider.required, true);
  assert.equal(provider.status, "missing");
  assert.match(document.warnings.join("\n"), /incomplete generation/u);
  assert.match(document.warnings.join("\n"), /bootstrap --resume/u);
  assert.match(document.nextActions.join("\n"), /Resume the interrupted generation/u);
});

test("env doctor survives malformed receipts and invalid contracts with warnings", async () => {
  const root = standardRoot();
  writeFileSync(join(root, "tama/.tama-kit.json"), "{ not json");
  mkdirSync(join(root, "tama/contracts"), { recursive: true });
  // A provider contract in the local contract slot fails local validation.
  writeFileSync(
    join(root, "tama/contracts/mcp-app-provider-v1.json"),
    JSON.stringify(memoveeContract()),
  );
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.match(document.warnings.join("\n"), /could not be read/u);
  assert.match(document.warnings.join("\n"), /local MCP App contract is invalid/u);
  assert.equal(
    document.files.find((file) => file.role === "provider"),
    undefined,
  );
});

test("env doctor treats optional declarations as informational and never auto-created", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.yaml"),
    `# Generated by Tama Kit. Application services may be added alongside this include.\ninclude:\n  - ./tama/compose.yaml\nservices:\n  app:\n    image: node:24-alpine\n    env_file:\n      - path: tama/.optional.env\n        required: false\n`,
  );
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  const optional = document.files.find((file) => file.relative === "tama/.optional.env");
  assert.equal(optional.status, "optional-absent");
  assert.match(document.nextActions.join("\n"), /optional files are never auto-created/u);
  assert.ok(!existsSync(join(root, "tama/.optional.env")));
});

test("env doctor classifies unknown application files for manual restoration", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.yaml"),
    `# Generated by Tama Kit. Application services may be added alongside this include.\ninclude:\n  - ./tama/compose.yaml\nservices:\n  app:\n    image: node:24-alpine\n    env_file:\n      - path: .app.env\n`,
  );
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  const app = document.files.find((file) => file.relative === ".app.env");
  assert.equal(app.status, "unsupported");
  assert.match(document.nextActions.join("\n"), /project template or provider documentation/u);
});

test("env doctor reports unresolved interpolation instead of guessing paths", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.yaml"),
    `# Generated by Tama Kit. Application services may be added alongside this include.\ninclude:\n  - ./tama/compose.yaml\nservices:\n  app:\n    image: node:24-alpine\n    env_file:\n      - path: \${TAMA_ENV_DIR}/extra.env\n`,
  );
  const result = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.match(document.warnings.join("\n"), /unresolved interpolation/u);
});

test("setup and doctor preflight name the missing files and preserve the selection", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  for (const name of ["setup", "doctor"]) {
    const human = await command([name, "--service", "tama", "--non-interactive"], root);
    assert.equal(human.exitCode, 4, name);
    assert.match(human.stderr, /Missing required private environment files:/u);
    assert.match(human.stderr, /tama\/.tama\.env/u);
    assert.match(human.stderr, /tama-kit env doctor.*--service tama/u);
    const machine = await command([name, "--service", "tama", "--json", "--non-interactive"], root);
    assert.equal(machine.exitCode, 4, name);
    const document = JSON.parse(machine.stdout);
    assert.equal(document.ok, false);
    assert.equal(document.error.category, "ownership");
    assert.deepEqual(document.error.missingEnvironmentFiles, [
      "tama/.tama.env",
      "tama/.tama.postgres.env",
    ]);
    assert.deepEqual(document.error.suggestedCommands, ["tama-kit env doctor --service tama"]);
  }
});

test("setup preflight does not mask unrelated configuration failures", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.yaml"),
    'services:\n  tama:\n    image: ghcr.io/upmaru/tama:latest\n    ports: ["not-a-port"]\n',
  );
  const result = await command(["setup", root, "--json", "--non-interactive"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, false);
  assert.equal(document.error.missingEnvironmentFiles, undefined);
  assert.match(document.error.message, /could not be resolved/u);
});

test("env help and unknown subcommands are usage errors without writes", async () => {
  const root = standardRoot();
  const before = snapshot(root);
  const help = await command(["env", "--help"], root);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /env <subcommand>/u);
  const unknown = await command(["env", "rotate", root], root);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /unknown env command/u);
  assert.deepEqual(snapshot(root), before);
});

test("domain classification and preflight keep supported roles separate from application files", () => {
  assert.equal(classifyEnvironmentReference(".tama.env"), "core");
  assert.equal(classifyEnvironmentReference(".tama.postgres.env"), "postgres");
  assert.equal(classifyEnvironmentReference(".mcp-app.env"), "mcp-app");
  assert.equal(
    classifyEnvironmentReference(".memovee.integration.env", ".memovee.integration.env"),
    "provider",
  );
  assert.equal(classifyEnvironmentReference(".app.env", ".memovee.integration.env"), "application");
  const references = [
    {
      role: "core",
      path: "/p/tama/.tama.env",
      relative: "tama/.tama.env",
      services: ["tama"],
      required: true,
      source: "compose",
    },
    {
      role: "application",
      path: "/p/.app.env",
      relative: ".app.env",
      services: ["app"],
      required: true,
      source: "compose",
    },
    {
      role: "core",
      path: "/p/tama/.optional.env",
      relative: "tama/.optional.env",
      services: ["tama"],
      required: false,
      source: "compose",
    },
  ];
  const finding = environmentPreflight(references, (path) => path === "/p/tama/.optional.env");
  assert.deepEqual(
    finding.missing.map((reference) => reference.relative),
    ["tama/.tama.env"],
  );
  assert.deepEqual(
    finding.missingUnsupported.map((reference) => reference.relative),
    [".app.env"],
  );
  assert.deepEqual(finding.missingOptional, []);
  const diagnosis = missingEnvironmentDiagnosis(finding, { service: "tama" });
  assert.match(diagnosis.message, /tama\/.tama\.env/u);
  assert.match(diagnosis.message, /tama-kit env doctor --service tama/u);
  assert.equal(
    environmentCommand("doctor", { targetPath: "app", compose: ["a.yaml", "b.yaml"] }),
    "tama-kit env doctor app --compose a.yaml --compose b.yaml",
  );
});
