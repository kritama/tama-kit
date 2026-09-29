import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    assert.match(human.stderr, /tama-kit env init.*--service tama/u);
    const machine = await command([name, "--service", "tama", "--json", "--non-interactive"], root);
    assert.equal(machine.exitCode, 4, name);
    const document = JSON.parse(machine.stdout);
    assert.equal(document.ok, false);
    assert.equal(document.error.category, "ownership");
    assert.deepEqual(document.error.missingEnvironmentFiles, [
      "tama/.tama.env",
      "tama/.tama.postgres.env",
    ]);
    assert.deepEqual(document.error.suggestedCommands, [
      "tama-kit env doctor --service tama",
      "tama-kit env init --service tama",
    ]);
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

import { postgresEnvironment } from "../../cli/bootstrap/environment.mjs";
import { findPostgresDataSources } from "../../cli/bootstrap/persistence.mjs";
import { runEnvironmentInit } from "../../cli/workflows/environment.mjs";

function fakeDocker(options = {}) {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    // Compose resolution stays real; only Docker state is faked.
    if (args[0] === "compose") {
      return execFileSync("docker", args, { encoding: "utf8", cwd: process.cwd() });
    }
    if (args[0] === "version") {
      if (options.daemonDown) {
        const error = new Error("cannot connect to the Docker daemon");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return "Docker version 29.4.0";
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (options.volumeExists && options.volumeNames.includes(args[2])) {
        return JSON.stringify([{ Name: args[2] }]);
      }
      const error = new Error(`no such volume: ${args[2]}`);
      error.code = "ERR_DOCKER";
      throw error;
    }
    if (args[0] === "ps") return "";
    return "";
  };
  return { execute, calls };
}

