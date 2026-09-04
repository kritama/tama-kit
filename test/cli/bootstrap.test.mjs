import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { formatAgentSetupPrompt } from "../../cli/bootstrap/agent-prompt.mjs";
import { formatComposeUpCommand } from "../../cli/bootstrap/compose-command.mjs";
import { inspectProject } from "../../cli/bootstrap/detect-project.mjs";
import { readSetupUrl } from "../../cli/bootstrap/environment.mjs";
import { contentDigest } from "../../cli/bootstrap/files.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/bootstrap/write.mjs";
import { CLIError, EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";

function project(prefix = "tama-kit-bootstrap-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function planFor(root, extra = {}) {
  return createBootstrapPlan({ cwd: root, targetPath: root, ...extra });
}

test("bootstrap help explains allowed origins and official versioned image tags", async () => {
  const output = [];
  const exitCode = await run(["bootstrap", "--help"], {
    cwd: project(),
    interactive: false,
    color: false,
    stdout: (message = "") => output.push(message),
    stderr: () => {},
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.match(output.join("\n"), /--allowed-origin.*HTTPS off loopback, max 32 unique/u);
  assert.match(output.join("\n"), /official versions use <version>-server; latest is unsuffixed/u);
});

test("bootstrap rejects an unsuffixed official version before Docker", () => {
  assert.throws(
    () => planFor(project(), { image: "ghcr.io/upmaru/tama:0.13.1" }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /missing the required -server suffix/u.test(error.message),
  );
  assert.equal(
    planFor(project(), { image: "ghcr.io/upmaru/tama:latest" }).tamaImage,
    "ghcr.io/upmaru/tama:latest",
  );
});

test("bootstrap creates a private, idempotent generic project scaffold", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);

  assert.equal(first.framework, "generic");
  assert.equal(first.terraform.foundation, "created");
  assert.ok(existsSync(join(root, "compose.yaml")));
  assert.ok(existsSync(join(root, "tama", "compose.yaml")));
  assert.ok(existsSync(join(root, "tama", ".tama-kit.json")));
  assert.ok(existsSync(join(root, "tama", "AGENTS.md")));
  assert.ok(existsSync(join(root, "tama", "main.tf")));
  assert.ok(existsSync(join(root, "tama", ".tama.env.example")));
  assert.equal(existsSync(join(root, ".tama.env")), false);
  assert.equal(existsSync(join(root, ".tama.postgres.env")), false);
  assert.equal(existsSync(join(root, ".tama.env.example")), false);
  const managedCompose = readFileSync(join(root, "tama", "compose.yaml"), "utf8");
  assert.match(managedCompose, /- \.\/\.tama\.env$/mu);
  assert.match(managedCompose, /- \.\/\.tama\.postgres\.env$/mu);
  assert.doesNotMatch(managedCompose, /\.\.\/\.tama/u);
  assert.match(readFileSync(join(root, "tama", "main.tf"), "utf8"), /module "global"/u);
  assert.equal(statSync(join(root, "tama", ".tama.env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "tama", ".tama.postgres.env")).mode & 0o777, 0o600);
  const postgresEnvironment = readFileSync(join(root, "tama", ".tama.postgres.env"), "utf8");
  assert.match(postgresEnvironment, /^POSTGRES_PASSWORD=.+$/mu);
  assert.doesNotMatch(postgresEnvironment, /TAMA_SETUP_TOKEN|SECRET_KEY_BASE/u);

  const secretBefore = readFileSync(join(root, "tama", ".tama.env"), "utf8");
  const setupToken = secretBefore.match(/^TAMA_SETUP_TOKEN=(.+)$/mu)[1];
  assert.equal(readSetupUrl(root), `http://localhost:4000/setup/root?token=${setupToken}`);
  const second = planFor(root);
  assert.equal(second.terraform.foundation, "preserved");
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
  applyOperations(second.operations);
  assert.equal(readFileSync(join(root, "tama", ".tama.env"), "utf8"), secretBefore);
});

test("bootstrap ignores legacy root dotenv files and keeps the nested example commit-safe", () => {
  const root = project();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const legacy = "TAMA_PORT=7777\nlegacy-user-content=true\n";
  writeFileSync(join(root, ".tama.env"), legacy);

  const plan = planFor(root);
  assert.equal(plan.port, 4000);
  applyOperations(plan.operations);

  assert.equal(readFileSync(join(root, ".tama.env"), "utf8"), legacy);
  assert.equal(
    spawnSync("git", ["check-ignore", "--no-index", "tama/.tama.env.example"], {
      cwd: root,
      encoding: "utf8",
    }).status,
    1,
  );
});

test("bootstrap installs complete repository-local agent skills when selected", () => {
  const root = project();
  const first = planFor(root, { skillMode: "local" });
  applyOperations(first.operations);

  assert.equal(first.skillMode, "local");
  assert.ok(existsSync(join(root, ".agents", "skills", "graph-builder", "SKILL.md")));
  assert.ok(
    existsSync(join(root, ".agents", "skills", "graph-builder", "references", "graph-contract.md")),
  );
  assert.ok(
    existsSync(
      join(root, ".agents", "skills", "graph-builder", "scripts", "inspect-tama-repository.mjs"),
    ),
  );
  assert.ok(existsSync(join(root, ".agents", "skills", "graph-audit", "SKILL.md")));
  assert.ok(existsSync(join(root, ".agents", "skills", "app-integration", "SKILL.md")));
  assert.ok(
    existsSync(
      join(root, ".agents", "skills", "app-integration", "references", "mcp-app-oauth.md"),
    ),
  );
  assert.ok(existsSync(join(root, ".agents", "skills", "tama-kit-cli", "SKILL.md")));
  assert.ok(
    existsSync(join(root, ".agents", "skills", "tama-kit-cli", "references", "cli-reference.md")),
  );

  const manifest = JSON.parse(readFileSync(join(root, "tama", ".tama-kit.json"), "utf8"));
  assert.equal(manifest.agentSkills, "local");
  assert.match(
    manifest.managedFiles[".agents/skills/graph-builder/SKILL.md"],
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.match(
    manifest.managedFiles[".agents/skills/app-integration/SKILL.md"],
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.match(
    manifest.managedFiles[".agents/skills/tama-kit-cli/SKILL.md"],
    /^sha256:[0-9a-f]{64}$/u,
  );

  const second = planFor(root, { skillMode: "local" });
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

for (const skillAncestor of [
  ".agents",
  join(".agents", "skills"),
  join(".agents", "skills", "graph-builder"),
]) {
  test(`bootstrap rejects a symbolic-link local skill ancestor at ${skillAncestor}`, () => {
    const root = project();
    const external = project("tama-kit-external-skills-");
    const ancestor = join(root, skillAncestor);
    mkdirSync(join(ancestor, ".."), { recursive: true });
    writeFileSync(join(external, "canary"), "do not modify\n");
    symlinkSync(external, ancestor, "dir");

    assert.throws(
      () => planFor(root, { skillMode: "local" }),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.OWNERSHIP &&
        /symbolic-link directory/u.test(error.message),
    );
    assert.equal(readFileSync(join(external, "canary"), "utf8"), "do not modify\n");
    assert.equal(existsSync(join(external, "SKILL.md")), false);
  });
}

test("interactive bootstrap prompts for local skills and renders colored progress", async () => {
  const root = project();
  const output = [];
  const writes = [];
  const questions = [];
  const exitCode = await run(["bootstrap", root, "--dry-run"], {
    cwd: root,
    interactive: true,
    color: true,
    prompt: async (question) => {
      questions.push(question);
      return "yes";
    },
    write: (message) => writes.push(message),
    stdout: (message) => output.push(message),
    stderr: () => {},
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /skills in this repository/u);
  assert.match(writes.join(""), /100%/u);
  assert.ok(writes.join("").includes("\u001b["));
  assert.match(output.join("\n"), /repository-local/u);
  assert.match(output.join("\n"), /\.agents\/skills\/graph-builder\/SKILL\.md/u);
});

test("manual skill choice prints self-install commands", async () => {
  const root = project();
  const output = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--no-color"], {
    cwd: root,
    interactive: true,
    color: true,
    prompt: async () => "no",
    write: () => {},
    stdout: (message) => output.push(message),
    stderr: () => {},
  });
  const text = output.join("\n");

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.match(text, /manual installation/u);
  assert.match(text, /npx skills add kritama\/tama-kit --agent codex --yes/u);
  assert.match(text, /codex plugin add tama-kit@upmaru/u);
  assert.equal(text.includes("\u001b["), false);
});

test("bootstrap reuses a recorded skill choice without prompting again", async () => {
  const root = project();
  applyOperations(planFor(root, { skillMode: "manual" }).operations);
  const output = [];
  const exitCode = await run(["bootstrap", root, "--dry-run"], {
    cwd: root,
    interactive: true,
    color: false,
    prompt: async () => {
      throw new Error("bootstrap should not prompt for a recorded choice");
    },
    write: () => {},
    stdout: (message) => output.push(message),
    stderr: () => {},
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.match(output.join("\n"), /manual installation/u);
});

test("JSON bootstrap accepts an explicit local skill mode without prompting", async () => {
  const root = project();
  const output = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json", "--skills", "local"], {
    cwd: root,
    interactive: true,
    color: true,
    prompt: async () => {
      throw new Error("JSON bootstrap must not prompt");
    },
    write: () => {
      throw new Error("JSON bootstrap must not render progress");
    },
    stdout: (message) => output.push(message),
    stderr: () => {},
  });
  const payload = JSON.parse(output.join("\n"));

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  assert.equal(payload.skillMode, "local");
  assert.ok(
    payload.changes.some((change) => change.path.endsWith(".agents/skills/graph-builder/SKILL.md")),
  );
  assert.ok(
    payload.changes.some((change) =>
      change.path.endsWith(".agents/skills/app-integration/SKILL.md"),
    ),
  );
  assert.ok(
    payload.changes.some((change) => change.path.endsWith(".agents/skills/tama-kit-cli/SKILL.md")),
  );
});

test("agent setup prompt covers runtime, private setup, Terraform validation, and apply approval", () => {
  const root = project();
  const composeFile = join(root, "docker compose.yaml");
  writeFileSync(composeFile, "services: {}\n");
  const plan = planFor(root, { composePath: composeFile });
  const setupUrl = "http://localhost:4000/setup/root?token=private-test-token";
  const prompt = formatAgentSetupPrompt(plan, { setupUrl });

  assert.match(prompt, /docker compose -f 'docker compose\.yaml' up -d tama/u);
  assert.match(prompt, /wait until Tama responds successfully at http:\/\/localhost:4000\//u);
  assert.match(
    prompt,
    /open the private onboarding URL http:\/\/localhost:4000\/setup\/root\?token=private-test-token in the in-app browser/u,
  );
  assert.equal(prompt.split(setupUrl).length - 1, 1);
  assert.match(prompt, /do not repeat it or its token elsewhere in chat or logs/u);
  assert.match(
    prompt,
    /If browser control is unavailable, direct me to tama\/README\.md without reproducing the token/u,
  );
  assert.match(prompt, /Do not ask me to paste credentials into chat/u);
  assert.match(
    prompt,
    /store TAMA_CLIENT_ID and TAMA_CLIENT_SECRET directly in tama\/\.tama\.env/u,
  );
  assert.match(prompt, /load tama\/\.tama\.env without echoing its values/u);
  assert.match(prompt, /terraform -chdir=tama init/u);
  assert.match(prompt, /terraform -chdir=tama validate/u);
  assert.match(prompt, /terraform -chdir=tama plan/u);
  assert.match(prompt, /Do not run terraform apply until I explicitly approve/u);
});

test("bootstrap rejects user drift in a managed template", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const readme = join(root, "tama", "README.md");
  writeFileSync(readme, `${readFileSync(readme, "utf8")}\nUser-maintained note.\n`);

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /user-modified content/u.test(error.message),
  );
  assert.match(readFileSync(readme, "utf8"), /User-maintained note/u);
});

test("bootstrap rejects a missing file recorded in the managed manifest", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const readme = join(root, "tama", "README.md");
  unlinkSync(readme);

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /managed file recorded by Tama Kit is missing/u.test(error.message),
  );
  assert.equal(existsSync(readme), false);
});

test("bootstrap rejects drift in a recorded managed Terraform foundation", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const foundation = join(root, "tama", "main.tf");
  writeFileSync(
    foundation,
    readFileSync(foundation, "utf8").replace('version = "0.5.6"', 'version = "0.5.5"'),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /user-modified content/u.test(error.message),
  );
});

test("bootstrap adopts marked Terraform files when migrating to the digest manifest", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const manifest = join(root, "tama", ".tama-kit.json");
  unlinkSync(manifest);

  applyOperations(planFor(root).operations);
  const payload = JSON.parse(readFileSync(manifest, "utf8"));
  assert.match(payload.managedFiles["tama/main.tf"], /^sha256:[0-9a-f]{64}$/u);
  assert.match(payload.managedFiles["tama/versions.tf"], /^sha256:[0-9a-f]{64}$/u);
});

test("bootstrap refuses to adopt an edited marked Terraform file without a manifest", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const manifest = join(root, "tama", ".tama-kit.json");
  const foundation = join(root, "tama", "main.tf");
  unlinkSync(manifest);
  writeFileSync(
    foundation,
    `${readFileSync(foundation, "utf8")}\nresource "tama_space" "custom" {}\n`,
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /cannot establish ownership of marked legacy Terraform file/u.test(error.message),
  );
  assert.match(readFileSync(foundation, "utf8"), /tama_space" "custom/u);
});

test("bootstrap upgrades previously generated Terraform templates", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const foundation = join(root, "tama", "main.tf");
  const versions = join(root, "tama", "versions.tf");
  const manifest = join(root, "tama", ".tama-kit.json");
  const oldFoundation = readFileSync(foundation, "utf8").replace(
    'version = "0.5.6"',
    'version = "0.5.5"',
  );
  const oldVersions = readFileSync(versions, "utf8").replace(
    'version = "~> 0.6.3"',
    'version = "~> 0.6.2"',
  );
  writeFileSync(foundation, oldFoundation);
  writeFileSync(versions, oldVersions);
  const manifestPayload = JSON.parse(readFileSync(manifest, "utf8"));
  manifestPayload.managedFiles["tama/main.tf"] = contentDigest(oldFoundation);
  manifestPayload.managedFiles["tama/versions.tf"] = contentDigest(oldVersions);
  writeFileSync(manifest, `${JSON.stringify(manifestPayload, null, 2)}\n`);

  const upgrade = planFor(root);
  const terraformChanges = upgrade.operations.filter(
    (operation) => operation.path === foundation || operation.path === versions,
  );

  assert.equal(upgrade.terraform.foundation, "preserved");
  assert.equal(upgrade.terraform.globalModuleVersion, "0.5.6");
  assert.equal(upgrade.terraform.providerVersion, "~> 0.6.3");
  assert.deepEqual(
    terraformChanges.map((operation) => [operation.path, operation.action]),
    [
      [foundation, "update"],
      [versions, "update"],
    ],
  );

  applyOperations(upgrade.operations);
  assert.match(readFileSync(foundation, "utf8"), /version = "0\.5\.6"/u);
  assert.match(readFileSync(versions, "utf8"), /version = "~> 0\.6\.3"/u);
});

test("dry-run reports and bootstrap repairs unsafe sensitive-file permissions", async () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const environmentFile = join(root, "tama", ".tama.env");
  chmodSync(environmentFile, 0o644);

  const output = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message) => output.push(message),
    stderr: () => {},
  });
  const payload = JSON.parse(output.join("\n"));
  const environmentChange = payload.changes.find((change) => change.path === environmentFile);

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
  writeFileSync(join(phoenix, "mix.exs"), 'defp deps, do: [{:phoenix, "~> 1.8"}]\n');
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

