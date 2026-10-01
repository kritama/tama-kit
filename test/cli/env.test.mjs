import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import {
  inspectComposeDeclarations,
  loadComposeServiceEnvironment,
} from "../../cli/bootstrap/compose-inspection.mjs";
import { inspectCurrentConfiguration } from "../../cli/bootstrap/current-config.mjs";
import { validateMcpAppContract } from "../../cli/bootstrap/mcp-app-contract.mjs";
import { createBootstrapPlan } from "../../cli/bootstrap/plan.mjs";
import {
  classifyEnvironmentReference,
  databaseUrlIssues,
  environmentCommand,
  environmentPreflight,
  missingEnvironmentDiagnosis,
  resolvePublicIdentity,
  serializeDatabaseUrl,
} from "../../cli/domain/environment.mjs";
import { run } from "../../cli/index.mjs";
import { parseEnvironment } from "../../cli/shared/environment.mjs";
import { contentDigest } from "../../cli/shared/files.mjs";
import { validateOAuthPrivateJwk } from "../../cli/shared/oauth-key.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import { planMcpAppAddition } from "../../cli/workflows/generate-mcp-app.mjs";
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

function mcpFixture(root = temporaryDirectory("tama-env-mcp-")) {
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
  value.progress = {
    status: "incomplete",
    pendingDestinations: ["tama/.tama.env"],
  };
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
  assert.equal(result.exitCode, 4);
  assert.equal(document.ok, false);
  assert.match(document.warnings.join("\n"), /unresolved interpolation/u);
  assert.ok(
    document.files.some(
      (file) => file.required && file.status === "invalid" && file.relative.includes("$"),
    ),
  );
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

test("env usage failures honor the JSON envelope before inspecting or writing a project", async () => {
  const root = temporaryDirectory("tama-env-usage-");
  const before = snapshot(root);
  const cases = [
    { args: ["rotate"], message: /unknown env command/u },
    { args: ["init", "--bogus"], message: /Unknown option/u },
    { args: ["doctor", "--bogus"], message: /Unknown option/u },
    { args: ["init", "--service"], message: /argument/u },
    { args: ["init", "first", "second"], message: /expected at most one project path/u },
    { args: ["doctor", "first", "second"], message: /expected at most one project path/u },
  ];
  for (const { args, message } of cases) {
    const human = await command(["env", ...args], root);
    assert.equal(human.exitCode, 2);
    assert.equal(human.stdout, "");
    assert.match(human.stderr, message);
    const [subcommand, ...options] = args;
    for (const argv of [
      [subcommand, "--json", ...options],
      [subcommand, ...options, "--json"],
    ]) {
      const result = await command(["env", ...argv], root);
      assert.equal(result.exitCode, 2);
      assert.equal(result.stderr, "");
      const document = JSON.parse(result.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.category, "usage");
      assert.equal(document.error.exitCode, 2);
      assert.match(document.error.message, message);
    }
  }
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
    environmentCommand("doctor", {
      targetPath: "app",
      compose: ["a.yaml", "b.yaml"],
    }),
    "tama-kit env doctor app --compose a.yaml --compose b.yaml",
  );
});

import { postgresEnvironment } from "../../cli/bootstrap/environment.mjs";
import {
  associateTamaDatabase,
  findPostgresDataSources,
  inspectPersistence,
} from "../../cli/bootstrap/persistence.mjs";
import { runEnvironmentDoctor, runEnvironmentInit } from "../../cli/workflows/environment.mjs";

function fakeDocker(options = {}) {
  const calls = [];
  const execute = (_command, args, executeOptions) => {
    calls.push(args);
    // Compose resolution stays real; only Docker state is faked.
    if (args[0] === "compose") {
      return execFileSync("docker", args, {
        ...executeOptions,
        encoding: "utf8",
      });
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

test("missing env files use native literal declarations when Compose 2.38 rejects the resolved render", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const docker = fakeDocker();
  let fallbacks = 0;
  const execute = (command, args, options) => {
    if (
      args[0] === "compose" &&
      args.includes("--no-env-resolution") &&
      !args.includes("--no-interpolate")
    ) {
      fallbacks += 1;
      const error = new Error("Compose rejected a missing required env file");
      error.stderr = `env file ${join(root, "tama/.tama.env")} not found: stat failed`;
      throw error;
    }
    return docker.execute(command, args, options);
  };
  const doctor = await runEnvironmentDoctor({ cwd: root }, { execute });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.files.find((file) => file.role === "core")?.status, "missing");
  assert.equal(doctor.files.find((file) => file.role === "postgres")?.status, "missing");
  const preview = await runEnvironmentInit({ cwd: root, dryRun: true, fresh: false }, { execute });
  assert.equal(preview.ok, true, preview.blockers.join("\n"));
  assert.equal(preview.persistence.status, "absent");
  assert.ok(fallbacks >= 2);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
});

test("unrelated Compose failures cannot authorize a missing-file fallback", () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  let renders = 0;
  assert.throws(
    () =>
      inspectComposeDeclarations(
        { cwd: root },
        {
          validatePrerequisite: () => {},
          execute: () => {
            renders += 1;
            const error = new Error("invalid Compose configuration");
            error.stderr = "service tama has an invalid declaration";
            throw error;
          },
        },
      ),
    /Docker Compose configuration could not be resolved/u,
  );
  assert.equal(renders, 1);
});

test("missing-file fallback rejects unresolved non-env Compose declarations", () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  const docker = fakeDocker();
  assert.throws(
    () =>
      inspectComposeDeclarations(
        { cwd: root },
        {
          validatePrerequisite: () => {},
          execute: (command, args, options) => {
            if (args.includes("--no-env-resolution") && !args.includes("--no-interpolate")) {
              const error = new Error("missing required env file");
              error.stderr = `env file ${join(root, "tama/.tama.env")} not found: stat failed`;
              throw error;
            }
            const model = JSON.parse(docker.execute(command, args, options));
            model.services.tama.volumes = [
              {
                type: "bind",
                source: ["$", "{DATA_PATH}"].join(""),
                target: "/var/lib/postgresql/data",
              },
            ];
            return JSON.stringify(model);
          },
        },
      ),
    /Docker Compose configuration could not be resolved/u,
  );
});

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

test("env init requires a fresh assertion for an unobservable host provider", async () => {
  const { root } = mcpFixture();
  rmSync(join(root, "tama/.memovee.integration.env"));
  const before = snapshot(root);
  const result = await command(["env", "init", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  assert.equal(document.ok, false);
  assert.match(document.blockers.join("\n"), /persistence could not be verified/u);
  assert.match(document.blockers.join("\n"), /--fresh/u);
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
    {
      name: "myapp",
      volumes: { "db-data": { external: { name: "shared-db" } } },
    },
    { db: service },
  );
  assert.deepEqual(external?.volumes, [
    { source: "db-data", names: ["shared-db", "db-data", "myapp_db-data"] },
  ]);
  assert.equal(
    findPostgresDataSources(
      { name: "myapp", volumes: {} },
      {
        app: {
          name: "app",
          volumes: [{ type: "volume", source: "cache", target: "/cache" }],
        },
      },
    ),
    null,
  );
});

function replaceRootCompose(root, content) {
  writeFileSync(join(root, "compose.yaml"), content);
}

test("env init requires --fresh when the selected runtime has no local database mount", async () => {
  const root = standardRoot();
  replaceRootCompose(
    root,
    'services:\n  tama:\n    image: ghcr.io/upmaru/tama:latest\n    env_file:\n      - tama/.tama.env\n    ports:\n      - "4000:4000"\n',
  );
  rmSync(join(root, "tama/.tama.env"));
  const blocked = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    { execute: fakeDocker().execute },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.persistence.status, "unknown");
  assert.equal(blocked.persistence.freshAsserted, false);
  assert.match(blocked.blockers.join("\n"), /pass --fresh/u);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  const asserted = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: true },
    { execute: fakeDocker().execute },
  );
  assert.equal(asserted.ok, true);
  assert.equal(asserted.persistence.status, "unknown");
  assert.equal(asserted.persistence.freshAsserted, true);
  assert.equal(existsSync(join(root, "tama/.tama.env")), true);
});

