import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { devSetupDiagnostic, safeDevSetupDiagnostic } from "../../cli/dev/diagnostics.mjs";
import { run } from "../../cli/index.mjs";
import { CapturedProcessError, runCapturedProcess } from "../../cli/shared/captured-process.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

const SECRET_MARKERS = [
  "super-secret-vault-value",
  "hunter2secret",
  "setup-token-value",
  "bearer-token-value",
  "jwk-private-base64-value",
  "privatepemline",
  "SECRET-CHECKSUM-VALUE",
  "container-secret-value",
  "arbitrary-private-output",
];

function assertNoSecrets(serialized) {
  for (const marker of SECRET_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(marker, "u"));
  }
}

const CHECKSUM_APPLY_OUTPUT = [
  "tofu apply -input=false",
  "TAMA_VAULT_KEY=super-secret-vault-value",
  "DATABASE_URL=postgres://tama:hunter2secret@db.internal:5432/tama",
  "http://127.0.0.1:4000/setup/root?token=setup-token-value",
  "Authorization: Bearer bearer-token-value",
  '{"alg":"RS256","kid":"staging-2026-09-01-1","d":"jwk-private-base64-value"}',
  "-----BEGIN RSA PRIVATE KEY-----",
  "privatepemline",
  "-----END RSA PRIVATE KEY-----",
  "Error: Invalid dependency lock file",
  ".terraform.lock.hcl contains an invalid checksum for the registry.opentofu.org/upmaru/tama 0.7.0 provider:",
  "  h1:SECRET-CHECKSUM-VALUE=",
  "POSTGRES_PASSWORD=container-secret-value",
  "Error: checksum verification failed: does not match any of the checksums in the lock file",
].join("\n");

const READONLY_INIT_OUTPUT = [
  "Terraform used the selected providers to generate the following execution plan.",
  "Warning: Inconsistent dependency lock file",
  "Warning: provider selection for registry.opentofu.org/upmaru/tama 0.7.0 is not recorded",
  "Terraform has been successfully initialized.",
].join("\n");

test("development capture retains bounded stdout and stderr tails after stream closure", async () => {
  await assert.rejects(
    runCapturedProcess(process.execPath, [
      "-e",
      "process.stdout.write('o'.repeat(100000) + 'END-OUT'); process.stderr.write('s'.repeat(100000) + 'END-ERR'); process.exitCode = 1",
    ]),
    (error) => {
      assert.ok(error instanceof CapturedProcessError);
      assert.ok(Buffer.byteLength(error.stdout) <= 16 * 1024);
      assert.ok(Buffer.byteLength(error.stderr) <= 16 * 1024);
      assert.ok(error.stdout.endsWith("END-OUT"));
      assert.ok(error.stderr.endsWith("END-ERR"));
      return true;
    },
  );
});

test("development capture resolves on success and rejects spawn failures and signals", async () => {
  await runCapturedProcess(process.execPath, ["-e", "console.log('ok')"]);
  await assert.rejects(runCapturedProcess("tama-kit-missing-command-xyz", []), (error) => {
    assert.equal(error?.code, "ENOENT");
    return true;
  });
  await assert.rejects(
    runCapturedProcess(process.execPath, [
      "-e",
      "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50)",
    ]),
    (error) => {
      assert.ok(error instanceof CapturedProcessError);
      assert.match(error.message, /SIGKILL/u);
      return true;
    },
  );
});