test("bootstrap preserves ownership when atomically updating an existing file", (context) => {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof process.getgroups !== "function"
  ) {
    context.skip("POSIX ownership is not available");
    return;
  }

  const root = project();
  const composeFile = join(root, "compose.yaml");
  writeFileSync(composeFile, "services: {}\n");
  const initial = statSync(composeFile);
  const secondaryGroup = process.getgroups().find((group) => group !== initial.gid);
  if (secondaryGroup === undefined) {
    context.skip("current user does not have a secondary group");
    return;
  }
  chownSync(composeFile, process.getuid(), secondaryGroup);
  const before = statSync(composeFile);

  applyOperations(planFor(root).operations);

  const after = statSync(composeFile);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
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
  assert.equal(existsSync(join(root, "tama", ".tama.env")), false);
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
  assert.doesNotMatch(readFileSync(join(root, "tama", "README.md"), "utf8"), new RegExp(root, "u"));

  const second = planFor(root, { composePath: "deploy/compose.yaml" });
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap rejects a managed Compose include at a different path", () => {
  const root = project();
  mkdirSync(join(root, "legacy"));
  writeFileSync(join(root, "legacy", "compose.yaml"), "# Generated by Tama Kit\nservices: {}\n");
  writeFileSync(join(root, "compose.yaml"), "include:\n  - ./legacy/compose.yaml\n");

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /different path/u.test(error.message),
  );
});