test("failed Docker probes and unreadable binds stay unknown instead of absent", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const denied = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    {
      execute: (_command, args, executeOptions) => {
        if (args[0] === "compose")
          return execFileSync("docker", args, {
            ...executeOptions,
            encoding: "utf8",
          });
        if (args[0] === "version") return "Docker version 29.4.0";
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.persistence.status, "unknown");
  assert.equal(denied.persistence.freshAsserted, false);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);

  const docker = (_command, args) => (args[0] === "ps" ? "" : "ok");
  const missingBind = inspectPersistence({
    root,
    sources: {
      service: "db",
      volumes: [],
      binds: [join(root, "missing-parent", "data")],
    },
    execute: docker,
  });
  mkdirSync(join(root, "sealed"), { mode: 0o000 });
  const sealed = inspectPersistence({
    root,
    sources: {
      service: "db",
      volumes: [],
      binds: [join(root, "sealed", "pg")],
    },
    execute: docker,
  });
  chmodSync(join(root, "sealed"), 0o700);
  assert.equal(missingBind.status, "absent");
  assert.equal(sealed.status, "unknown");
});

test("a persistence probe that becomes unverifiable rolls the write back", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  let volumeProbes = 0;
  await assert.rejects(
    () =>
      runEnvironmentInit(
        { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
        {
          execute: (_command, args, executeOptions) => {
            if (args[0] === "compose") {
              return execFileSync("docker", args, {
                ...executeOptions,
                encoding: "utf8",
              });
            }
            if (args[0] === "version") return "Docker version 29.4.0";
            if (args[0] === "volume") {
              volumeProbes += 1;
              const error = new Error(volumeProbes > 2 ? "permission denied" : "no such volume");
              error.code = "ERR_DOCKER";
              throw error;
            }
            if (args[0] === "ps") return "";
            return "";
          },
        },
      ),
    /became unverifiable/u,
  );
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), false);
});

test("env init inspects the Tama database, not an earlier unrelated PostgreSQL service", async () => {
  const root = standardRoot();
  replaceRootCompose(
    root,
    [
      "services:",
      "  app-db:",
      "    image: postgres",
      "    volumes:",
      "      - app-data:/var/lib/postgresql/data",
      "  tama-postgres:",
      "    image: postgres",
      "    env_file:",
      "      - tama/.tama.postgres.env",
      "    volumes:",
      "      - tama-postgres-data:/var/lib/postgresql/data",
      "  tama:",
      "    image: ghcr.io/upmaru/tama:latest",
      "    env_file:",
      "      - tama/.tama.env",
      "    depends_on:",
      "      tama-postgres:",
      "        condition: service_started",
      "    ports:",
      '      - "4000:4000"',
      "volumes:",
      "  app-data:",
      "  tama-postgres-data:",
      "",
    ].join("\n"),
  );
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: true },
    {
      execute: (_command, args, executeOptions) => {
        if (args[0] === "compose")
          return execFileSync("docker", args, {
            ...executeOptions,
            encoding: "utf8",
          });
        if (args[0] === "version") return "Docker version 29.4.0";
        if (args[0] === "volume" && String(args[2]).includes("tama-postgres-data")) return "[]";
        if (args[0] === "volume") {
          const error = new Error(`no such volume: ${args[2]}`);
          error.code = "ERR_DOCKER";
          throw error;
        }
        if (args[0] === "ps") return "";
        return "";
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.persistence.status, "detected");
  assert.equal(result.persistence.freshAsserted, false);
  assert.match(result.persistence.detail, /tama-postgres-data/u);
  assert.doesNotMatch(result.persistence.detail, /app-data/u);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
});

test("associateTamaDatabase ignores declaration order and refuses ambiguity", () => {
  const mount = (source) => [
    {
      type: "volume",
      source,
      target: "/var/lib/postgresql/data",
    },
  ];
  const model = {
    name: "app",
    services: {
      "app-db": { volumes: mount("app-data") },
      "orders-db": { volumes: mount("orders-data") },
      tama: {
        depends_on: { "orders-db": {} },
        env_file: [{ path: "tama/.tama.env" }],
      },
    },
    volumes: {},
  };
  const associated = associateTamaDatabase({
    model,
    tamaService: "tama",
    postgresServices: ["orders-db"],
    databaseHost: "orders-db",
  });
  assert.equal(associated.kind, "local");
  if (associated.kind === "local") assert.equal(associated.sources.service, "orders-db");
  const ambiguous = associateTamaDatabase({
    model,
    tamaService: "tama",
    postgresServices: ["app-db", "orders-db"],
  });
  assert.equal(ambiguous.kind, "ambiguous");
});

test("public identity preserves an agreed database host and reports conflicts", () => {
  const example = new Map([
    ["TAMA_PORT", "4567"],
    ["PHX_HOST", "localhost"],
    ["DATABASE_URL", "ecto://tama:replace-me@orders-db/tama"],
    ["POSTGRES_USER", "tama"],
    ["POSTGRES_DB", "tama"],
    ["TAMA_OAUTH_ISSUER", "http://localhost:4567"],
    ["TAMA_BASE_URL", "http://localhost:4567"],
    ["TAMA_MCP_RESOURCE", "http://localhost:4567/mcp"],
    ["TAMA_MCP_ALLOWED_ORIGINS", "http://localhost:4567"],
  ]);
  const agreed = resolvePublicIdentity({
    exampleValues: example,
    publishedPort: 4567,
    databaseService: "orders-db",
    containerPort: 4000,
  });
  assert.equal(agreed.identity?.databaseHost, "orders-db");
  assert.equal(agreed.identity?.port, 4567);
  const conflict = resolvePublicIdentity({
    exampleValues: example,
    publishedPort: 4000,
    databaseService: "orders-db",
    containerPort: 4000,
  });
  assert.equal(conflict.identity, null);
  assert.match(conflict.issues.join("\n"), /does not match the published Compose port/u);
});

test("env init preserves a nondefault public port and database host", async () => {
  const root = temporaryDirectory("tama-env-port-");
  applyOperations(createBootstrapPlan({ cwd: root, skillMode: "manual", port: 4567 }).operations);
  rmSync(join(root, "tama/.tama.env"));
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: false },
    { execute: fakeDocker().execute },
  );
  assert.equal(result.ok, true, result.blockers.join("\n"));
  const recovered = readFileSync(join(root, "tama/.tama.env"), "utf8");
  assert.match(recovered, /^TAMA_PORT=4567$/mu);
  assert.match(recovered, /^TAMA_OAUTH_ISSUER=http:\/\/localhost:4567$/mu);
  assert.doesNotMatch(recovered, /localhost:4000/u);
  const example = readFileSync(join(root, "tama/.tama.env.example"), "utf8");
  assert.match(example, /TAMA_PORT=4567/u);
});

test("env doctor rejects an empty core and a stale public issuer", async () => {
  const root = standardRoot();
  const envPath = join(root, "tama/.tama.env");
  writeFileSync(envPath, "");
  chmodSync(envPath, 0o600);
  const empty = await command(["env", "doctor", root, "--json"], root);
  const emptyDoc = JSON.parse(empty.stdout);
  assert.equal(empty.exitCode, 4);
  const emptyCore = emptyDoc.files.find((file) => file.role === "core");
  assert.equal(emptyCore.status, "invalid");
  assert.match(emptyCore.issues.join("\n"), /missing required variables/u);
  assert.doesNotMatch(empty.stdout, /SECRET_KEY_BASE=/u);

  const healthy = standardRoot();
  const healthyPath = join(healthy, "tama/.tama.env");
  writeFileSync(
    healthyPath,
    readFileSync(healthyPath, "utf8").replace(
      /^TAMA_OAUTH_ISSUER=.*$/mu,
      "TAMA_OAUTH_ISSUER=http://localhost:9999",
    ),
  );
  const stale = await command(["env", "doctor", healthy, "--json"], healthy);
  const staleDoc = JSON.parse(stale.stdout);
  assert.equal(stale.exitCode, 4);
  const staleCore = staleDoc.files.find((file) => file.role === "core");
  assert.equal(staleCore.status, "public-configuration-conflict");
  assert.match(staleCore.issues.join("\n"), /public identity could not be established/u);
  assert.match(
    staleDoc.warnings.join("\n"),
    /TAMA_OAUTH_ISSUER does not match the project example/u,
  );
});