test("foundation diagnostic recognizes checksum mismatch with apply evidence on stdout or stderr", () => {
  for (const [stdout, stderr] of [
    [`${READONLY_INIT_OUTPUT}\n${CHECKSUM_APPLY_OUTPUT}`, ""],
    ["", `${READONLY_INIT_OUTPUT}\n${CHECKSUM_APPLY_OUTPUT}`],
  ]) {
    const diagnostic = devSetupDiagnostic("foundation", { stdout, stderr });
    assert.equal(diagnostic.operation, "test-foundation-setup");
    assert.equal(diagnostic.phase, "foundation");
    assert.equal(diagnostic.subphase, "tofu-apply");
    assert.equal(diagnostic.reason, "provider-checksum-mismatch");
    assert.deepEqual(diagnostic.provider, {
      source: "registry.opentofu.org/upmaru/tama",
      version: "0.7.0",
    });
    assert.match(diagnostic.remediation, /providers lock -platform=/u);
    assert.match(diagnostic.remediation, /init -lockfile=readonly/u);
    assertNoSecrets(JSON.stringify(diagnostic));
  }
});

test("foundation diagnostic recognizes a read-only lockfile update requirement from init evidence", () => {
  const diagnostic = devSetupDiagnostic("foundation", {
    stdout: READONLY_INIT_OUTPUT,
    stderr: "",
  });
  assert.equal(diagnostic.subphase, "tofu-init");
  assert.equal(diagnostic.reason, "lockfile-update-required");
  assert.deepEqual(diagnostic.provider, {
    source: "registry.opentofu.org/upmaru/tama",
    version: "0.7.0",
  });
  assert.match(diagnostic.remediation, /lockfile=readonly/u);
});

test("foundation diagnostic falls back to a generic reason without unproven facts", () => {
  const diagnostic = devSetupDiagnostic("foundation", {
    stdout: "mix error: arbitrary-private-output\nTraceback (most recent call last): boom",
    stderr: "more arbitrary-private-output",
  });
  assert.deepEqual(diagnostic, {
    operation: "test-foundation-setup",
    phase: "foundation",
    reason: "foundation-failed",
    remediation: diagnostic.remediation,
  });
  assertNoSecrets(JSON.stringify(diagnostic));
});

test("foundation diagnostic strips ANSI and control sequences before recognizing patterns", () => {
  const output =
    "\u001b[1;31mError: Invalid provider checksum\u001b[0m\r\n" +
    "\u001b[33mregistry.opentofu.org/upmaru/tama 9.9.9\u0007 does not match any checksums\u001b[0m";
  const diagnostic = devSetupDiagnostic("foundation", { stdout: output, stderr: "" });
  assert.equal(diagnostic.reason, "provider-checksum-mismatch");
  assert.deepEqual(diagnostic.provider, {
    source: "registry.opentofu.org/upmaru/tama",
    version: "9.9.9",
  });
  assert.equal(diagnostic.subphase, undefined);
});

test("foundation diagnostic truncates to bounded tails and still recognizes trailing evidence", () => {
  const filler = "junk line for truncation ".repeat(20_000);
  const withEvidence = devSetupDiagnostic("foundation", {
    stdout: `${filler}\n${CHECKSUM_APPLY_OUTPUT}`,
    stderr: "",
  });
  assert.equal(withEvidence.reason, "provider-checksum-mismatch");
  const withoutEvidence = devSetupDiagnostic("foundation", {
    stdout: filler,
    stderr: "",
  });
  assert.equal(withoutEvidence.reason, "foundation-failed");
});

test("foundation diagnostic omits provider facts that cannot be safely extracted", () => {
  const noVersion = devSetupDiagnostic("foundation", {
    stdout: "Error: invalid provider checksum for registry.opentofu.org/upmaru/tama",
    stderr: "",
  });
  assert.deepEqual(noVersion.provider, { source: "registry.opentofu.org/upmaru/tama" });
  const noSource = devSetupDiagnostic("foundation", {
    stdout: "Error: invalid provider checksum",
    stderr: "",
  });
  assert.equal(noSource.provider, undefined);
});