test("bootstrap rejects using its managed Compose fragment as the project Compose root", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", "compose.yaml"), "services: {}\n");

  assert.throws(
    () => planFor(root, { composePath: "tama/compose.yaml" }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /cannot also be Tama Kit's managed Compose fragment/u.test(error.message),
  );
});

test("bootstrap rejects a non-directory Tama path", () => {
  const root = project();
  writeFileSync(join(root, "tama"), "reserved by the application\n");

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /Tama path is not a directory/u.test(error.message),
  );
});

test("bootstrap rejects a Compose file that escapes through a symlinked directory", () => {
  const root = project();
  const external = project("tama-kit-external-compose-");
  const externalCompose = join(external, "compose.yaml");
  const original = "services: {}\n";
  writeFileSync(externalCompose, original);
  symlinkSync(external, join(root, "deploy"), "dir");

  assert.throws(
    () => planFor(root, { composePath: "deploy/compose.yaml" }),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.USAGE &&
      /must resolve inside the project root/u.test(error.message),
  );
  assert.equal(readFileSync(externalCompose, "utf8"), original);
  assert.equal(existsSync(join(root, "tama", ".tama.env")), false);
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
  assert.equal(plan.terraform.globalModuleVersion, "0.5.5");
  assert.equal(plan.terraform.providerVersion, null);
  assert.ok(!plan.operations.some((operation) => operation.path.endsWith("main.tf")));
});

