import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { formatComposeUpCommand } from "../../cli/bootstrap/compose-command.mjs";
import {
  applyOperations,
  applyOperationsTransactionally,
} from "../../cli/bootstrap/write.mjs";
import { inspectProject } from "../../cli/bootstrap/detect-project.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";

function project(prefix = "tama-kit-bootstrap-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function planFor(root, extra = {}) {
  return createBootstrapPlan({ cwd: root, targetPath: root, ...extra });
}

test("bootstrap creates a private, idempotent generic project scaffold", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);

  assert.equal(first.framework, "generic");
  assert.equal(first.terraform.foundation, "created");
  assert.ok(existsSync(join(root, "compose.yaml")));
  assert.ok(existsSync(join(root, "tama", "compose.yaml")));
  assert.ok(existsSync(join(root, "tama", "main.tf")));
  assert.match(readFileSync(join(root, "tama", "main.tf"), "utf8"), /module "global"/u);
  assert.equal(statSync(join(root, ".tama.env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".tama.postgres.env")).mode & 0o777, 0o600);
  const postgresEnvironment = readFileSync(join(root, ".tama.postgres.env"), "utf8");
  assert.match(postgresEnvironment, /^POSTGRES_PASSWORD=.+$/mu);
  assert.doesNotMatch(postgresEnvironment, /TAMA_SETUP_TOKEN|SECRET_KEY_BASE/u);

  const secretBefore = readFileSync(join(root, ".tama.env"), "utf8");
  const second = planFor(root);
  assert.equal(second.terraform.foundation, "preserved");
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  applyOperations(second.operations);
  assert.equal(readFileSync(join(root, ".tama.env"), "utf8"), secretBefore);
});

test("dry-run reports and bootstrap repairs unsafe sensitive-file permissions", async () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const environmentFile = join(root, ".tama.env");
  chmodSync(environmentFile, 0o644);

  const output = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message) => output.push(message),
    stderr: () => {},
  });
  const payload = JSON.parse(output.join("\n"));
  const environmentChange = payload.changes.find(
    (change) => change.path === environmentFile,
  );

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(environmentChange.action, "update");
  assert.equal(statSync(environmentFile).mode & 0o777, 0o644);

  applyOperations(planFor(root).operations);
  assert.equal(statSync(environmentFile).mode & 0o777, 0o600);
});

test("framework detection distinguishes Rails, Phoenix, and Node projects", () => {
  const rails = project("tama-kit-rails-");
  mkdirSync(join(rails, "config"));
  writeFileSync(join(rails, "Gemfile"), 'gem "rails"\n');
  writeFileSync(join(rails, "config", "application.rb"), "class Application end\n");
  assert.equal(inspectProject({ cwd: rails, targetPath: rails }).framework, "rails");

  const phoenix = project("tama-kit-phoenix-");
  mkdirSync(join(phoenix, "config"));
  writeFileSync(join(phoenix, "mix.exs"), "defp deps, do: [{:phoenix, \"~> 1.8\"}]\n");
  writeFileSync(join(phoenix, "config", "config.exs"), "import Config\n");
  assert.equal(inspectProject({ cwd: phoenix, targetPath: phoenix }).framework, "phoenix");

  const node = project("tama-kit-node-");
  writeFileSync(join(node, "package.json"), JSON.stringify({ dependencies: { next: "latest" } }));
  const nodeInspection = inspectProject({ cwd: node, targetPath: node });
  assert.equal(nodeInspection.framework, "node");
  assert.ok(nodeInspection.frameworkEvidence.includes("Next.js dependency detected"));
});