test("non-foundation development phases project fixed allowlisted diagnostics", () => {
  const noisy = { stdout: "POSTGRES_PASSWORD=container-secret-value", stderr: "secret" };
  assert.deepEqual(devSetupDiagnostic("database", noisy), {
    operation: "docker-compose-up",
    phase: "database",
    reason: "database-startup-failed",
    remediation: devSetupDiagnostic("database", noisy).remediation,
  });
  assert.equal(devSetupDiagnostic("mix-setup", noisy).reason, "mix-setup-failed");
  assert.equal(devSetupDiagnostic("tool-install", noisy).reason, "opentofu-install-failed");
  for (const phase of ["database", "mix-setup", "tool-install"]) {
    assertNoSecrets(JSON.stringify(devSetupDiagnostic(phase, noisy)));
  }
});

test("safe dev diagnostic projection rejects unknown or unsafe nested details", () => {
  const known = {
    operation: "test-foundation-setup",
    phase: "foundation",
    reason: "provider-checksum-mismatch",
    provider: { source: "registry.opentofu.org/upmaru/tama", version: "0.7.0" },
    remediation: "static remediation",
  };
  assert.deepEqual(safeDevSetupDiagnostic({ diagnostic: known }), {
    ...known,
    remediation: "static remediation",
  });
  assert.equal(safeDevSetupDiagnostic(undefined), undefined);
  assert.equal(safeDevSetupDiagnostic({ paths: ["/private/env"] }), undefined);
  assert.equal(
    safeDevSetupDiagnostic({ diagnostic: { ...known, reason: "arbitrary", raw: "x" } }),
    undefined,
  );
  const withExtras = safeDevSetupDiagnostic({
    diagnostic: { ...known, subphase: "tofu-apply", nested: { raw: "arbitrary-private-output" } },
  });
  assert.equal(withExtras?.subphase, "tofu-apply");
  assertNoSecrets(JSON.stringify(withExtras));
});

