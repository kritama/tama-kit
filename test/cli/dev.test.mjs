import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDevSetupPlan } from "../../cli/dev/plan.mjs";
import { runTestFoundationSetup } from "../../cli/dev/start.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

function tamaProject() {
  const root = temporaryDirectory("tama-kit-dev-");
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "lib", "tama"), { recursive: true });
  writeFileSync(
    join(root, "mix.exs"),
    "defmodule Tama.MixProject do\n  use Mix.Project\n  def project, do: [app: :tama]\nend\n",
  );
  writeFileSync(join(root, "config", "dev.exs"), "import Config\n");
  writeFileSync(
    join(root, "lib", "tama", "application.ex"),
    "defmodule Tama.Application do\nend\n",
  );
  writeFileSync(
    join(root, "compose.yml"),
    [
      "name: tama-dev",
      "services:",
      "  postgres:",
      "    image: pgvector/pgvector:0.8.6-pg15-bookworm",
      "    env_file:",
      "      - .tama.dev.postgres.env",
      "",
    ].join("\n"),
  );
  return root;
}

test("development setup creates private idempotent Compose database environment", () => {
  const root = tamaProject();
  const first = createDevSetupPlan({ cwd: root, targetPath: root });

  assert.equal(first.postgresPort, 55432);
  assert.equal(first.tamaPort, 4001);
  assert.equal(first.environment.get("POSTGRES_HOST"), "127.0.0.1");
  assert.equal(first.environment.get("POSTGRES_TEST_HOSTNAME"), "127.0.0.1");
  assert.equal(first.environment.get("POSTGRES_PORT"), "55432");
  assert.equal(first.environment.get("POSTGRES_TEST_PORT"), "55432");
  assert.equal(first.environment.get("PORT"), "4001");
  assert.equal(first.environment.get("TAMA_MAX_VECTOR_DIMENSIONS"), "1024");
  assert.equal(first.environment.get("TAMA_TEST_MAX_CASES"), "16");
  applyOperations(first.operations);

  assert.equal(statSync(join(root, ".envrc")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".tama.dev.postgres.env")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\/\.envrc$/mu);
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\/\.tama\.dev\.postgres\.env$/mu);
  const before = readFileSync(join(root, ".envrc"), "utf8");
  const postgresEnvironment = readFileSync(join(root, ".tama.dev.postgres.env"), "utf8");
  assert.match(postgresEnvironment, /^POSTGRES_PASSWORD=.+$/mu);
  assert.doesNotMatch(postgresEnvironment, /TAMA_VAULT_KEY|TAMA_SETUP_TOKEN/u);

  const second = createDevSetupPlan({ cwd: root, targetPath: root });
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  applyOperations(second.operations);
  assert.equal(readFileSync(join(root, ".envrc"), "utf8"), before);
});