test("bootstrap preserves a one-line global foundation declaration", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "foundation.tf"),
    'module "foundation" { source = "upmaru/base/tama" version = "0.5.5" }\n',
  );

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "preserved");
  assert.equal(plan.terraform.globalModuleVersion, "0.5.5");
  assert.ok(!plan.operations.some((operation) => operation.path.endsWith("tama-kit-global.tf")));
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
  assert.equal(plan.terraform.globalModuleVersion, "0.5.5");
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

test("bootstrap fails closed when Terraform JSON reserves module.global", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "network.tf.json"),
    `${JSON.stringify(
      {
        module: {
          global: {
            source: "terraform-aws-modules/vpc/aws",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

test("bootstrap adds a managed foundation beside unrelated Terraform modules", () => {
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

  const plan = planFor(root);
  const operation = plan.operations.find((item) => item.path.endsWith("tama-kit-global.tf"));
  assert.equal(plan.terraform.foundation, "created");
  assert.equal(operation.action, "create");
});

test("bootstrap ignores Tama foundation modules inside HCL comments and creates one", () => {
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

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "created");
  assert.ok(plan.operations.some((operation) => operation.path.endsWith("tama-kit-global.tf")));
});

test("bootstrap ignores assignment-looking content inside HCL heredocs", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    [
      'module "other" {',
      "  description = <<EOT",
      'source = "upmaru/base/tama"',
      "EOT",
      '  source = "./other"',
      "}",
      "",
    ].join("\n"),
  );

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "created");
  assert.ok(plan.operations.some((operation) => operation.path.endsWith("tama-kit-global.tf")));
});

test("bootstrap ignores literal module.global text in HCL strings and heredocs", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    [
      'resource "null_resource" "documentation" {',
      "  triggers = {",
      '    quoted = "The identifier module.global is reserved"',
      '    escaped = "$${module.global.name}"',
      '    escaped_directive = "%%{ module.global is literal }"',
      "    heredoc = <<EOT",
      "module.global is documentation, not a traversal",
      "EOT",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "created");
  assert.ok(plan.operations.some((operation) => operation.path.endsWith("tama-kit-global.tf")));
});

test("bootstrap still detects module.global inside an HCL template expression", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    `resource "null_resource" "example" { triggers = { name = "\${module.global.name}" } }\n`,
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /ownership is unknown/u.test(error.message),
  );
});

test("bootstrap detects module.global after nested braces in an HCL template directive", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", "main.tf"),
    [
      'resource "null_resource" "example" {',
      "  triggers = {",
      `    name = "\${true ? { fallback = "local" } : module.global.name}"`,
      `    body = "%%{ literal module.global } %{ if module.global.enabled }active%{ endif }"`,
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      /ownership is unknown/u.test(error.message),
  );
});

test("bootstrap ignores foundations in nested modules and creates one in the root", () => {
  const root = project();
  mkdirSync(join(root, "tama", "modules", "unused"), { recursive: true });
  writeFileSync(join(root, "tama", "main.tf"), 'resource "null_resource" "example" {}\n');
  writeFileSync(
    join(root, "tama", "modules", "unused", "main.tf"),
    'module "global" {\n  source = "upmaru/base/tama"\n  version = "0.5.6"\n}\n',
  );

  const plan = planFor(root);
  assert.equal(plan.terraform.foundation, "created");
  assert.ok(plan.operations.some((operation) => operation.path.endsWith("tama-kit-global.tf")));
});

test("bootstrap adds a separate managed foundation to a safe existing Terraform root", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", "main.tf"), 'resource "null_resource" "example" {}\n');
  const plan = planFor(root);
  const operation = plan.operations.find((item) => item.path.endsWith("tama-kit-global.tf"));
  assert.equal(plan.terraform.foundation, "created");
  assert.equal(operation.action, "create");
  assert.match(operation.content, /module "global"/u);

  applyOperations(plan.operations);
  const foundation = join(root, "tama", "tama-kit-global.tf");
  const manifest = join(root, "tama", ".tama-kit.json");
  const oldFoundation = readFileSync(foundation, "utf8").replace(
    'version = "0.5.6"',
    'version = "0.5.5"',
  );
  writeFileSync(foundation, oldFoundation);
  const manifestPayload = JSON.parse(readFileSync(manifest, "utf8"));
  manifestPayload.managedFiles["tama/tama-kit-global.tf"] = contentDigest(oldFoundation);
  writeFileSync(manifest, `${JSON.stringify(manifestPayload, null, 2)}\n`);

  const upgrade = planFor(root);
  const foundationUpgrade = upgrade.operations.find((item) => item.path === foundation);
  assert.equal(foundationUpgrade.action, "update");
  assert.match(foundationUpgrade.content, /version = "0\.5\.6"/u);
  assert.doesNotMatch(foundationUpgrade.content, /provider "tama"/u);
});

test("bootstrap still fails closed when existing Tama resources have unknown ownership", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", "main.tf"), 'resource "tama_space" "existing" {}\n');

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
  assert.equal(existsSync(join(root, "tama", ".tama.env")), false);
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.changes.find((change) => change.path.endsWith(".tama.env")).sensitive, true);
  assert.match(payload.changes[0].afterDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(payload.changes[0].beforeDigest, null);
  assert.equal(typeof payload.changes[0].reason, "string");
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
  assert.equal(payload.error.exitCode, EXIT_CODES.AMBIGUITY);
});

test("an explicit port updates public local URLs without rotating secrets", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const before = readFileSync(join(root, "tama", ".tama.env"), "utf8");
  const setupToken = before.match(/^TAMA_SETUP_TOKEN=(.+)$/mu)[1];

  const second = planFor(root, { port: 4567 });
  applyOperations(second.operations);
  const after = readFileSync(join(root, "tama", ".tama.env"), "utf8");
  assert.match(after, /^TAMA_PORT=4567$/mu);
  assert.match(after, /^TAMA_BASE_URL=http:\/\/localhost:4567$/mu);
  assert.match(after, new RegExp(`^TAMA_SETUP_TOKEN=${setupToken}$`, "mu"));
  assert.match(readFileSync(join(root, "tama", "compose.yaml"), "utf8"), /"4567:4000"/u);
});

test("an explicit port preserves additional MCP allowed origins", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      /^TAMA_MCP_ALLOWED_ORIGINS=http:\/\/localhost:4000$/mu,
      "TAMA_MCP_ALLOWED_ORIGINS=http://localhost:4000,https://app.example",
    ),
  );

  applyOperations(planFor(root, { port: 4567 }).operations);

  assert.match(
    readFileSync(filename, "utf8"),
    /^TAMA_MCP_ALLOWED_ORIGINS=http:\/\/localhost:4567,https:\/\/app\.example$/mu,
  );
});

test("bootstrap rejects an invalid persisted port instead of silently changing it", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(/^TAMA_PORT=4000$/mu, "TAMA_PORT=invalid"),
  );
  assert.throws(
    () => planFor(root),
    (error) => error instanceof CLIError && error.exitCode === EXIT_CODES.OWNERSHIP,
  );
});

function oauthJwkLines(content) {
  const values = parseEnv(content);
  return {
    jwk: values.TAMA_OAUTH_PRIVATE_JWK,
    id: values.TAMA_OAUTH_PRIVATE_JWK_ID,
  };
}

const OAUTH_PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"];

test("bootstrap generates an asymmetric System OAuth signing key", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const content = readFileSync(join(root, "tama", ".tama.env"), "utf8");
  const { jwk, id } = oauthJwkLines(content);
  assert.ok(jwk);
  assert.ok(id);
  assert.doesNotMatch(content, /TAMA_OAUTH_SIGNING_KEY/u);

  const parsed = /** @type {Record<string, string>} */ (JSON.parse(jwk));
  assert.equal(parsed.kty, "RSA");
  assert.equal(parsed.alg, "RS256");
  assert.equal(parsed.use, "sig");
  assert.equal(parsed.kid, id);
  const keyObject = createPrivateKey({ key: parsed, format: "jwk" });
  assert.equal(keyObject.asymmetricKeyType, "rsa");
  assert.equal(keyObject.asymmetricKeyDetails?.modulusLength, 3072);

  execFileSync(
    "bash",
    [
      "-c",
      "set -a\n. \"$1\"\nset +a\nnode -e 'const key = JSON.parse(process.env.TAMA_OAUTH_PRIVATE_JWK); if (key.kid !== process.env.TAMA_OAUTH_PRIVATE_JWK_ID) process.exit(1)'",
      "bash",
      join(root, "tama", ".tama.env"),
    ],
    { stdio: "ignore" },
  );

  const example = readFileSync(join(root, "tama", ".tama.env.example"), "utf8");
  assert.match(example, /^TAMA_OAUTH_PRIVATE_JWK=replace-me$/mu);
  assert.match(example, /^TAMA_OAUTH_PRIVATE_JWK_ID=replace-me$/mu);
  assert.doesNotMatch(example, /TAMA_OAUTH_SIGNING_KEY/u);

  const postgresEnvironment = readFileSync(join(root, "tama", ".tama.postgres.env"), "utf8");
  assert.doesNotMatch(postgresEnvironment, /TAMA_OAUTH/u);
  for (const member of OAUTH_PRIVATE_MEMBERS) {
    assert.equal(postgresEnvironment.includes(parsed[member]), false, `leaked ${member}`);
  }
});

test("bootstrap preserves the OAuth private JWK across reruns, ports, and skill modes", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  const before = readFileSync(filename, "utf8");
  const beforePair = oauthJwkLines(before);
  const jwtSecret = before.match(/^TAMA_JWT_SECRET=.+$/mu)[0];

  applyOperations(planFor(root, { skillMode: "local" }).operations);
  assert.equal(readFileSync(filename, "utf8"), before);

  applyOperations(planFor(root, { port: 4567, skillMode: "local" }).operations);
  const after = readFileSync(filename, "utf8");
  assert.deepEqual(oauthJwkLines(after), beforePair);
  assert.ok(after.includes(jwtSecret));
});

test("bootstrap dry-run output never contains the OAuth private JWK", async () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const { jwk, id } = oauthJwkLines(readFileSync(join(root, "tama", ".tama.env"), "utf8"));
  const parsed = /** @type {Record<string, string>} */ (JSON.parse(jwk));

  const output = [];
  const errors = [];
  const exitCode = await run(["bootstrap", root, "--dry-run", "--json"], {
    cwd: root,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
  });
  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const transcript = [...output, ...errors].join("\n");
  assert.equal(transcript.includes(jwk), false, "leaked encoded JWK");
  assert.equal(transcript.includes(id), false, "leaked kid");
  for (const member of OAUTH_PRIVATE_MEMBERS) {
    assert.equal(transcript.includes(parsed[member]), false, `leaked ${member}`);
  }
});

test("bootstrap fails closed for an unmanaged environment without the private JWK pair", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^# Generated by Tama Kit.*$/mu, "# User-managed environment")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK=.*$/mu, "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK_ID=.*$/mu, "TAMA_OAUTH_SIGNING_KEY_ID=oauth-local-1"),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("TAMA_OAUTH_PRIVATE_JWK") &&
      error.message.includes("TAMA_OAUTH_PRIVATE_JWK_ID"),
  );
  assert.equal(readFileSync(filename, "utf8").includes("legacy-symmetric-secret"), true);
});

test("bootstrap fails closed when only one half of the private JWK pair is present", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(/^TAMA_OAUTH_PRIVATE_JWK=.*$/mu, ""),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("TAMA_OAUTH_PRIVATE_JWK"),
  );
});

test("bootstrap migrates a managed environment from the retired signing key pair", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  const before = readFileSync(filename, "utf8");
  const migrated = before
    .replace(/^TAMA_OAUTH_PRIVATE_JWK=.*$/mu, "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret")
    .replace(/^TAMA_OAUTH_PRIVATE_JWK_ID=.*$/mu, "TAMA_OAUTH_SIGNING_KEY_ID=oauth-local-1");
  writeFileSync(filename, migrated);
  const retiredIndex = migrated
    .split("\n")
    .findIndex((line) => line.startsWith("TAMA_OAUTH_SIGNING_KEY="));

  applyOperations(planFor(root).operations);
  const after = readFileSync(filename, "utf8");
  const afterLines = after.split("\n");
  assert.ok(afterLines[retiredIndex].startsWith("TAMA_OAUTH_PRIVATE_JWK="));
  assert.ok(afterLines[retiredIndex + 1].startsWith("TAMA_OAUTH_PRIVATE_JWK_ID="));
  assert.doesNotMatch(after, /TAMA_OAUTH_SIGNING_KEY/u);
  assert.deepEqual(
    migrated.split("\n").filter((line) => !line.startsWith("TAMA_OAUTH_SIGNING_KEY")),
    afterLines.filter((line) => !line.startsWith("TAMA_OAUTH_PRIVATE_JWK")),
  );

  const { jwk, id } = oauthJwkLines(after);
  const parsed = /** @type {Record<string, string>} */ (JSON.parse(jwk));
  assert.equal(parsed.kid, id);
  assert.equal(createPrivateKey({ key: parsed, format: "jwk" }).asymmetricKeyType, "rsa");

  const second = planFor(root);
  assert.equal(
    second.operations.find((operation) => operation.path.endsWith(".tama.env"))?.action,
    "unchanged",
  );
});

test("bootstrap migrates the retired pair and applies a port change in one pass", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK=.*$/mu, "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK_ID=.*$/mu, "TAMA_OAUTH_SIGNING_KEY_ID=oauth-local-1"),
  );

  applyOperations(planFor(root, { port: 4567 }).operations);
  const after = readFileSync(filename, "utf8");
  assert.match(after, /^TAMA_PORT=4567$/mu);
  assert.match(after, /^TAMA_BASE_URL=http:\/\/localhost:4567$/mu);
  assert.doesNotMatch(after, /TAMA_OAUTH_SIGNING_KEY/u);
  assert.ok(oauthJwkLines(after).jwk);
});

test("bootstrap fails closed for an incomplete retired signing key pair", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK=.*$/mu, "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret")
      .replace(/^TAMA_OAUTH_PRIVATE_JWK_ID=.*$/mu, ""),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("TAMA_OAUTH_SIGNING_KEY") &&
      error.message.includes("TAMA_OAUTH_SIGNING_KEY_ID"),
  );
});

test("bootstrap fails closed when exactly one half of the new pair is present", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      /^TAMA_OAUTH_PRIVATE_JWK=.*$/mu,
      "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret",
    ),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("TAMA_OAUTH_PRIVATE_JWK and TAMA_OAUTH_PRIVATE_JWK_ID"),
  );
});

test("bootstrap fails closed for a managed environment with an invalid private JWK", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      /^TAMA_OAUTH_PRIVATE_JWK=.*$/mu,
      "TAMA_OAUTH_PRIVATE_JWK=not-a-jwk",
    ),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("not a valid RSA private JWK for RS256 signing"),
  );
  assert.match(readFileSync(filename, "utf8"), /TAMA_OAUTH_PRIVATE_JWK=not-a-jwk/u);
});

test("bootstrap leaves a valid new pair untouched when retired variables are also present", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8") +
      "TAMA_OAUTH_SIGNING_KEY=legacy-symmetric-secret\nTAMA_OAUTH_SIGNING_KEY_ID=oauth-local-1\n",
  );

  const plan = planFor(root);
  assert.equal(
    plan.operations.find((operation) => operation.path.endsWith(".tama.env"))?.action,
    "unchanged",
  );
});

test("bootstrap rejects a persisted internal port that disagrees with Compose", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(filename, readFileSync(filename, "utf8").replace(/^PORT=4000$/mu, "PORT=5000"));

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
  const filename = join(root, "tama", ".tama.env");
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
    const filename = join(root, "tama", ".tama.env");
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

test("bootstrap rejects persisted runtime secrets with invalid formats", () => {
  for (const [name, invalidValue] of [
    ["SECRET_KEY_BASE", "replace-me"],
    ["TAMA_VAULT_KEY", "replace-me"],
    ["TAMA_VAULT_KEY", "x".repeat(44)],
  ]) {
    const root = project();
    applyOperations(planFor(root).operations);
    const filename = join(root, "tama", ".tama.env");
    writeFileSync(
      filename,
      readFileSync(filename, "utf8").replace(
        new RegExp(`^${name}=.*$`, "mu"),
        `${name}=${invalidValue}`,
      ),
    );

    assert.throws(
      () => planFor(root),
      (error) =>
        error instanceof CLIError &&
        error.exitCode === EXIT_CODES.OWNERSHIP &&
        error.details.variables.includes(name) &&
        !error.message.includes(invalidValue),
    );
  }
});

test("bootstrap accepts the Tama runtime's 32-byte raw vault-key format", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace(
      /^TAMA_VAULT_KEY=.*$/mu,
      `TAMA_VAULT_KEY=${"x".repeat(32)}`,
    ),
  );

  assert.ok(planFor(root).operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap rejects duplicate keys in a persisted environment", () => {
  const root = project();
  const first = planFor(root);
  applyOperations(first.operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(filename, `${readFileSync(filename, "utf8")}TAMA_BASE_URL=http://localhost:4000\n`);

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
  const filename = join(root, "tama", ".tama.env");
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