test("bootstrap preserves an existing Compose comment and adds one include", () => {
  const root = project();
  writeFileSync(
    join(root, "compose.yaml"),
    "# application compose\nservices:\n  web:\n    image: example/web:1\n",
  );
  const first = planFor(root);
  applyOperations(first.operations);
  const content = readFileSync(join(root, "compose.yaml"), "utf8");
  assert.match(content, /# application compose/u);
  assert.match(content, /- \.\/tama\/compose\.yaml/u);

  const second = planFor(root);
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  assert.equal((content.match(/\.\/tama\/compose\.yaml/gu) ?? []).length, 1);
});

test("bootstrap preserves permissions when updating a user-owned Compose file", () => {
  const root = project();
  const composeFile = join(root, "compose.yaml");
  writeFileSync(composeFile, "services: {}\n");
  chmodSync(composeFile, 0o600);

  const plan = planFor(root);
  applyOperations(plan.operations);

  assert.equal(statSync(composeFile).mode & 0o777, 0o600);
});

test("bootstrap rolls back every file change when post-write validation fails", async () => {
  const root = project();
  const composeFile = join(root, "compose.yaml");
  const original = "services: {}\n";
  writeFileSync(composeFile, original);
  chmodSync(composeFile, 0o600);
  const plan = planFor(root);

  await assert.rejects(
    () =>
      applyOperationsTransactionally(plan.operations, () => {
        throw new Error("invalid integrated Compose configuration");
      }),
    /invalid integrated Compose configuration/u,
  );

  assert.equal(readFileSync(composeFile, "utf8"), original);
  assert.equal(statSync(composeFile).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, ".tama.env")), false);
  assert.equal(existsSync(join(root, "tama")), false);
});

test("bootstrap resolves a managed include relative to a nested Compose file", () => {
  const root = project();
  mkdirSync(join(root, "deploy"));
  writeFileSync(join(root, "deploy", "compose.yaml"), "services: {}\n");

  const first = planFor(root, { composePath: "deploy/compose.yaml" });
  applyOperations(first.operations);
  assert.match(
    readFileSync(join(root, "deploy", "compose.yaml"), "utf8"),
    /- \.\.\/tama\/compose\.yaml/u,
  );
  assert.ok(
    readFileSync(join(root, "tama", "README.md"), "utf8").includes(
      formatComposeUpCommand("deploy/compose.yaml"),
    ),
  );
  assert.doesNotMatch(
    readFileSync(join(root, "tama", "README.md"), "utf8"),
    new RegExp(root, "u"),
  );

  const second = planFor(root, { composePath: "deploy/compose.yaml" });
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap rejects ambiguous Compose roots and unmanaged service collisions", () => {
  const ambiguous = project();
  writeFileSync(join(ambiguous, "compose.yaml"), "services: {}\n");
  writeFileSync(join(ambiguous, "docker-compose.yml"), "services: {}\n");
  assert.throws(
    () => planFor(ambiguous),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.AMBIGUITY,
  );

  const collision = project();
  writeFileSync(join(collision, "compose.yaml"), "services:\n  tama:\n    image: example/tama\n");
  assert.throws(
    () => planFor(collision),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap preserves an existing global foundation address", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "foundation.tf"),
    [
      'module "foundation" {',
      '  source  = "upmaru/base/tama"',
      '  version = "0.5.5"',
      "}",
      "",
    ].join("\n"),
  );
  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "preserved");
  assert.ok(!plan.operations.some((operation) => operation.path.endsWith("main.tf")));
});