test("required interpolated paths block doctor and init; optional ones do not", async () => {
  const root = standardRoot();
  replaceRootCompose(
    root,
    `services:\n  tama:\n    image: ghcr.io/upmaru/tama:latest\n    env_file:\n      - path: ${"$"}{TAMA_REVIEW_ENV_DIR:-./tama}/.tama.env\n        required: true\n`,
  );
  rmSync(join(root, "tama/.tama.env"));
  const doctor = await command(["env", "doctor", root, "--json"], root);
  assert.equal(doctor.exitCode, 4);
  assert.equal(JSON.parse(doctor.stdout).ok, false);
  const init = await command(["env", "init", root, "--json"], root);
  const initDoc = JSON.parse(init.stdout);
  assert.equal(init.exitCode, 4);
  assert.match(initDoc.blockers.join("\n"), /unresolved interpolation/u);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);

  const optional = standardRoot();
  writeFileSync(
    join(optional, "compose.yaml"),
    `include:\n  - ./tama/compose.yaml\nservices:\n  app:\n    image: app\n    env_file:\n      - path: ${"$"}{OPTIONAL_ENV:-./missing}/app.env\n        required: false\n`,
  );
  const optionalDoctor = await command(["env", "doctor", optional, "--json"], optional);
  assert.equal(optionalDoctor.exitCode, 0);
  assert.equal(JSON.parse(optionalDoctor.stdout).ok, true);
});

test("optional missing files do not block or disagree with a required recovery", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.yaml"),
    "include:\n  - ./tama/compose.yaml\nservices:\n  app:\n    image: app\n    env_file:\n      - path: tama/app.env\n        required: false\n",
  );
  rmSync(join(root, "tama/.tama.postgres.env"));
  const preview = await command(["env", "init", root, "--dry-run", "--json"], root);
  const previewDoc = JSON.parse(preview.stdout);
  assert.equal(preview.exitCode, 0);
  assert.equal(previewDoc.ok, true);
  assert.deepEqual(previewDoc.changes, [
    { action: "create", relative: "tama/.tama.postgres.env", sensitive: true },
  ]);
  const applied = await command(["env", "init", root, "--json"], root);
  const appliedDoc = JSON.parse(applied.stdout);
  assert.equal(applied.exitCode, 0, applied.stdout);
  assert.equal(appliedDoc.ok, true);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), true);
  assert.equal(existsSync(join(root, "tama/app.env")), false);
  assert.deepEqual(
    appliedDoc.changes.map((change) => change.relative),
    previewDoc.changes.map((change) => change.relative),
  );
});

test("invalid selectors fail before writes and follow-up commands keep the selection", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.postgres.env"));
  const before = snapshot(root);
  const missingService = await command(
    ["env", "init", root, "--service", "does-not-exist", "--json"],
    root,
  );
  assert.equal(missingService.exitCode, 2);
  const missingFile = await command(
    ["env", "init", root, "--env-file", "not-loaded.env", "--dry-run", "--json"],
    root,
  );
  assert.equal(missingFile.exitCode, 4);
  assert.match(missingFile.stdout, /not loaded by the selected Tama service/u);
  assert.deepEqual(snapshot(root), before);

  const parent = temporaryDirectory("tama-env-space-");
  const spaced = join(parent, "my project");
  mkdirSync(spaced);
  applyOperations(createBootstrapPlan({ cwd: spaced, skillMode: "manual" }).operations);
  rmSync(join(spaced, "tama/.tama.postgres.env"));
  const recovered = await command(
    ["env", "init", spaced, "--compose", "compose.yaml", "--service", "tama", "--json"],
    spaced,
  );
  const document = JSON.parse(recovered.stdout);
  assert.equal(recovered.exitCode, 0, recovered.stdout);
  const guidance = document.nextActions.join("\n");
  assert.match(guidance, /tama-kit setup '.*my project'/u);
  assert.match(guidance, /--compose compose.yaml/u);
  assert.match(guidance, /--service tama/u);
  assert.equal(
    environmentCommand("setup", {
      targetPath: "my project",
      compose: ["a.yaml", "b.yaml"],
      service: "tama",
    }),
    "tama-kit setup 'my project' --compose a.yaml --compose b.yaml --service tama",
  );
});

test("env init refuses issuance while a generation receipt is incomplete", async () => {
  const root = standardRoot();
  rmSync(join(root, "tama/.tama.postgres.env"));
  const receipt = join(root, "tama/.tama-kit.json");
  const value = JSON.parse(readFileSync(receipt, "utf8"));
  value.progress = {
    status: "incomplete",
    pendingDestinations: ["tama/.tama.env"],
  };
  writeFileSync(receipt, JSON.stringify(value));
  const before = snapshot(root);
  const result = await command(["env", "init", root, "--json"], root);
  const document = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 4);
  assert.match(document.blockers.join("\n"), /incomplete generation/u);
  assert.match(document.blockers.join("\n"), /bootstrap --resume/u);
  assert.deepEqual(snapshot(root), before);
});