test("bootstrap quotes parsed PostgreSQL values in the derived Compose environment", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  const password = "pass # word\nnext";
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^POSTGRES_PASSWORD=.*$/mu, 'POSTGRES_PASSWORD="pass # word\\nnext"')
      .replace(
        /^DATABASE_URL=.*$/mu,
        "DATABASE_URL=ecto://tama:pass%20%23%20word%0Anext@tama-postgres/tama",
      ),
  );

  applyOperations(planFor(root).operations);
  const derived = readFileSync(join(root, "tama", ".tama.postgres.env"), "utf8");

  assert.match(derived, /^POSTGRES_PASSWORD="pass # word\\nnext"$/mu);
  assert.equal(parseEnv(derived).POSTGRES_PASSWORD, password);
});

test("bootstrap protects PostgreSQL dollar signs from Compose interpolation", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^POSTGRES_PASSWORD=.*$/mu, "POSTGRES_PASSWORD='dollar $HOME'")
      .replace(
        /^DATABASE_URL=.*$/mu,
        "DATABASE_URL=ecto://tama:dollar%20%24HOME@tama-postgres/tama",
      ),
  );

  applyOperations(planFor(root).operations);
  const derived = readFileSync(join(root, "tama", ".tama.postgres.env"), "utf8");

  assert.match(derived, /^POSTGRES_PASSWORD="dollar \$\$HOME"$/mu);
});