test("bootstrap preserves a Tama foundation declared in root Terraform JSON", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "foundation.tf.json"),
    `${JSON.stringify(
      {
        module: {
          foundation: {
            source: "upmaru/base/tama",
            version: "0.5.5",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "preserved");
  assert.ok(!plan.operations.some((operation) => operation.path.endsWith("main.tf")));
});

test("bootstrap does not mistake an unrelated module.global for Tama's foundation", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    'module "global" {\n  source = "terraform-aws-modules/vpc/aws"\n  version = "6.0.1"\n}\n',
  );

  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap ignores nested source attributes when identifying a Terraform module", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    [
      'module "other" {',
      "  settings = {",
      '    source = "upmaru/base/tama"',
      "  }",
      '  source = "./other"',
      "}",
      "",
    ].join("\n"),
  );

  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap ignores Tama foundation modules inside HCL comments", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    [
      "/*",
      'module "retired" {',
      '  source  = "upmaru/base/tama"',
      '  version = "0.5.5"',
      "}",
      "*/",
      'resource "null_resource" "example" {}',
      "",
    ].join("\n"),
  );

  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap ignores global foundations declared only in nested Terraform modules", () => {
  const root = project();
  mkdirSync(join(root, "tama", "modules", "unused"), { recursive: true });
  writeFileSync(join(root, "tama", "main.tf"), 'resource "null_resource" "example" {}\n');
  writeFileSync(
    join(root, "tama", "modules", "unused", "main.tf"),
    'module "global" {\n  source = "upmaru/base/tama"\n  version = "0.5.6"\n}\n',
  );

  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap refuses unknown ownership in an existing Terraform root", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", "main.tf"), 'resource "null_resource" "example" {}\n');
  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("JSON dry-run writes nothing and never exposes generated secrets", async () => {
  const root = project();
  const output = [];
  const errors = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.deepEqual(errors, []);
  assert.equal(existsSync(join(root, ".tama.env")), false);
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.changes.find((change) => change.path.endsWith(".tama.env")).sensitive, true);
  assert.doesNotMatch(output.join("\n"), /POSTGRES_PASSWORD|TAMA_SETUP_TOKEN=/u);
});

test("JSON failures use the stable error envelope", async () => {
  const root = project();
  writeFileSync(join(root, "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "compose.yml"), "services: {}\n");
  const output = [];
  const errors = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  });
  assert.equal(exitCode, EXIT_CODES.AMBIGUITY);
  assert.deepEqual(errors, []);
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.category, "ambiguity");
});

test("an explicit port updates public local URLs without rotating secrets", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const before = readFileSync(join(root, ".tama.env"), "utf8");
  const setupToken = before.match(/^TAMA_SETUP_TOKEN=(.+)$/mu)[1];

  const second = planFor(root, { port: 4567 });
  applyOperations(second.operations);
  const after = readFileSync(join(root, ".tama.env"), "utf8");
  assert.match(after, /^TAMA_PORT=4567$/mu);
  assert.match(after, /^TAMA_BASE_URL=http:\/\/localhost:4567$/mu);
  assert.match(after, new RegExp(`^TAMA_SETUP_TOKEN=${setupToken}$`, "mu"));
  assert.match(readFileSync(join(root, "tama", "compose.yaml"), "utf8"), /"4567:4000"/u);
});

test("bootstrap rejects an invalid persisted port instead of silently changing it", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(/^TAMA_PORT=4000$/mu, "TAMA_PORT=invalid"),
  );
  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap rejects a persisted internal port that disagrees with Compose", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(/^PORT=4000$/mu, "PORT=5000"),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variable === "PORT",
  );
});

test("bootstrap rejects persisted public URLs that disagree with TAMA_PORT", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(/^TAMA_PORT=4000$/mu, "TAMA_PORT=4567"),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variables.includes("TAMA_BASE_URL"),
  );
});

test("bootstrap rejects missing required variables in a persisted environment", () => {
  for (const name of ["DATABASE_URL", "SECRET_KEY_BASE", "TAMA_VAULT_KEY"]) {
    const root = project();
    const first = planFor(root);
    applyOperations(first.operations);
    const filename = join(root, ".tama.env");
    writeFileSync(
      filename,
      readFileSync(filename, "utf8").replace(new RegExp(`^${name}=.*$`, "mu"), `${name}=`),
    );

    assert.throws(
      () => planFor(root),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.OWNERSHIP &&
        error.details.variables.includes(name),
    );
  }
});

test("bootstrap rejects duplicate keys in a persisted environment", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, ".tama.env");
  writeFileSync(
    filename,
    `${readFileSync(filename, "utf8")}TAMA_BASE_URL=http://localhost:4000\n`,
  );

  assert.throws(
    () => planFor(root, { port: 4567 }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variables.includes("TAMA_BASE_URL"),
  );
});

test("bootstrap rejects PostgreSQL credentials that disagree with DATABASE_URL", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      /^POSTGRES_PASSWORD=.*$/mu,
      "POSTGRES_PASSWORD=different-password",
    ),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variable === "DATABASE_URL",
  );
});

test("bootstrap appends ignore rules after a later secret-file negation", () => {
  const root = project();
  writeFileSync(join(root, ".gitignore"), ".tama.env\n!.tama.env\n");

  const first = planFor(root);
  applyOperations(first.operations);
  const content = readFileSync(join(root, ".gitignore"), "utf8");
  assert.ok(content.lastIndexOf(".tama.env") > content.lastIndexOf("!.tama.env"));

  const second = planFor(root);
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

test("the next-step command includes and safely quotes the selected Compose file", () => {
  assert.equal(
    formatComposeUpCommand("/tmp/tama project's/deploy/compose.yaml"),
    "docker compose -f '/tmp/tama project'\\''s/deploy/compose.yaml' up -d tama",
  );
});