test("env init restores a missing derived Postgres file while preserving the core", async () => {
  const root = standardRoot();
  const coreDigest = contentDigest(readFileSync(join(root, "tama/.tama.env"), "utf8"));
  const corePassword = readFileSync(join(root, "tama/.tama.env"), "utf8").match(
    /^POSTGRES_PASSWORD=(.*)$/mu,
  )?.[1];
  rmSync(join(root, "tama/.tama.postgres.env"));
  const result = await command(["env", "init", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(document.ok, true);
  assert.equal(document.mode, "write");
  assert.deepEqual(document.persistence, {
    status: "not-required",
    freshAsserted: false,
    detail: "no new secrets are issued",
    checked: [],
  });
  const byPath = Object.fromEntries(document.files.map((file) => [file.relative, file]));
  assert.equal(byPath["tama/.tama.env"].action, "preserve");
  assert.equal(byPath["tama/.tama.env"].created, false);
  assert.equal(byPath["tama/.tama.postgres.env"].action, "create");
  assert.equal(byPath["tama/.tama.postgres.env"].created, true);
  assert.equal(byPath["tama/.tama.postgres.env"].issuance, "derived");
  assert.deepEqual(document.changes, [
    { action: "create", relative: "tama/.tama.postgres.env", sensitive: true },
  ]);
  assert.match(document.nextActions.join("\n"), /tama-kit setup/u);
  // The surviving core is untouched and the companion derives its credentials.
  assert.equal(contentDigest(readFileSync(join(root, "tama/.tama.env"), "utf8")), coreDigest);
  const restored = readFileSync(join(root, "tama/.tama.postgres.env"), "utf8");
  assert.match(restored, new RegExp(`^POSTGRES_PASSWORD="${corePassword}"$`, "m"));
  assert.equal(statSync(join(root, "tama/.tama.postgres.env")).mode & 0o777, 0o600);
  // Re-running is a no-op.
  const again = await command(["env", "init", root, "--json"], root);
  const againDoc = JSON.parse(again.stdout);
  assert.equal(again.exitCode, 0);
  assert.deepEqual(againDoc.changes, []);
  for (const file of againDoc.files) assert.equal(file.action, "preserve");
});

test("env init --dry-run reports the plan without writing anything", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.postgres.env"));
  const before = snapshot(root);
  const result = await command(["env", "init", root, "--dry-run", "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(document.ok, true);
  assert.equal(document.mode, "dry-run");
  const planned = document.files.find((file) => file.relative === "tama/.tama.postgres.env");
  assert.equal(planned.action, "create");
  assert.equal(planned.created, false);
  assert.deepEqual(document.changes, [
    { action: "create", relative: "tama/.tama.postgres.env", sensitive: true },
  ]);
  assert.deepEqual(snapshot(root), before);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), false);
});

test("env init blocks on unsupported or unrepairable required files without writing", async () => {
  const root = standardRoot();
  const originalCompose = readFileSync(join(root, "compose.yaml"), "utf8");
  // Unsupported missing file...
  writeFileSync(
    join(root, "compose.yaml"),
    "services:\n  app:\n    image: app\n    env_file:\n      - tama/app.env\n      - tama/.tama.env\n",
  );
  const before = snapshot(root);
  const unsupported = await command(["env", "init", root, "--json"], root);
  const unsupportedDoc = JSON.parse(unsupported.stdout);
  assert.equal(unsupported.exitCode, 4);
  assert.equal(unsupportedDoc.ok, false);
  assert.match(unsupportedDoc.blockers.join("\n"), /tama\/app\.env is not a Tama-owned file/u);
  assert.deepEqual(snapshot(root), before);
  // ...and an invalid required file.
  writeFileSync(join(root, "compose.yaml"), originalCompose);
  writeFileSync(join(root, "tama/.tama.postgres.env"), "POSTGRES_USER=a\nPOSTGRES_USER=b\n");
  const invalid = await command(["env", "init", root, "--json"], root);
  const invalidDoc = JSON.parse(invalid.stdout);
  assert.equal(invalid.exitCode, 4);
  assert.equal(invalidDoc.ok, false);
  assert.match(invalidDoc.blockers.join("\n"), /repair tama\/.tama\.postgres\.env/u);
});

test("env init refuses MCP App recovery until the MCP recovery renderer exists", async () => {
  const { root } = mcpFixture();
  rmSync(join(root, "tama/.memovee.integration.env"));
  const before = snapshot(root);
  const result = await command(["env", "init", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  assert.equal(document.ok, false);
  assert.match(
    document.blockers.join("\n"),
    /requires reissued provider and introspection signing material/u,
  );
  assert.match(document.blockers.join("\n"), /generate mcp-app/u);
  assert.deepEqual(snapshot(root), before);
  const provider = document.files.find((file) => file.source === "contract");
  assert.equal(provider.relative, "tama/.memovee.integration.env");
  assert.equal(provider.action, "preserve");
});

test("env init issues a fresh standard runtime when persistence is verifiably absent", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const docker = fakeDocker();
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    { execute: docker.execute },
  );
  assert.equal(result.ok, true);
  assert.equal(result.persistence.status, "absent");
  assert.ok(docker.calls.some((args) => args[0] === "volume"));
  for (const file of result.files) assert.equal(file.created, true);
  const core = readFileSync(join(root, "tama/.tama.env"), "utf8");
  const password = core.match(/^POSTGRES_PASSWORD=(.*)$/mu)?.[1];
  assert.ok(password);
  const companion = readFileSync(join(root, "tama/.tama.postgres.env"), "utf8");
  assert.match(companion, new RegExp(`^POSTGRES_PASSWORD="${password}"$`, "m"));
  assert.equal(statSync(join(root, "tama/.tama.env")).mode & 0o777, 0o600);
});

test("env init refuses new issuance when persisted state is detected, even with --fresh", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: true },
    {
      execute: fakeDocker({
        volumeExists: true,
        volumeNames: ["tama-postgres-data", "env-smoke_tama-postgres-data"],
      }).execute,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.persistence.status, "detected");
  assert.equal(result.persistence.freshAsserted, false);
  assert.match(result.blockers.join("\n"), /new secret issuance is refused/u);
  for (const file of result.files) assert.equal(file.created, false);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), false);
});