test("development setup appends secret ignores after later negations", () => {
  const root = tamaProject();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(
    join(root, ".gitignore"),
    ["/.envrc", "!/.envrc", "/.tama.dev.postgres.env", "!/.tama.dev.postgres.env", ""].join("\n"),
  );

  applyOperations(createDevSetupPlan({ cwd: root, targetPath: root }).operations);

  for (const secretFile of [".envrc", ".tama.dev.postgres.env"]) {
    assert.doesNotThrow(() =>
      execFileSync("git", ["check-ignore", "--quiet", "--no-index", secretFile], {
        cwd: root,
      }),
    );
  }
  const content = readFileSync(join(root, ".gitignore"), "utf8");
  assert.ok(content.lastIndexOf("/.envrc") > content.lastIndexOf("!/.envrc"));
  assert.ok(
    content.lastIndexOf("/.tama.dev.postgres.env") >
      content.lastIndexOf("!/.tama.dev.postgres.env"),
  );
  assert.equal((content.match(/# Tama Kit development environment/gu) ?? []).length, 1);
  assert.ok(
    createDevSetupPlan({ cwd: root, targetPath: root }).operations.every(
      (operation) => operation.action === "unchanged",
    ),
  );
});

test("development setup refuses private environment files already tracked by Git", () => {
  const root = tamaProject();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  applyOperations(createDevSetupPlan({ cwd: root, targetPath: root }).operations);
  execFileSync("git", ["add", "--force", ".envrc", ".tama.dev.postgres.env"], { cwd: root });

  assert.throws(
    () => createDevSetupPlan({ cwd: root, targetPath: root }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.paths.includes(".envrc") &&
      error.details.paths.includes(".tama.dev.postgres.env"),
  );
});

test("an existing test foundation does not require OpenTofu or mise on a rerun", async () => {
  const root = temporaryDirectory("tama-kit-dev-ready-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const command of ["tofu", "mise"]) {
    const filename = join(bin, command);
    writeFileSync(filename, "#!/bin/sh\nexit 1\n");
    chmodSync(filename, 0o755);
  }
  const mix = join(bin, "mix");
  writeFileSync(mix, "#!/bin/sh\nexit 0\n");
  chmodSync(mix, 0o755);
  writeFileSync(join(root, ".envrc"), `export PATH=${bin}:/bin\n`);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:/bin`;
  try {
    const result = await runTestFoundationSetup(
      /** @type {import("../../cli/types.mjs").DevSetupPlan} */ ({
        root,
        environment: new Map(),
      }),
      { quiet: true },
    );
    assert.equal(result, "preserved");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("development setup upgrades an older generated environment without rotating secrets", () => {
  const root = tamaProject();
  const first = createDevSetupPlan({ cwd: root, targetPath: root });
  applyOperations(first.operations);
  const filename = join(root, ".envrc");
  const before = readFileSync(filename, "utf8").replace(
    "export TAMA_MAX_VECTOR_DIMENSIONS=1024\nexport TAMA_TEST_MAX_CASES=16\n",
    "",
  );
  writeFileSync(filename, before);

  const upgraded = createDevSetupPlan({ cwd: root, targetPath: root });
  applyOperations(upgraded.operations);
  const after = readFileSync(filename, "utf8");

  assert.match(after, /^export TAMA_MAX_VECTOR_DIMENSIONS=1024$/mu);
  assert.match(after, /^export TAMA_TEST_MAX_CASES=16$/mu);
  assert.equal(
    after.match(/^export TAMA_VAULT_KEY=(.+)$/mu)[1],
    before.match(/^export TAMA_VAULT_KEY=(.+)$/mu)[1],
  );
});

test("development setup changes only database ports and preserves secrets", () => {
  const root = tamaProject();
  const first = createDevSetupPlan({ cwd: root, targetPath: root });
  applyOperations(first.operations);
  const before = readFileSync(join(root, ".envrc"), "utf8");
  const vaultKey = before.match(/^export TAMA_VAULT_KEY=(.+)$/mu)[1];
  const setupToken = before.match(/^export TAMA_SETUP_TOKEN=(.+)$/mu)[1];

  const changed = createDevSetupPlan({ cwd: root, targetPath: root, postgresPort: 55433 });
  applyOperations(changed.operations);
  const after = readFileSync(join(root, ".envrc"), "utf8");
  assert.match(after, /^export POSTGRES_PORT=55433$/mu);
  assert.match(after, /^export POSTGRES_TEST_PORT=55433$/mu);
  assert.equal(after.match(/^export TAMA_VAULT_KEY=(.+)$/mu)[1], vaultKey);
  assert.equal(after.match(/^export TAMA_SETUP_TOKEN=(.+)$/mu)[1], setupToken);
});

test("development setup changes only the Tama port and preserves secrets", () => {
  const root = tamaProject();
  applyOperations(createDevSetupPlan({ cwd: root, targetPath: root }).operations);
  const filename = join(root, ".envrc");
  const before = readFileSync(filename, "utf8");

  const changed = createDevSetupPlan({ cwd: root, targetPath: root, tamaPort: 4567 });
  applyOperations(changed.operations);
  const after = readFileSync(filename, "utf8");

  assert.equal(changed.tamaPort, 4567);
  assert.equal(after, before.replace(/^export PORT=.*$/mu, "export PORT=4567"));
  assert.match(after, /^export POSTGRES_PORT=55432$/mu);
  assert.match(after, /^export POSTGRES_TEST_PORT=55432$/mu);
  assert.ok(
    createDevSetupPlan({ cwd: root, targetPath: root, tamaPort: 4567 }).operations.every(
      (operation) => operation.action === "unchanged",
    ),
  );
});

test("development setup preserves an existing Tama port when no override is supplied", () => {
  const root = tamaProject();
  applyOperations(createDevSetupPlan({ cwd: root, targetPath: root }).operations);
  const filename = join(root, ".envrc");
  const existing = readFileSync(filename, "utf8").replace(/^export PORT=.*$/mu, "export PORT=4000");
  writeFileSync(filename, existing);

  const preserved = createDevSetupPlan({ cwd: root, targetPath: root });

  assert.equal(preserved.tamaPort, 4000);
  assert.ok(preserved.operations.every((operation) => operation.action === "unchanged"));
});

test("development setup rejects a loopback port collision before writing", () => {
  const root = tamaProject();

  assert.throws(
    () =>
      createDevSetupPlan({
        cwd: root,
        targetPath: root,
        tamaPort: 55432,
        postgresPort: 55432,
      }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /different loopback ports/u.test(error.message),
  );
  assert.equal(existsSync(join(root, ".envrc")), false);
});

test("development setup refuses an environment that can select host PostgreSQL", () => {
  const root = tamaProject();
  const first = createDevSetupPlan({ cwd: root, targetPath: root });
  applyOperations(first.operations);
  const filename = join(root, ".envrc");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      "export POSTGRES_HOST=127.0.0.1",
      "export POSTGRES_HOST=localhost",
    ),
  );

  assert.throws(
    () => createDevSetupPlan({ cwd: root, targetPath: root }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /must connect development and tests to Compose on 127\.0\.0\.1/u.test(error.message),
  );
});

test("dev setup dry-run JSON reports only public connection metadata", async () => {
  const root = tamaProject();
  const output = [];
  const exitCode = await run(
    ["dev", "setup", root, "--port", "4567", "--postgres-port", "55433", "--dry-run", "--json"],
    {
      cwd: root,
      stdout: (message = "") => output.push(message),
      stderr: () => {},
      interactive: false,
      color: false,
    },
  );

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(existsSync(join(root, ".envrc")), false);
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.postgres.host, "127.0.0.1");
  assert.equal(payload.postgres.port, 55433);
  assert.equal(payload.postgres.containerPort, 5432);
  assert.equal(payload.tamaPort, 4567);
  assert.equal(payload.databaseStarted, false);
  assert.doesNotMatch(output.join("\n"), /TAMA_SETUP_TOKEN|POSTGRES_PASSWORD|setup\/root/u);
});

test("dev setup prepare-only writes secrets without invoking Docker or Mix", async () => {
  const root = tamaProject();
  const output = [];
  const exitCode = await run(
    ["dev", "setup", root, "--port", "4567", "--prepare-only", "--no-color"],
    {
      cwd: root,
      stdout: (message = "") => output.push(message),
      stderr: () => {},
      interactive: false,
      color: false,
    },
  );

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.ok(existsSync(join(root, ".envrc")));
  assert.match(readFileSync(join(root, ".envrc"), "utf8"), /^export PORT=4567$/mu);
  assert.match(output.join("\n"), /Tama: native Phoenix at http:\/\/127\.0\.0\.1:4567/u);
  assert.match(output.join("\n"), /Private setup URL:/u);
  assert.match(output.join("\n"), /tama-kit dev setup/u);
});

test("dev setup reports named usage errors for invalid ports", async () => {
  const root = tamaProject();

  for (const [option, value, message] of [
    ["--port", "invalid", "port must be an integer"],
    ["--postgres-port", "65536", "postgres port must be between 1 and 65535"],
  ]) {
    const output = [];
    const exitCode = await run(["dev", "setup", root, option, value, "--json"], {
      cwd: root,
      stdout: (line = "") => output.push(line),
      stderr: () => {},
      interactive: false,
      color: false,
    });
    const payload = JSON.parse(output.join("\n"));

    assert.equal(exitCode, EXIT_CODES.USAGE);
    assert.match(payload.error.message, new RegExp(message, "u"));
    assert.equal(existsSync(join(root, ".envrc")), false);
  }
});

test("dev setup rejects non-Tama Phoenix repositories", () => {
  const root = temporaryDirectory("tama-kit-not-tama-");
  assert.throws(
    () => createDevSetupPlan({ cwd: root, targetPath: root }),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.USAGE,
  );
});