test("available bind data blocks issuance even when Docker is down", async () => {
  const root = standardRoot();
  const compose = readFileSync(join(root, "tama/compose.yaml"), "utf8").replace(
    "      - tama-postgres-data:/var/lib/postgresql/data",
    "      - ./data:/var/lib/postgresql/data",
  );
  writeFileSync(join(root, "tama/compose.yaml"), compose);
  mkdirSync(join(root, "tama/data"));
  writeFileSync(join(root, "tama/data/PG_VERSION"), "15\n");
  rmSync(join(root, "tama/.tama.env"));
  const result = await runEnvironmentInit(
    { cwd: process.cwd(), targetPath: root, dryRun: false, fresh: true },
    {
      execute: (_command, args, executeOptions) => {
        if (args[0] === "compose") {
          return execFileSync("docker", args, {
            ...executeOptions,
            encoding: "utf8",
          });
        }
        const error = new Error("cannot connect to the Docker daemon");
        error.code = "ECONNREFUSED";
        throw error;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.persistence.status, "detected");
  assert.equal(result.persistence.freshAsserted, false);
  assert.ok(result.persistence.checked.some((item) => item.endsWith("data")));
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
});

test("positive persistence evidence wins over a failed probe", () => {
  const root = temporaryDirectory("tama-env-probe-");
  const data = join(root, "pg");
  const sealed = join(root, "sealed");
  mkdirSync(data);
  writeFileSync(join(data, "PG_VERSION"), "15\n");
  mkdirSync(sealed, { mode: 0o000 });
  const observation = inspectPersistence({
    root,
    project: "app",
    sources: {
      service: "db",
      volumes: [{ source: "db-data", names: ["db-data"] }],
      binds: [join(sealed, "hidden"), data],
    },
    execute: (_command, args) => {
      if (args[0] === "version") return "ok";
      if (args[0] === "volume") {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      if (args[0] === "ps") return "db-1\n";
      return "";
    },
  });
  chmodSync(sealed, 0o700);
  assert.equal(observation.status, "detected");
  assert.match(observation.detail, /bind-mounted database directory|container for the db service/u);
});

test("an inline external DATABASE_URL is not authorized by an empty local volume", async () => {
  const root = standardRoot();
  writeFileSync(
    join(root, "compose.override.yaml"),
    "services:\n  tama:\n    environment:\n      DATABASE_URL: ecto://tama:placeholder@external.example/tama\n",
  );
  rmSync(join(root, "tama/.tama.env"));
  const result = await runEnvironmentInit(
    {
      cwd: process.cwd(),
      targetPath: root,
      composeFiles: ["compose.yaml", "compose.override.yaml"],
      dryRun: false,
      fresh: true,
    },
    { execute: fakeDocker().execute },
  );
  assert.equal(result.ok, false, result.blockers.join("\n"));
  assert.notEqual(result.persistence.status, "absent");
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  assert.match(result.blockers.join("\n"), /DATABASE_URL host does not match the project example/u);
});

test("doctor accepts matching multi-origin lists and rejects a missing origin", async () => {
  const root = standardRoot();
  const origins = "http://localhost:4000, http://localhost:5173";
  const example = join(root, "tama/.tama.env.example");
  const envPath = join(root, "tama/.tama.env");
  writeFileSync(
    example,
    readFileSync(example, "utf8").replace(
      /^TAMA_MCP_ALLOWED_ORIGINS=.*$/mu,
      `TAMA_MCP_ALLOWED_ORIGINS=${origins}`,
    ),
  );
  writeFileSync(
    envPath,
    readFileSync(envPath, "utf8").replace(
      /^TAMA_MCP_ALLOWED_ORIGINS=.*$/mu,
      "TAMA_MCP_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:4000",
    ),
  );
  const matching = await command(["env", "doctor", root, "--json"], root);
  assert.equal(matching.exitCode, 0, matching.stdout);
  writeFileSync(
    envPath,
    readFileSync(envPath, "utf8").replace(
      /^TAMA_MCP_ALLOWED_ORIGINS=.*$/mu,
      "TAMA_MCP_ALLOWED_ORIGINS=http://localhost:4000",
    ),
  );
  const missing = await command(["env", "doctor", root, "--json"], root);
  const document = JSON.parse(missing.stdout);
  assert.equal(missing.exitCode, 4);
  assert.equal(
    document.files.find((file) => file.role === "core").status,
    "public-configuration-conflict",
  );
});

test("dry-run reports the same credential refusal as a write and does not generate keys", async () => {
  const root = standardRoot();
  const postgres = join(root, "tama/.tama.postgres.env");
  writeFileSync(
    postgres,
    readFileSync(postgres, "utf8").replace(/^POSTGRES_USER=.*$/mu, 'POSTGRES_USER="bad user"'),
  );
  rmSync(join(root, "tama/.tama.env"));
  const preview = await command(["env", "init", root, "--dry-run", "--json"], root);
  const previewDoc = JSON.parse(preview.stdout);
  assert.equal(preview.exitCode, 4);
  assert.match(previewDoc.blockers.join("\n"), /cannot be re-emitted safely/u);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  const applied = await command(["env", "init", root, "--json"], root);
  const appliedDoc = JSON.parse(applied.stdout);
  assert.equal(applied.exitCode, 4);
  assert.match(appliedDoc.blockers.join("\n"), /cannot be re-emitted safely/u);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
});

test("a malformed receipt does not hide a later incomplete generation", async () => {
  const root = standardRoot();
  const first = JSON.parse(readFileSync(join(root, "tama/.tama-kit.json"), "utf8"));
  writeFileSync(join(root, "tama/.tama-kit.json"), "{ not json");
  writeFileSync(
    join(root, "tama/.tama-kit-mcp-app.json"),
    JSON.stringify({
      ...first,
      operation: { ...first.operation, kind: "mcp-app", id: "mcp-app-1" },
      progress: {
        status: "incomplete",
        pendingDestinations: ["tama/.tama.env"],
      },
    }),
  );
  rmSync(join(root, "tama/.tama.postgres.env"));
  const blocked = await command(["env", "init", root, "--json"], root);
  const blockedDoc = JSON.parse(blocked.stdout);
  assert.equal(blocked.exitCode, 4);
  assert.match(blockedDoc.blockers.join("\n"), /tama\/.tama-kit-mcp-app.json/u);
  assert.match(blockedDoc.warnings.join("\n"), /tama\/.tama-kit.json could not be read/u);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), false);
  writeFileSync(
    join(root, "tama/.tama-kit-mcp-app.json"),
    JSON.stringify({
      ...first,
      operation: { ...first.operation, kind: "mcp-app", id: "mcp-app-1" },
      progress: { status: "complete" },
    }),
  );
  const allowed = await command(["env", "init", root, "--json"], root);
  assert.equal(allowed.exitCode, 0, allowed.stdout);
  assert.equal(existsSync(join(root, "tama/.tama.postgres.env")), true);
});

function runtimeLayer(root, content, options = {}) {
  const path = join(root, "runtime.env");
  writeFileSync(path, content, { mode: 0o600 });
  const files = options.beforeCore
    ? ["./runtime.env", "./tama/.tama.env"]
    : ["./tama/.tama.env", "./runtime.env"];
  writeFileSync(
    join(root, "compose.override.yaml"),
    `services:\n  tama:\n    env_file: !override\n${files.map((file) => `      - path: ${file}\n${options.raw && file.endsWith("runtime.env") ? "        format: raw\n" : ""}`).join("")}${options.inline ? `    environment:\n      DATABASE_URL: ${JSON.stringify(options.inline)}\n` : ""}`,
  );
  return path;
}

const layeredOptions = (root, dryRun = false, fresh = false) => ({
  cwd: root,
  targetPath: root,
  composeFiles: ["compose.yaml", "compose.override.yaml"],
  dryRun,
  fresh,
});

test("later env-file database overrides block issuance and doctor diagnoses the effective host", async () => {
  const root = standardRoot();
  const core = join(root, "tama/.tama.env");
  const original = readFileSync(core, "utf8");
  const layer = runtimeLayer(root, 'DATABASE_URL="ecto://app:fixture@external.example/app"\n');
  const before = snapshot(root);
  const doctor = await runEnvironmentDoctor(layeredOptions(root));
  assert.equal(doctor.ok, false);
  assert.match(doctor.warnings.join("\n"), /DATABASE_URL host does not match/u);
  assert.equal(
    doctor.files.find((file) => file.role === "core").status,
    "public-configuration-conflict",
  );
  assert.deepEqual(snapshot(root), before);
  rmSync(core);
  for (const fresh of [false, true]) {
    for (const dryRun of [true, false]) {
      const result = await runEnvironmentInit(layeredOptions(root, dryRun, fresh), {
        execute: fakeDocker().execute,
      });
      assert.equal(result.ok, false);
      assert.notEqual(result.persistence.status, "absent");
      assert.match(result.blockers.join("\n"), /DATABASE_URL host does not match/u);
      assert.deepEqual(result.changes, []);
      assert.equal(existsSync(core), false);
      assert.doesNotMatch(JSON.stringify(result), /ecto:\/\/app:fixture/u);
    }
  }
  assert.equal(
    readFileSync(layer, "utf8"),
    'DATABASE_URL="ecto://app:fixture@external.example/app"\n',
  );
  writeFileSync(core, original, { mode: 0o600 });
});

test("an earlier env-file override is superseded by the recovered core", async () => {
  const root = standardRoot();
  runtimeLayer(root, "DATABASE_URL=ecto://app:fixture@external.example/app\n", {
    beforeCore: true,
  });
  rmSync(join(root, "tama/.tama.env"));
  const preview = await runEnvironmentInit(layeredOptions(root, true), {
    execute: fakeDocker().execute,
  });
  assert.equal(preview.ok, true, preview.blockers.join("\n"));
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  const result = await runEnvironmentInit(layeredOptions(root), {
    execute: fakeDocker().execute,
  });
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.equal(result.persistence.status, "absent");
  assert.equal((await runEnvironmentDoctor(layeredOptions(root))).ok, true);
});

test("ordered Compose files and inline environment override env-file database settings", async () => {
  const root = standardRoot();
  const values = parseEnvironment(readFileSync(join(root, "tama/.tama.env"), "utf8"), "core");
  runtimeLayer(root, "DATABASE_URL=ecto://app:fixture@external.example/app\n");
  writeFileSync(
    join(root, "compose.inline.yaml"),
    `services:\n  tama:\n    environment:\n      DATABASE_URL: ${JSON.stringify(values.get("DATABASE_URL"))}\n`,
  );
  rmSync(join(root, "tama/.tama.env"));
  const options = {
    ...layeredOptions(root),
    composeFiles: ["compose.yaml", "compose.override.yaml", "compose.inline.yaml"],
  };
  const result = await runEnvironmentInit(options, {
    execute: fakeDocker().execute,
  });
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.equal(result.persistence.status, "absent");
  assert.equal((await runEnvironmentDoctor(options)).ok, true);
});

test("a matching later local database layer preserves credentials and detects local persistence", async () => {
  const root = standardRoot();
  const values = parseEnvironment(readFileSync(join(root, "tama/.tama.env"), "utf8"), "core");
  runtimeLayer(root, `DATABASE_URL=${values.get("DATABASE_URL")}\n`);
  rmSync(join(root, "tama/.tama.env"));
  const blocked = await runEnvironmentInit(layeredOptions(root, false, true), {
    execute: fakeDocker({
      volumeExists: true,
      volumeNames: ["tama-postgres-data"],
    }).execute,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.persistence.status, "detected");
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  const result = await runEnvironmentInit(layeredOptions(root), {
    execute: fakeDocker().execute,
  });
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.equal((await runEnvironmentDoctor(layeredOptions(root))).ok, true);
});

test("native env-file parsing preserves raw values and refuses dependencies on missing credentials", async () => {
  const root = standardRoot();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation must remain literal in this fixture.
  runtimeLayer(root, "DATABASE_URL=ecto://app:${POSTGRES_PASSWORD}@tama-postgres/app\n");
  rmSync(join(root, "tama/.tama.env"));
  for (const dryRun of [true, false]) {
    const result = await runEnvironmentInit(layeredOptions(root, dryRun), {
      execute: fakeDocker().execute,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /DATABASE_URL depends on missing core variables/u);
    assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  }
  runtimeLayer(
    root,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: raw env-file syntax must remain literal in this fixture.
    "DATABASE_URL=ecto://app:${UNSET_PASSWORD}@external.example/app\nRAW_DOLLARS=a$$b\n",
    {
      raw: true,
    },
  );
  writeFileSync(join(root, ".env"), "UNSET_PASSWORD=expanded\n");
  const inspection = inspectComposeDeclarations(layeredOptions(root));
  const effective = loadComposeServiceEnvironment(inspection, "tama", {
    missingPaths: [],
    suppliedVariables: [],
  });
  assert.equal(
    effective.values.get("DATABASE_URL"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: raw Compose parsing must preserve this literal value.
    "ecto://app:${UNSET_PASSWORD}@external.example/app",
  );
  assert.equal(effective.values.get("RAW_DOLLARS"), "a$$b");
  const result = await runEnvironmentInit(layeredOptions(root), {
    execute: fakeDocker().execute,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /DATABASE_URL host does not match/u);
});

test("empty and unset inline database overrides cannot fall back to the example", async () => {
  for (const override of ['""', "null"]) {
    const root = standardRoot();
    writeFileSync(
      join(root, "compose.override.yaml"),
      `services:\n  tama:\n    environment:\n      DATABASE_URL: ${override}\n`,
    );
    assert.equal((await runEnvironmentDoctor(layeredOptions(root))).ok, false);
    rmSync(join(root, "tama/.tama.env"));
    const result = await runEnvironmentInit(layeredOptions(root), {
      execute: fakeDocker().execute,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /DATABASE_URL does not name a database host/u);
    assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  }
});

test("effective database credential conflicts fail doctor and both recovery modes", async () => {
  const root = standardRoot();
  runtimeLayer(root, "DATABASE_URL=ecto://tama:conflicting-password@tama-postgres/tama\n");
  const doctor = await runEnvironmentDoctor(layeredOptions(root));
  assert.equal(doctor.ok, false);
  assert.match(
    doctor.files.find((file) => file.role === "core").issues.join("\n"),
    /effective Compose environment: DATABASE_URL password does not match/u,
  );
  rmSync(join(root, "tama/.tama.env"));
  for (const dryRun of [true, false]) {
    const result = await runEnvironmentInit(layeredOptions(root, dryRun), {
      execute: fakeDocker().execute,
    });
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /DATABASE_URL password does not match/u);
    assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  }
});

test("accepted recovered credentials are encoded, preserved and pass doctor", async () => {
  const root = standardRoot();
  const credentials = {
    user: "app/name+part",
    password: "abc/def+ghi",
    database: "app/db+part",
    host: "tama-postgres",
  };
  const postgres = join(root, "tama/.tama.postgres.env");
  writeFileSync(
    postgres,
    postgresEnvironment(
      new Map([
        ["POSTGRES_USER", credentials.user],
        ["POSTGRES_PASSWORD", credentials.password],
        ["POSTGRES_DB", credentials.database],
      ]),
      "postgres",
    ),
  );
  const before = readFileSync(postgres, "utf8");
  rmSync(join(root, "tama/.tama.env"));
  const preview = await runEnvironmentInit(
    { cwd: root, dryRun: true, fresh: false },
    { execute: fakeDocker().execute },
  );
  assert.equal(preview.ok, true, preview.blockers.join("\n"));
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  const result = await runEnvironmentInit(
    { cwd: root, dryRun: false, fresh: false },
    { execute: fakeDocker().execute },
  );
  assert.equal(result.ok, true, result.blockers.join("\n"));
  const values = parseEnvironment(readFileSync(join(root, "tama/.tama.env"), "utf8"), "core");
  const url = new URL(values.get("DATABASE_URL"));
  assert.equal(decodeURIComponent(url.username), credentials.user);
  assert.equal(decodeURIComponent(url.password), credentials.password);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), credentials.database);
  assert.equal(values.get("DATABASE_URL"), serializeDatabaseUrl(credentials));
  assert.equal(readFileSync(postgres, "utf8"), before);
  assert.equal((await runEnvironmentDoctor({ cwd: root })).ok, true);
  assert.doesNotMatch(JSON.stringify(result), /abc\/def/u);
});

test("malformed credential encoding produces a safe diagnosis", () => {
  const values = new Map([
    ["DATABASE_URL", "ecto://app:bad%ZZ@tama-postgres/app"],
    ["POSTGRES_PASSWORD", "fixture"],
  ]);
  assert.deepEqual(databaseUrlIssues(values, "tama-postgres"), [
    "DATABASE_URL has invalid credential encoding",
  ]);
});

test("changed env-file inputs abort recovery without creating a core", async () => {
  const root = standardRoot();
  const values = parseEnvironment(readFileSync(join(root, "tama/.tama.env"), "utf8"), "core");
  const layer = runtimeLayer(root, `DATABASE_URL=${values.get("DATABASE_URL")}\n`);
  rmSync(join(root, "tama/.tama.env"));
  const docker = fakeDocker();
  let changed = false;
  await assert.rejects(
    runEnvironmentInit(layeredOptions(root), {
      execute: (command, args, options) => {
        if (args[0] === "version" && !changed) {
          changed = true;
          writeFileSync(layer, "DATABASE_URL=ecto://app:fixture@external.example/app\n");
        }
        return docker.execute(command, args, options);
      },
    }),
    /an environment recovery input changed/u,
  );
  assert.equal(changed, true);
  assert.equal(existsSync(join(root, "tama/.tama.env")), false);
});

test("URL-normalized database names are refused consistently before issuance", async () => {
  const root = standardRoot();
  const example = join(root, "tama/.tama.env.example");
  writeFileSync(
    example,
    readFileSync(example, "utf8").replace(/^POSTGRES_DB=.*/mu, "POSTGRES_DB=.."),
  );
  rmSync(join(root, "tama/.tama.env"));
  rmSync(join(root, "tama/.tama.postgres.env"));
  for (const dryRun of [true, false]) {
    const result = await runEnvironmentInit(
      { cwd: root, dryRun, fresh: false },
      { execute: fakeDocker().execute },
    );
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /DATABASE_URL database does not match POSTGRES_DB/u);
    assert.deepEqual(result.changes, []);
    assert.equal(existsSync(join(root, "tama/.tama.env")), false);
  }
});

function envValues(root, path) {
  return parseEnvironment(readFileSync(join(root, path), "utf8"), path);
}

function assertSigning(values, key, kid) {
  assert.doesNotThrow(() => validateOAuthPrivateJwk(values.get(key), values.get(kid), key, kid));
  return JSON.parse(values.get(key)).n;
}

function recovery(root, options = {}, execute = fakeDocker().execute) {
  return runEnvironmentInit({ cwd: root, dryRun: false, fresh: true, ...options }, { execute });
}

function additionFixture(https = false) {
  const root = standardRoot();
  const selection = { cwd: root };
  const current = inspectCurrentConfiguration(selection);
  const prepared = preparedFor(root);
  if (https) prepared.allowedOrigins = ["https://app.localhost"];
  const addition = planMcpAppAddition(
    current,
    {
      cwd: root,
      image: "ghcr.io/upmaru/tama:0.13.2-server",
      selection,
      ...(https
        ? { localDomain: "app.localhost" }
        : { providerOrigin: "http://host.docker.internal:4100" }),
    },
    prepared,
    { id: "env-recovery-test" },
    true,
  );
  // Environment recovery does not create or inspect CA/certificates.
  applyOperations(
    addition.plan.operations.filter((operation) => !operation.path.includes("/mcp-app-tls/")),
  );
  return { root, composeFiles: ["compose.yaml", "tama/compose.mcp-app.yaml"] };
}

function composeProvider(root, { external = false, binds = false } = {}) {
  const path = join(root, "compose.yaml");
  const model = parse(readFileSync(path, "utf8"));
  model.services ??= {};
  model.volumes ??= {};
  model.services.provider = {
    image: "example/provider:dev",
    env_file: ["./tama/.memovee.integration.env"],
    environment: {
      DATABASE_URL: `ecto://provider:local@${external ? "external.example" : "provider-db"}/provider`,
    },
    depends_on: { "provider-db": { condition: "service_started" } },
    ...(binds ? { volumes: ["./provider-data:/data"] } : {}),
  };
  model.services["provider-db"] = {
    image: "postgres:16",
    volumes: ["provider-data:/var/lib/postgresql/data"],
  };
  model.volumes["provider-data"] = {};
  writeFileSync(path, stringify(model));
}

test("MCP recovery restores only a host provider fragment, preserves keys and reports prepared activation", async () => {
  const { root } = mcpFixture();
  const oldProvider = envValues(root, "tama/.memovee.integration.env");
  rmSync(join(root, "tama/.memovee.integration.env"));
  const before = snapshot(root);
  const preview = await recovery(root, { dryRun: true });
  assert.equal(preview.ok, true, preview.blockers.join("\n"));
  assert.deepEqual(snapshot(root), before);
  const result = await recovery(root);
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.deepEqual(
    result.changes.map((change) => change.relative),
    ["tama/.memovee.integration.env"],
  );
  assert.equal(result.persistence.freshAsserted, true);
  for (const entry of before)
    assert.deepEqual(
      snapshot(root).find((current) => current[0] === entry[0]),
      entry,
    );
  const provider = envValues(root, "tama/.memovee.integration.env");
  assert.equal(provider.get("MEMOVEE_TAMA_MCP_APP_MODE"), "prepared");
  assert.notEqual(
    provider.get("MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY"),
    oldProvider.get("MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY"),
  );
  assertSigning(provider, "MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY", "MEMOVEE_OAUTH_SIGNING_KEY_ID");
  assert.equal(statSync(join(root, "tama/.memovee.integration.env")).mode & 0o777, 0o600);
  assert.match(result.nextActions.join("\n"), /tama-kit setup --activate/u);
  assert.doesNotMatch(result.nextActions.join("\n"), /tama-kit activate/u);
  assert.ok(!JSON.stringify(result).includes(provider.get("MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY")));
  assert.equal(
    (await runEnvironmentDoctor({ cwd: root }, { execute: fakeDocker().execute })).ok,
    true,
  );
  const again = await recovery(root, { fresh: false });
  assert.equal(again.ok, true, again.blockers.join("\n"));
  assert.deepEqual(again.changes, []);
});

for (const https of [false, true]) {
  test(`MCP recovery restores combined ${https ? "HTTPS" : "HTTP"} private files with independent signing keys`, async () => {
    const fixture = https
      ? (() => {
          const root = temporaryDirectory("tama-env-https-");
          const prepared = preparedFor(root);
          prepared.allowedOrigins = ["https://app.localhost"];
          applyOperations(planWithMcp(root, prepared, { localDomain: "app.localhost" }).operations);
          return { root };
        })()
      : mcpFixture();
    const { root } = fixture;
    for (const path of [
      "tama/.tama.env",
      "tama/.tama.postgres.env",
      "tama/.memovee.integration.env",
    ])
      rmSync(join(root, path));
    const before = snapshot(root);
    const result = await recovery(root);
    assert.equal(result.ok, true, result.blockers.join("\n"));
    assert.equal(result.changes.length, 3);
    for (const entry of before)
      assert.deepEqual(
        snapshot(root).find((current) => current[0] === entry[0]),
        entry,
      );
    const tama = envValues(root, "tama/.tama.env");
    const provider = envValues(root, "tama/.memovee.integration.env");
    const moduli = [
      assertSigning(tama, "TAMA_OAUTH_PRIVATE_JWK", "TAMA_OAUTH_PRIVATE_JWK_ID"),
      assertSigning(
        tama,
        "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
        "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
      ),
      assertSigning(provider, "MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY", "MEMOVEE_OAUTH_SIGNING_KEY_ID"),
    ];
    assert.equal(new Set(moduli).size, 3);
    assert.equal(tama.get("TAMA_MCP_APP_MODE"), "prepared");
    assert.equal(tama.get("TAMA_MCP_APP_INTROSPECTION_PUBLIC_KEYS"), "[]");
    assert.equal(provider.get("MEMOVEE_OAUTH_PUBLIC_SIGNING_KEYS"), "[]");
    assert.equal(
      tama.get("POSTGRES_PASSWORD"),
      envValues(root, "tama/.tama.postgres.env").get("POSTGRES_PASSWORD"),
    );
    for (const change of result.changes)
      assert.equal(statSync(join(root, change.relative)).mode & 0o777, 0o600);
    if (https) assert.equal(tama.get("TAMA_BASE_URL"), "https://tama.app.localhost");
    const doctor = await runEnvironmentDoctor({ cwd: root }, { execute: fakeDocker().execute });
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
  });

  test(`MCP recovery restores additive ${https ? "HTTPS" : "HTTP"} fragments without touching base core or TLS`, async () => {
    const { root, composeFiles } = additionFixture(https);
    for (const path of ["tama/.mcp-app.env", "tama/.memovee.integration.env"])
      rmSync(join(root, path));
    const before = snapshot(root);
    const result = await recovery(root, { composeFiles });
    assert.equal(result.ok, true, result.blockers.join("\n"));
    assert.equal(result.changes.length, 2);
    for (const entry of before)
      assert.deepEqual(
        snapshot(root).find((current) => current[0] === entry[0]),
        entry,
      );
    assert.equal(existsSync(join(root, "tama/mcp-app-tls")), false);
    const fragment = envValues(root, "tama/.mcp-app.env");
    assert.equal(fragment.get("TAMA_MCP_APP_MODE"), "prepared");
    if (https) {
      assert.equal(fragment.get("TAMA_BASE_URL"), "https://tama.app.localhost");
      assert.equal(fragment.get("TAMA_PORT"), "4000");
      assert.match(result.nextActions.join("\n"), /mkcert/u);
    }
    const doctor = await runEnvironmentDoctor(
      { cwd: root, composeFiles },
      { execute: fakeDocker().execute },
    );
    assert.equal(doctor.ok, true, JSON.stringify(doctor));
  });
}

test("MCP recovery refuses an older additive HTTP project when both fragments lack public examples", async () => {
  const { root, composeFiles } = additionFixture();
  for (const path of [
    "tama/.mcp-app.env",
    "tama/.memovee.integration.env",
    "tama/.mcp-app.env.example",
    "tama/.memovee.integration.env.example",
  ])
    rmSync(join(root, path));
  const before = snapshot(root);
  const result = await recovery(root, { composeFiles });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /public MCP App .* is missing/u);
  assert.deepEqual(snapshot(root), before);
});

for (const mode of ["enabled", "disabled"]) {
  for (const lost of ["tama/.tama.env", "tama/.memovee.integration.env"]) {
    test(`MCP recovery preserves and refuses a surviving ${mode} peer when ${lost} is lost`, async () => {
      const { root } = mcpFixture();
      const peer = lost === "tama/.tama.env" ? "tama/.memovee.integration.env" : "tama/.tama.env";
      const path = join(root, peer);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(/(TAMA_MCP_APP_MODE=)prepared/u, `$1${mode}`),
      );
      rmSync(join(root, lost));
      const before = snapshot(root);
      const result = await recovery(root);
      assert.equal(result.ok, false);
      assert.match(result.blockers.join("\n"), /mode.*prepared/u);
      assert.deepEqual(snapshot(root), before);
    });
  }
}