function fakeTamaProject(mode) {
  const root = temporaryDirectory("tama-kit-dev-diag-");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "lib", "tama"), { recursive: true });
  mkdirSync(join(root, "scripts", "setup"), { recursive: true });
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
  writeFileSync(
    join(root, "scripts", "setup", ".terraform.lock.hcl"),
    'provider "registry.opentofu.org/upmaru/tama" 0.7.0 {}\n',
  );
  writeFileSync(
    join(root, "scripts", "setup.sh"),
    "#!/bin/sh\nset -e\ntofu init -lockfile=readonly\ntofu apply -input=false\n",
  );
  chmodSync(join(root, "scripts", "setup.sh"), 0o755);
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
if (process.argv.includes("version")) console.log("2.29.1");
else process.exit(0);
`,
  );
  writeFileSync(
    join(bin, "mix"),
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const [command, ...rest] = process.argv.slice(2);
if (command === "setup") process.exit(0);
if (command === "run") process.exit(1);
if (command === "cmd") {
  const result = spawnSync("bash", rest, { stdio: "inherit", cwd: process.cwd() });
  process.exit(result.status ?? 1);
}
process.exit(1);
`,
  );
  const applyOutput =
    mode === "stderr"
      ? `process.stderr.write(${JSON.stringify(CHECKSUM_APPLY_OUTPUT)} + "\\n");`
      : mode === "generic"
        ? 'console.error("mix error: arbitrary-private-output");'
        : `console.log(${JSON.stringify(CHECKSUM_APPLY_OUTPUT)} + "\\n");` +
          'console.log("Apply complete. Resources: 0 added.");';
  const applyExit = mode === "ok" ? 0 : 1;
  const initOutput =
    mode === "generic"
      ? 'console.log("Terraform used the selected providers. Provider installation finished.");'
      : `console.log(${JSON.stringify(READONLY_INIT_OUTPUT)});`;
  writeFileSync(
    join(bin, "tofu"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
appendFileSync(join(process.cwd(), ".tofu-calls.log"), process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("OpenTofu v1.10.0"); process.exit(0); }
if (args.includes("init")) {
  if (!args.includes("-lockfile=readonly")) { console.error("TOFU_WRITABLE_INIT_RETRIED"); process.exit(2); }
  ${initOutput}
  process.exit(0);
}
if (args.includes("apply")) {
  ${applyOutput}
  process.exit(${applyExit});
}
process.exit(0);
`,
  );
  for (const name of ["docker", "mix", "tofu"]) chmodSync(join(bin, name), 0o755);
  return root;
}

/** @param {string} root */
async function prepareProject(root) {
  const code = await run(["dev", "setup", root, "--prepare-only", "--no-color"], {
    cwd: root,
    interactive: false,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
}

/** @param {string} root */
async function runDevSetupJson(root) {
  const output = [];
  const errors = [];
  const code = await run(["dev", "setup", root, "--json"], {
    cwd: root,
    interactive: false,
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
  });
  return { code, output, errors };
}

test("dev setup JSON foundation failure projects sanitized diagnostics and never mutates the lock", async () => {
  for (const mode of ["stdout", "stderr"]) {
    const root = fakeTamaProject(mode);
    await prepareProject(root);
    const lockBefore = readFileSync(join(root, "scripts", "setup", ".terraform.lock.hcl"), "utf8");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${join(root, "bin")}:${originalPath}`;
      const { code, output, errors } = await runDevSetupJson(root);
      assert.equal(code, 6, mode);
      assert.equal(output.length, 1, mode);
      assert.deepEqual(errors, [], mode);
      const payload = JSON.parse(output[0]);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.category, "startup");
      assert.equal(payload.error.exitCode, 6);
      assert.match(payload.error.message, /test foundation setup failed/u);
      assert.deepEqual(payload.error.diagnostic, {
        operation: "test-foundation-setup",
        phase: "foundation",
        subphase: "tofu-apply",
        reason: "provider-checksum-mismatch",
        provider: { source: "registry.opentofu.org/upmaru/tama", version: "0.7.0" },
        remediation: payload.error.diagnostic.remediation,
      });
      assert.match(payload.error.diagnostic.remediation, /providers lock/u);
      assertNoSecrets(output[0]);
      const calls = readFileSync(join(root, ".tofu-calls.log"), "utf8").trim().split("\n");
      const inits = calls.filter((line) => line.includes("init"));
      const applies = calls.filter((line) => line.includes("apply"));
      assert.equal(inits.length, 1, mode);
      assert.ok(inits[0].includes("-lockfile=readonly"), mode);
      assert.equal(applies.length, 1, mode);
      assert.ok(!calls.some((line) => line.includes("providers lock")), mode);
      assert.equal(
        readFileSync(join(root, "scripts", "setup", ".terraform.lock.hcl"), "utf8"),
        lockBefore,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  }
});

test("dev setup JSON generic foundation failure omits unproven subphase and provider facts", async () => {
  const root = fakeTamaProject("generic");
  await prepareProject(root);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${join(root, "bin")}:${originalPath}`;
    const { code, output, errors } = await runDevSetupJson(root);
    assert.equal(code, 6);
    assert.deepEqual(errors, []);
    const payload = JSON.parse(output[0]);
    assert.match(payload.error.message, /test foundation setup failed/u);
    assert.deepEqual(payload.error.diagnostic, {
      operation: "test-foundation-setup",
      phase: "foundation",
      reason: "foundation-failed",
      remediation: payload.error.diagnostic.remediation,
    });
    assertNoSecrets(output[0]);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("dev setup JSON completes with a single success document when the fake foundation succeeds", async () => {
  const root = fakeTamaProject("ok");
  await prepareProject(root);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${join(root, "bin")}:${originalPath}`;
    const { code, output, errors } = await runDevSetupJson(root);
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(output.length, 1);
    const payload = JSON.parse(output[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.databaseStarted, true);
    assert.equal(payload.mixSetup, true);
    assert.equal(payload.testFoundationSetup, true);
    assertNoSecrets(output[0]);
  } finally {
    process.env.PATH = originalPath;
  }
});