test("bootstrap rejects PostgreSQL values Compose cannot represent faithfully", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  const password = `control${String.fromCharCode(1)}value`;
  writeFileSync(
    filename,
    readFileSync(filename, "utf8")
      .replace(/^POSTGRES_PASSWORD=.*$/mu, `POSTGRES_PASSWORD='${password}'`)
      .replace(
        /^DATABASE_URL=.*$/mu,
        "DATABASE_URL=ecto://tama:control%01value@tama-postgres/tama",
      ),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variable === "POSTGRES_PASSWORD" &&
      !error.message.includes(password),
  );
});

test("bootstrap rejects a non-default PostgreSQL port in DATABASE_URL", () => {
  const root = project();
  applyOperations(planFor(root).operations);
  const filename = join(root, "tama", ".tama.env");
  writeFileSync(
    filename,
    readFileSync(filename, "utf8").replace("@tama-postgres/tama", "@tama-postgres:5433/tama"),
  );

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.details.variable === "DATABASE_URL",
  );
});

test("bootstrap appends nested ignore rules after a later secret-file negation", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", ".gitignore"), ".tama.env\n!.tama.env\n");

  const first = planFor(root);
  applyOperations(first.operations);
  const content = readFileSync(join(root, "tama", ".gitignore"), "utf8");
  assert.ok(content.lastIndexOf(".tama.env") > content.lastIndexOf("!.tama.env"));

  const second = planFor(root);
  assert.ok(second.operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap refuses private environment files already tracked by Git", () => {
  const root = project();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  applyOperations(planFor(root).operations);
  execFileSync("git", ["add", "--force", "tama/.tama.env", "tama/.tama.postgres.env"], {
    cwd: root,
  });

  assert.throws(
    () => planFor(root),
    (error) =>
      error instanceof CLIError &&
      error.exitCode === EXIT_CODES.OWNERSHIP &&
      error.message.includes("git rm --cached") &&
      error.details.paths.includes("tama/.tama.env") &&
      error.details.paths.includes("tama/.tama.postgres.env"),
  );
  assert.ok(existsSync(join(root, "tama", ".tama.env")));
  assert.ok(existsSync(join(root, "tama", ".tama.postgres.env")));
});