test("MCP recovery rejects effective mode and signing overrides before issuing keys", async () => {
  for (const variables of [
    { TAMA_MCP_APP_MODE: "enabled" },
    { MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY: "surviving-key" },
  ]) {
    const { root } = mcpFixture();
    composeProvider(root);
    const path = join(root, "compose.yaml");
    const model = parse(readFileSync(path, "utf8"));
    const basePath = join(root, "tama/compose.yaml");
    const base = parse(readFileSync(basePath, "utf8"));
    const service = Object.keys(variables)[0].startsWith("TAMA_") ? "tama" : "provider";
    const target = service === "tama" ? base : model;
    target.services[service].environment = {
      ...target.services[service].environment,
      ...variables,
    };
    writeFileSync(service === "tama" ? basePath : path, stringify(target));
    rmSync(join(root, "tama/.memovee.integration.env"));
    const before = snapshot(root);
    const result = await recovery(root);
    assert.equal(result.ok, false);
    assert.match(result.blockers.join("\n"), /mode|shadow/u);
    assert.deepEqual(snapshot(root), before);
  }
});

test("MCP recovery verifies absence of both Compose databases without a fresh assertion", async () => {
  const { root } = mcpFixture();
  composeProvider(root);
  rmSync(join(root, "tama/.memovee.integration.env"));
  const result = await recovery(root, { fresh: false });
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.equal(result.persistence.status, "absent");
  assert.ok(result.persistence.checked.some((name) => name.includes("provider-data")));
  assert.equal(
    result.files.filter((file) => file.relative === "tama/.memovee.integration.env").length,
    1,
  );
});