test("env init requires --fresh for an unverifiable persistence state and records the assertion", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const blocked = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    { execute: fakeDocker({ daemonDown: true }).execute },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.persistence.status, "unknown");
  assert.match(blocked.blockers.join("\n"), /pass --fresh/u);
  const issued = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: true, fresh: false },
    { execute: fakeDocker({ daemonDown: true }).execute },
  );
  assert.equal(issued.ok, false);
  assert.equal(issued.mode, "dry-run");
  // A blocked dry run reports the blocker and plans no writes.
  assert.ok(issued.blockers.length > 0);
  assert.deepEqual(issued.changes, []);
  for (const file of issued.files) assert.equal(file.action, "preserve");
  const created = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: true },
    { execute: fakeDocker({ daemonDown: true }).execute },
  );
  assert.equal(created.ok, true);
  assert.equal(created.persistence.status, "unknown");
  assert.equal(created.persistence.freshAsserted, true);
  assert.match(created.nextActions.join("\n"), /confirm the local database is empty/u);
  for (const file of created.files) assert.equal(file.created, true);
});

test("env init reconstructs a missing core from surviving Postgres credentials without new secrets", async () => {
  const root = standardRoot();
  const core = readFileSync(join(root, "tama/.tama.env"), "utf8");
  const user = core.match(/^POSTGRES_USER=(.*)$/mu)?.[1];
  const password = core.match(/^POSTGRES_PASSWORD=(.*)$/mu)?.[1];
  const database = core.match(/^POSTGRES_DB=(.*)$/mu)?.[1];
  const vaultKey = core.match(/^TAMA_VAULT_KEY=(.*)$/mu)?.[1];
  rmSync(join(root, "tama/.tama.env"));
  const docker = fakeDocker();
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    { execute: docker.execute },
  );
  assert.equal(result.ok, true);
  // A missing core is a new issuance (vault/JWT material), so persistence was checked.
  assert.equal(result.persistence.status, "absent");
  const recreated = readFileSync(join(root, "tama/.tama.env"), "utf8");
  assert.match(recreated, new RegExp(`^POSTGRES_USER=${user}$`, "m"));
  assert.match(recreated, new RegExp(`^POSTGRES_PASSWORD=${password}$`, "m"));
  assert.match(recreated, new RegExp(`^POSTGRES_DB=${database}$`, "m"));
  assert.match(
    recreated,
    new RegExp(`^DATABASE_URL=ecto://${user}:${password}@tama-postgres/${database}$`, "m"),
  );
  const companion = readFileSync(join(root, "tama/.tama.postgres.env"), "utf8");
  assert.equal(
    companion,
    postgresEnvironment(
      new Map([
        ["POSTGRES_USER", user],
        ["POSTGRES_PASSWORD", password],
        ["POSTGRES_DB", database],
      ]),
      "tama/.tama.postgres.env",
    ),
  );
  // The core owns the vault/JWT material, so it is a new issuance that
  // preserves the surviving database credentials rather than a pure derivation.
  assert.equal(result.files.find((file) => file.role === "core")?.issuance, "new");
  assert.equal(existsSync(join(root, "tama/.tama.env")), true);
  // A fresh TAMA_VAULT_KEY is expected because the core (the key owner) was lost.
  const newKey = recreated.match(/^TAMA_VAULT_KEY=(.*)$/mu)?.[1];
  assert.notEqual(newKey, vaultKey);
});

test("findPostgresDataSources probes verbatim and legacy volume names", () => {
  const service = {
    name: "db",
    volumes: [{ type: "volume", source: "db-data", target: "/var/lib/postgresql/data" }],
  };
  const model = { name: "myapp", volumes: { "db-data": {} } };
  const found = findPostgresDataSources(model, { db: service });
  assert.deepEqual(found, {
    service: "db",
    volumes: [{ source: "db-data", names: ["db-data", "myapp_db-data"] }],
    binds: [],
  });
  const external = findPostgresDataSources(
    { name: "myapp", volumes: { "db-data": { external: { name: "shared-db" } } } },
    { db: service },
  );
  assert.deepEqual(external?.volumes, [
    { source: "db-data", names: ["shared-db", "db-data", "myapp_db-data"] },
  ]);
  assert.equal(
    findPostgresDataSources(
      { name: "myapp", volumes: {} },
      {
        app: { name: "app", volumes: [{ type: "volume", source: "cache", target: "/cache" }] },
      },
    ),
    null,
  );
});