test("bootstrap moves one Tama-directory ignore block to the end without duplicating it", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(
    join(root, "tama", ".gitignore"),
    [
      "# Tama Kit local runtime",
      "/.tama.env",
      "/.tama.postgres.env",
      "",
      "# Tama Kit Terraform local state",
      ".terraform/",
      "*.tfstate",
      "*.tfstate.*",
      "",
      "coverage/",
      "",
    ].join("\n"),
  );

  applyOperations(planFor(root).operations);
  const content = readFileSync(join(root, "tama", ".gitignore"), "utf8");
  assert.equal((content.match(/# Tama Kit local runtime/gu) ?? []).length, 1);
  assert.equal((content.match(/# Tama Kit Terraform local state/gu) ?? []).length, 1);
  assert.ok(content.lastIndexOf("# Tama Kit local runtime") > content.lastIndexOf("coverage/"));
  assert.match(content, /^\.terraform\/$/mu);
  assert.match(content, /^\*\.tfstate$/mu);
  assert.equal(existsSync(join(root, ".gitignore")), false);
  assert.ok(planFor(root).operations.every((operation) => operation.action === "unchanged"));
});

test("bootstrap enforces Terraform state ignores after a nested negation", () => {
  const root = project();
  mkdirSync(join(root, "tama"));
  writeFileSync(join(root, "tama", ".gitignore"), "!*.tfstate\n");

  applyOperations(planFor(root).operations);
  writeFileSync(join(root, "tama", "example.tfstate"), "{}\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const nestedIgnore = readFileSync(join(root, "tama", ".gitignore"), "utf8");
  assert.ok(nestedIgnore.lastIndexOf("*.tfstate") > nestedIgnore.lastIndexOf("!*.tfstate"));
  assert.doesNotThrow(() =>
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "tama/example.tfstate"], {
      cwd: root,
    }),
  );
  assert.throws(
    () =>
      execFileSync("git", ["check-ignore", "--quiet", "--no-index", "tama/.terraform.lock.hcl"], {
        cwd: root,
      }),
    (error) => error && typeof error === "object" && "status" in error && error.status === 1,
  );
  assert.ok(planFor(root).operations.every((operation) => operation.action === "unchanged"));
});

test("the next-step command includes and safely quotes the selected Compose file", () => {
  assert.equal(
    formatComposeUpCommand("/tmp/tama project's/deploy/compose.yaml"),
    "docker compose -f '/tmp/tama project'\\''s/deploy/compose.yaml' up -d tama",
  );
});

test("the next-step command visibly escapes filename control characters", () => {
  assert.equal(
    formatComposeUpCommand("nested/a\nb\tcompose.yaml"),
    "docker compose -f $'nested/a\\nb\\tcompose.yaml' up -d tama",
  );
});

test("the next-step output references the Compose file relative to the working directory", async (context) => {
  try {
    execFileSync("docker", ["compose", "version", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    context.skip("Docker Compose is not available");
    return;
  }

  const root = project();
  const output = [];
  const exitCode = await run(["bootstrap", root, "--no-color", "--skills", "manual"], {
    cwd: root,
    interactive: false,
    color: false,
    columns: 60,
    write: () => {},
    stdout: (message) => output.push(message),
    stderr: () => {},
  });

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
  const text = output.join("\n");
  assert.match(text, /^Next:$/mu);
  assert.ok(output.includes("  docker compose -f 'compose.yaml' up -d tama"));
  assert.match(text, /^Private setup URL:$/mu);
  const setupUrl = output.find((message) =>
    message.startsWith("  http://localhost:4000/setup/root?token="),
  );
  assert.ok(setupUrl);
  assert.ok(setupUrl.length > 60, "the copyable URL should remain one logical line");
  assert.doesNotMatch(setupUrl, /[\r\n]/u);
  assert.doesNotMatch(text, new RegExp(`${root}/compose.yaml`, "g"));

  assert.ok(output.includes("Copy this prompt into your coding agent"));
  const promptSetupUrl = output.find((message) => message.includes("private onboarding URL is"));
  assert.ok(promptSetupUrl);
  assert.doesNotMatch(promptSetupUrl, /[\r\n]/u);
  assert.ok(
    output.every((message) => !message.startsWith("┌")),
    "the prompt should fall back to unboxed text instead of hard-breaking its private URL",
  );
});