for (const evidence of ["database-volume", "provider-bind", "stopped-container"]) {
  test(`MCP recovery refuses ${evidence} even with fresh and an external provider database`, async () => {
    const { root } = mcpFixture();
    composeProvider(root, { external: true, binds: evidence === "provider-bind" });
    rmSync(join(root, "tama/.memovee.integration.env"));
    if (evidence === "provider-bind") {
      mkdirSync(join(root, "provider-data"));
      writeFileSync(join(root, "provider-data/state"), "persisted");
    }
    const docker = fakeDocker({
      volumeExists: evidence === "database-volume",
      volumeNames: ["provider-data"],
    });
    const execute = (command, args, options) => {
      if (
        evidence === "stopped-container" &&
        args[0] === "ps" &&
        args.includes("label=com.docker.compose.service=provider")
      )
        return "stopped-provider";
      return docker.execute(command, args, options);
    };
    const before = snapshot(root);
    const result = await recovery(root, {}, execute);
    assert.equal(result.ok, false);
    assert.equal(result.persistence.status, "detected");
    assert.deepEqual(snapshot(root), before);
  });
}

test("MCP recovery rolls back when provider persistence appears during the write", async () => {
  const { root } = mcpFixture();
  composeProvider(root);
  const fragment = join(root, "tama/.memovee.integration.env");
  rmSync(fragment);
  const before = snapshot(root);
  const docker = fakeDocker();
  const execute = (command, args, options) => {
    if (existsSync(fragment) && args[0] === "volume" && args[2] === "provider-data")
      return '[{"Name":"provider-data"}]';
    return docker.execute(command, args, options);
  };
  await assert.rejects(recovery(root, {}, execute), /persistence appeared/u);
  assert.deepEqual(snapshot(root), before);
});

