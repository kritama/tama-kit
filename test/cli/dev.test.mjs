import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyOperations } from "../../cli/bootstrap/write.mjs";
import { createDevSetupPlan } from "../../cli/dev/plan.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";

function tamaProject() {
  const root = mkdtempSync(join(tmpdir(), "tama-kit-dev-"));
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
  assert.equal(first.environment.get("POSTGRES_HOST"), "127.0.0.1");
  assert.equal(first.environment.get("POSTGRES_TEST_HOSTNAME"), "127.0.0.1");
  assert.equal(first.environment.get("POSTGRES_PORT"), "55432");
  assert.equal(first.environment.get("POSTGRES_TEST_PORT"), "55432");
  assert.equal(first.environment.get("TAMA_MAX_VECTOR_DIMENSIONS"), "1024");
  assert.equal(first.environment.get("TAMA_TEST_MAX_CASES"), "16");
  applyOperations(first.operations);

  assert.equal(statSync(join(root, ".envrc")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".tama.dev.postgres.env")).mode & 0o777, 0o600);
  const before = readFileSync(join(root, ".envrc"), "utf8");
  const postgresEnvironment = readFileSync(join(root, ".tama.dev.postgres.env"), "utf8");
  assert.match(postgresEnvironment, /^POSTGRES_PASSWORD=.+$/mu);
  assert.doesNotMatch(postgresEnvironment, /TAMA_VAULT_KEY|TAMA_SETUP_TOKEN/u);

  const second = createDevSetupPlan({ cwd: root, targetPath: root });
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  applyOperations(second.operations);
  assert.equal(readFileSync(join(root, ".envrc"), "utf8"), before);
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
  const exitCode = await run(["dev", "setup", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message = "") => output.push(message),
    stderr: () => {},
    interactive: false,
    color: false,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(existsSync(join(root, ".envrc")), false);
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.postgres.host, "127.0.0.1");
  assert.equal(payload.postgres.port, 55432);
  assert.equal(payload.postgres.containerPort, 5432);
  assert.equal(payload.databaseStarted, false);
  assert.doesNotMatch(output.join("\n"), /TAMA_SETUP_TOKEN|POSTGRES_PASSWORD|setup\/root/u);
});

test("dev setup prepare-only writes secrets without invoking Docker or Mix", async () => {
  const root = tamaProject();
  const output = [];
  const exitCode = await run(["dev", "setup", root, "--prepare-only", "--no-color"], {
    cwd: root,
    stdout: (message = "") => output.push(message),
    stderr: () => {},
    interactive: false,
    color: false,
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.ok(existsSync(join(root, ".envrc")));
  assert.match(output.join("\n"), /Private setup URL:/u);
  assert.match(output.join("\n"), /tama-kit dev setup/u);
});

test("dev setup rejects non-Tama Phoenix repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "tama-kit-not-tama-"));
  assert.throws(
    () => createDevSetupPlan({ cwd: root, targetPath: root }),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.USAGE,
  );
});