test("MCP recovery examples never publish private signing material or key ids", () => {
  const { root } = mcpFixture();
  const example = envValues(root, "tama/.memovee.integration.env.example");
  assert.equal(example.get("MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY"), "replace-me");
  assert.equal(example.get("MEMOVEE_OAUTH_SIGNING_KEY_ID"), "replace-me");
  assert.equal(
    example.get("MEMOVEE_OAUTH_ISSUER"),
    envValues(root, "tama/.memovee.integration.env").get("MEMOVEE_OAUTH_ISSUER"),
  );
  assert.ok(
    !readFileSync(join(root, "tama/.memovee.integration.env.example"), "utf8").includes('"d":'),
  );
});

test("MCP recovery follows current custom bindings, relocated provider files and renamed services", async () => {
  const root = temporaryDirectory("tama-env-custom-");
  const document = memoveeContract();
  const bindings = Object.fromEntries(
    Object.entries(document.bindings).map(([role, name]) => [
      role,
      name.replace("MEMOVEE_", "CUSTOM_"),
    ]),
  );
  document.provider.environment_prefix = "CUSTOM";
  document.provider.environment_file = "tama/private/.custom.integration.env";
  document.bindings = bindings;
  document.variables = Object.fromEntries(
    Object.entries(document.variables).map(([name, descriptor]) => [
      name.replace("MEMOVEE_", "CUSTOM_"),
      {
        ...descriptor,
        ...(descriptor.same_origin_as ? { same_origin_as: bindings.resource } : {}),
      },
    ]),
  );
  document.environment_loading.loads = document.provider.environment_file;
  const prepared = preparedFor(root, {
    identity: {
      name: "memovee",
      environmentPrefix: "CUSTOM",
      environmentFile: document.provider.environment_file,
      source: "contract",
    },
    contractPath: writeContract(root, document),
    contractDocument: validateMcpAppContract(document),
  });
  applyOperations(planWithMcp(root, prepared).operations);
  const composePath = join(root, "tama/compose.yaml");
  const model = parse(readFileSync(composePath, "utf8"));
  model.services.runtime = model.services.tama;
  delete model.services.tama;
  model.services.database = model.services["tama-postgres"];
  delete model.services["tama-postgres"];
  model.services.runtime.depends_on.database = model.services.runtime.depends_on["tama-postgres"];
  delete model.services.runtime.depends_on["tama-postgres"];
  writeFileSync(composePath, stringify(model));
  for (const path of ["tama/.tama.env", "tama/.tama.env.example"])
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), "utf8").replaceAll("@tama-postgres/", "@database/"),
    );
  const contractPath = "tama/contracts/current.json";
  renameSync(join(root, "tama/contracts/mcp-app-provider-v1.json"), join(root, contractPath));
  rmSync(join(root, document.provider.environment_file));
  const before = snapshot(root);
  const result = await recovery(root, { service: "runtime", contractPath });
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.deepEqual(
    result.changes.map((change) => change.relative),
    [document.provider.environment_file],
  );
  for (const entry of before)
    assert.deepEqual(
      snapshot(root).find((current) => current[0] === entry[0]),
      entry,
    );
  const provider = envValues(root, document.provider.environment_file);
  assert.equal(provider.get(bindings.mode), "prepared");
  assertSigning(
    provider,
    bindings.access_token_private_signing_key,
    bindings.access_token_signing_key_id,
  );
});

for (const lost of ["tama/.mcp-app.env", "tama/.memovee.integration.env"]) {
  test(`MCP recovery can use surviving additive HTTP public inputs when ${lost} is missing`, async () => {
    const { root, composeFiles } = additionFixture();
    for (const path of [lost, "tama/.mcp-app.env.example", "tama/.memovee.integration.env.example"])
      rmSync(join(root, path));
    // Provider fragments do not declare browser origins. Older projects must
    // still supply that input when their Tama fragment is lost.
    if (lost === "tama/.mcp-app.env")
      writeFileSync(
        join(root, "tama/.mcp-app.env.example"),
        "TAMA_MCP_APP_ALLOWED_ORIGINS='http://127.0.0.1:3000'\n",
      );
    const result = await recovery(root, { composeFiles });
    assert.equal(result.ok, true, result.blockers.join("\n"));
    assert.deepEqual(
      result.changes.map((change) => change.relative),
      [lost],
    );
  });
}

test("MCP recovery refuses a missing contract rather than issuing standard-only keys", async () => {
  const { root } = mcpFixture();
  for (const path of ["tama/contracts/mcp-app-provider-v1.json", "tama/.tama.env"])
    rmSync(join(root, path));
  const before = snapshot(root);
  const result = await recovery(root);
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /restore the contract/u);
  assert.deepEqual(snapshot(root), before);
});

test("MCP recovery diagnoses missing public fields in surviving private files without repairing them", async () => {
  const { root } = mcpFixture();
  const path = join(root, "tama/.memovee.integration.env");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^MEMOVEE_OAUTH_SIGNING_ALGORITHM=.*\n/mu, ""),
  );
  const before = snapshot(root);
  const doctor = await runEnvironmentDoctor({ cwd: root }, { execute: fakeDocker().execute });
  assert.equal(doctor.ok, false);
  const result = await recovery(root);
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /MEMOVEE_OAUTH_SIGNING_ALGORITHM is missing/u);
  assert.deepEqual(snapshot(root), before);
});

test("MCP recovery rejects stale public examples and rolls back a late effective signing shadow", async () => {
  const { root } = mcpFixture();
  const providerPath = join(root, "tama/.memovee.integration.env");
  rmSync(providerPath);
  const examplePath = `${providerPath}.example`;
  const original = readFileSync(examplePath, "utf8");
  writeFileSync(
    examplePath,
    original.replace(/(MEMOVEE_OAUTH_ISSUER=).*$/mu, "$1'https://stale.example'"),
  );
  const before = snapshot(root);
  const preview = await recovery(root, { dryRun: true });
  assert.equal(preview.ok, false);
  assert.match(preview.blockers.join("\n"), /inputs disagree/u);
  assert.deepEqual(snapshot(root), before);
  writeFileSync(examplePath, original);
  // A native effective environment that changes after creation cannot retain the new fragment.
  composeProvider(root);
  const expected = snapshot(root);
  const docker = fakeDocker();
  const execute = (command, args, options) => {
    const output = docker.execute(command, args, options);
    if (existsSync(providerPath) && args[0] === "compose" && args.includes("-")) {
      const model = JSON.parse(output);
      if (model.services.runtime.environment.MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY) {
        model.services.runtime.environment.MEMOVEE_OAUTH_PRIVATE_SIGNING_KEY = "late-shadow";
        return JSON.stringify(model);
      }
    }
    return output;
  };
  await assert.rejects(recovery(root, {}, execute), /shadowed or inconsistent/u);
  assert.deepEqual(snapshot(root), expected);
});

test("MCP public examples omit unrelated application secrets from an older surviving provider file", () => {
  const { root, plan } = mcpFixture();
  const fragment = join(root, "tama/.memovee.integration.env");
  writeFileSync(
    fragment,
    `${readFileSync(fragment, "utf8")}APPLICATION_TOKEN=private-application-value\n`,
  );
  rmSync(`${fragment}.example`);
  const prepared = preparedFor(root, {
    contractPath: plan.mcpApp.contractPath,
    contractDocument: validateMcpAppContract(memoveeContract()),
  });
  const next = planWithMcp(root, prepared);
  const example = next.operations.find((operation) => operation.path === `${fragment}.example`);
  assert.equal(example.action, "create");
  assert.doesNotMatch(example.content, /APPLICATION_TOKEN|private-application-value|"d":/u);
});

test("older interrupted combined and additive generation can resume without unrecorded examples", () => {
  const { root, plan } = mcpFixture();
  rmSync(join(root, "tama/.memovee.integration.env.example"));
  rmSync(join(root, "tama/README.md"));
  const pending = ["tama/README.md"];
  const resumed = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    image: "ghcr.io/upmaru/tama:0.13.2-server",
    resumePending: pending,
    mcpApp: { requested: true, activate: false, allowedOrigins: ["http://127.0.0.1:3000"] },
    mcpAppPrepared: preparedFor(root, {
      contractPath: plan.mcpApp.contractPath,
      contractDocument: validateMcpAppContract(memoveeContract()),
    }),
  });
  assert.ok(
    !resumed.operations.some((operation) => operation.path.endsWith(".integration.env.example")),
  );

  const additiveRoot = standardRoot();
  const selection = { cwd: additiveRoot };
  const current = inspectCurrentConfiguration(selection);
  const options = {
    cwd: additiveRoot,
    image: "ghcr.io/upmaru/tama:0.13.2-server",
    selection,
    providerOrigin: "http://host.docker.internal:4100",
  };
  const first = planMcpAppAddition(
    current,
    options,
    preparedFor(additiveRoot),
    { id: "old-generation" },
    true,
  );
  const older = first.plan.operations.filter(
    (operation) => !operation.path.endsWith(".env.example"),
  );
  applyOperations(older.filter((operation) => !operation.path.endsWith("MCP_APP.md")));
  const again = planMcpAppAddition(
    current,
    options,
    preparedFor(additiveRoot),
    { id: "old-generation", pending: ["tama/MCP_APP.md"] },
    true,
  );
  assert.ok(!again.plan.operations.some((operation) => operation.path.endsWith(".env.example")));
  assert.deepEqual(
    again.plan.operations
      .filter((operation) => operation.action === "create")
      .map((operation) => operation.path),
    [join(additiveRoot, "tama/MCP_APP.md")],
  );
});

test("MCP recovery refuses a changed included Compose declaration and rolls back new files", async () => {
  const { root } = mcpFixture();
  const fragment = join(root, "tama/.memovee.integration.env");
  rmSync(fragment);
  const compose = join(root, "tama/compose.yaml");
  const original = readFileSync(compose, "utf8");
  const docker = fakeDocker();
  let changed = false;
  const execute = (command, args, options) => {
    if (!changed && existsSync(fragment) && args[0] === "compose") {
      const model = parse(original);
      model.services.tama.environment = { TAMA_MCP_APP_MODE: "enabled" };
      writeFileSync(compose, stringify(model));
      changed = true;
    }
    return docker.execute(command, args, options);
  };
  await assert.rejects(recovery(root, {}, execute), /Compose declarations changed/u);
  assert.equal(existsSync(fragment), false);
  assert.equal(changed, true);
  assert.match(readFileSync(compose, "utf8"), /TAMA_MCP_APP_MODE: enabled/u);
});

test("MCP recovery still requires its contract when public examples use export assignments", async () => {
  const { root } = mcpFixture();
  const example = join(root, "tama/.tama.env.example");
  writeFileSync(
    example,
    readFileSync(example, "utf8").replace(/^TAMA_MCP_APP_MODE=/mu, "export TAMA_MCP_APP_MODE="),
  );
  for (const path of ["tama/.tama.env", "tama/contracts/mcp-app-provider-v1.json"])
    rmSync(join(root, path));
  const before = snapshot(root);
  const result = await recovery(root);
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /restore the contract/u);
  assert.deepEqual(snapshot(root), before);
});

test("MCP derived-only recovery preserves enabled modes and succeeds with persisted data", async () => {
  const { root } = mcpFixture();
  for (const relative of ["tama/.tama.env", "tama/.memovee.integration.env"]) {
    const path = join(root, relative);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/(TAMA_MCP_APP_MODE=)prepared/u, "$1enabled"),
    );
  }
  rmSync(join(root, "tama/.tama.postgres.env"));
  const before = snapshot(root);
  const result = await recovery(
    root,
    { fresh: false },
    fakeDocker({ volumeExists: true, volumeNames: ["tama-postgres-data"] }).execute,
  );
  assert.equal(result.ok, true, result.blockers.join("\n"));
  assert.equal(result.persistence.status, "not-required");
  assert.equal(result.files.find((file) => file.created).issuance, "derived");
  for (const entry of before)
    assert.deepEqual(
      snapshot(root).find((current) => current[0] === entry[0]),
      entry,
    );
});

test("env doctor deduplicates provider declarations and retains required contract ownership and services", async () => {
  const { root } = mcpFixture();
  composeProvider(root);
  const compose = join(root, "compose.yaml");
  const model = parse(readFileSync(compose, "utf8"));
  const reference = { path: "./tama/.memovee.integration.env", required: false };
  model.services.provider.env_file = [reference];
  model.services["provider-worker"] = { image: "example/provider:dev", env_file: [reference] };
  writeFileSync(compose, stringify(model));
  const options = { cwd: root, providerService: "provider" };
  const before = snapshot(root);
  const healthy = await runEnvironmentDoctor(options, { execute: fakeDocker().execute });
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  const reports = healthy.files.filter((file) => file.relative === "tama/.memovee.integration.env");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "contract");
  assert.equal(reports[0].role, "provider");
  assert.equal(reports[0].required, true);
  assert.deepEqual(reports[0].services, ["provider", "provider-worker"]);
  assert.deepEqual(snapshot(root), before);

  rmSync(join(root, "tama/.memovee.integration.env"));
  const missingSnapshot = snapshot(root);
  const missing = await runEnvironmentDoctor(options, { execute: fakeDocker().execute });
  assert.equal(missing.ok, false);
  const missingReports = missing.files.filter(
    (file) => file.relative === "tama/.memovee.integration.env",
  );
  assert.equal(missingReports.length, 1);
  assert.equal(missingReports[0].status, "missing");
  assert.equal(missingReports[0].required, true);
  assert.equal(
    missing.nextActions.filter((action) =>
      action.startsWith("Restore tama/.memovee.integration.env "),
    ).length,
    1,
  );
  assert.deepEqual(snapshot(root), missingSnapshot);
});

test("MCP recovery activation guidance uses setup and preserves quoted paths and ordered selectors", async () => {
  const parent = temporaryDirectory("tama-env-activation-selection-");
  const root = join(parent, "my project");
  mkdirSync(root);
  mcpFixture(root);
  composeProvider(root);
  const override = "runtime override.yaml";
  writeFileSync(
    join(root, override),
    "services:\n  tama:\n    environment:\n      TAMA_MCP_APP_MODE: prepared\n",
  );
  const contract = "tama/contracts/current contract.json";
  renameSync(join(root, "tama/contracts/mcp-app-provider-v1.json"), join(root, contract));
  rmSync(join(root, "tama/.memovee.integration.env"));
  const result = await runEnvironmentInit(
    {
      cwd: parent,
      targetPath: "my project",
      composeFiles: ["compose.yaml", override],
      service: "tama",
      environmentFile: "tama/.tama.env",
      contractPath: contract,
      providerService: "provider",
      fresh: false,
      dryRun: false,
    },
    { execute: fakeDocker().execute },
  );
  assert.equal(result.ok, true, result.blockers.join("\n"));
  const expected =
    "tama-kit setup 'my project' --compose compose.yaml --compose 'runtime override.yaml' --service tama --env-file tama/.tama.env --contract 'tama/contracts/current contract.json' --provider-service provider --activate";
  assert.ok(result.nextActions.some((action) => action.includes(`then use ${expected} for`)));
  assert.doesNotMatch(result.nextActions.join("\n"), /tama-kit activate/u);
  // Check the actual CLI accepts the suggested subcommand and flags without starting services.
  const help = await command(
    [
      "setup",
      "my project",
      "--compose",
      "compose.yaml",
      "--compose",
      override,
      "--service",
      "tama",
      "--env-file",
      "tama/.tama.env",
      "--contract",
      contract,
      "--provider-service",
      "provider",
      "--activate",
      "--help",
    ],
    parent,
  );
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--activate/u);
});
