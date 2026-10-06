import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  devSetupDiagnostic,
  lockedProvider,
  safeDevSetupDiagnostic,
} from "../../cli/dev/diagnostics.mjs";
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
  "probe-secret",
];

function assertNoSecrets(serialized) {
  for (const marker of SECRET_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(marker, "u"));
  }
}

const LOCK_PROVIDER = { source: "registry.opentofu.org/upmaru/tama", version: "0.7.0" };

// Authentic representative OpenTofu 1.10 read-only init output: a nonfatal
// lock warning followed by a successful read-only init.
const READONLY_INIT_OUTPUT = [
  "OpenTofu CLI: 1.10.3",
  "Initializing provider plugins...",
  "- Finding upmaru/tama versions matching 0.7.0...",
  "- Reusing previous selection of upmaru/tama 0.7.0 from the dependency lock file",
  "Warning: Provider lock file not updated",
  "Changes to the provider selections were detected, but not saved in the .terraform.lock.hcl file.",
  'To record these selections, run "tofu init" without the "-lockfile=readonly" flag.',
  "OpenTofu has been successfully initialized!",
].join("\n");

// Authentic representative OpenTofu 1.10 read-only init failure.
const READONLY_INIT_ERROR_OUTPUT = [
  "Initializing provider plugins...",
  "- Finding upmaru/tama versions matching 0.8.0...",
  "Error: Provider dependency changes detected",
  "Changes to the required provider dependencies were detected, but the lock file is read-only.",
  'To use and record these requirements, run "tofu init" without the "-lockfile=readonly" flag.',
].join("\n");

// Apply output rejecting the installed provider checksum; includes the
// secret-shaped provider probe that must never reach public diagnostics.
const CHECKSUM_APPLY_OUTPUT = [
  "OpenTofu has planned 3 actions!",
  'Applying "tama_app.main" ...',
  "TAMA_VAULT_KEY=super-secret-vault-value",
  "DATABASE_URL=postgres://tama:hunter2secret@db.internal:5432/tama",
  "http://127.0.0.1:4000/setup/root?token=setup-token-value",
  "Authorization: Bearer bearer-token-value",
  '{"alg":"RS256","kid":"staging-2026-09-01-1","d":"jwk-private-base64-value"}',
  "-----BEGIN RSA PRIVATE KEY-----",
  "privatepemline",
  "-----END RSA PRIVATE KEY-----",
  "TAMA_CLIENT_SECRET=registry.opentofu.org/private/probe-secret 1.2.3-private-secret",
  "Error: Inconsistent dependency lock file",
  ".terraform.lock.hcl contains an invalid checksum for the upmaru/tama 0.7.0 provider:",
  "  h1:SECRET-CHECKSUM-VALUE=",
  "POSTGRES_PASSWORD=container-secret-value",
  "Error: checksum verification failed: does not match any of the checksums in the lock file",
].join("\n");

// An unrelated apply failure that follows the nonfatal init lock warning.
const UNRELATED_APPLY_FAILURE_OUTPUT = [
  "OpenTofu has planned 3 actions!",
  'Applying "tama_app.main" ...',
  "Error: dial tcp 127.0.0.1:55432: connect: connection refused",
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
    const withLock = devSetupDiagnostic(
      "foundation",
      { stdout, stderr },
      {
        provider: LOCK_PROVIDER,
      },
    );
    assert.equal(withLock.operation, "test-foundation-setup");
    assert.equal(withLock.phase, "foundation");
    assert.equal(withLock.subphase, "tofu-apply");
    assert.equal(withLock.reason, "provider-checksum-mismatch");
    assert.deepEqual(withLock.provider, LOCK_PROVIDER);
    assert.match(withLock.remediation, /providers lock -platform=/u);
    assert.match(withLock.remediation, /init -lockfile=readonly/u);
    assertNoSecrets(JSON.stringify(withLock));
    // Captured output is never mined for provider metadata.
    const withoutLock = devSetupDiagnostic("foundation", { stdout, stderr });
    assert.equal(withoutLock.provider, undefined);
    assertNoSecrets(JSON.stringify(withoutLock));
  }
});

test("foundation diagnostic recognizes authentic read-only lockfile failures", () => {
  for (const output of [READONLY_INIT_OUTPUT, READONLY_INIT_ERROR_OUTPUT]) {
    const diagnostic = devSetupDiagnostic(
      "foundation",
      { stdout: output, stderr: "" },
      {
        provider: LOCK_PROVIDER,
      },
    );
    assert.equal(diagnostic.subphase, "tofu-init");
    assert.equal(diagnostic.reason, "lockfile-update-required");
    assert.deepEqual(diagnostic.provider, LOCK_PROVIDER);
    assert.match(diagnostic.remediation, /lockfile=readonly/u);
    assert.doesNotMatch(diagnostic.remediation, /without the .?-lockfile=readonly.? flag/u);
  }
});

test("foundation diagnostic does not blame a nonfatal lock warning for a later unrelated apply failure", () => {
  const diagnostic = devSetupDiagnostic("foundation", {
    stdout: `${READONLY_INIT_OUTPUT}\n${UNRELATED_APPLY_FAILURE_OUTPUT}`,
    stderr: "",
  });
  assert.equal(diagnostic.reason, "foundation-failed");
  assert.equal(diagnostic.subphase, undefined);
  assert.equal(diagnostic.provider, undefined);
  assertNoSecrets(JSON.stringify(diagnostic));
});

test("secret-shaped provider syntax in captured output never reaches the diagnostic", () => {
  const secretOutput =
    "TAMA_CLIENT_SECRET=registry.opentofu.org/private/probe-secret 1.2.3-private-secret\n" +
    "Error: checksum verification failed";
  const withoutLock = devSetupDiagnostic("foundation", { stdout: secretOutput, stderr: "" });
  assert.equal(withoutLock.reason, "provider-checksum-mismatch");
  assert.equal(withoutLock.provider, undefined);
  const withLock = devSetupDiagnostic(
    "foundation",
    { stdout: secretOutput, stderr: "" },
    {
      provider: LOCK_PROVIDER,
    },
  );
  assert.deepEqual(withLock.provider, LOCK_PROVIDER);
  for (const diagnostic of [withoutLock, withLock]) {
    assert.doesNotMatch(JSON.stringify(diagnostic), /probe-secret/);
    assertNoSecrets(JSON.stringify(diagnostic));
  }
});

test("lockedProvider parses only the single strict record from the repository lock file", () => {
  const root = temporaryDirectory("tama-kit-locked-provider-");
  const lockDir = join(root, "scripts", "setup");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, ".terraform.lock.hcl"),
    'provider "registry.opentofu.org/upmaru/tama" 0.7.0 {\n  "h1:abc="\n}\n',
  );
  assert.deepEqual(lockedProvider(root), LOCK_PROVIDER);
  writeFileSync(
    join(lockDir, ".terraform.lock.hcl"),
    [
      'provider "registry.opentofu.org/upmaru/tama" 0.7.0 {',
      '  "h1:abc="',
      "}",
      'provider "registry.opentofu.org/private/probe-secret" 1.2.3-private-secret {',
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(lockedProvider(root), undefined);
  writeFileSync(
    join(lockDir, ".terraform.lock.hcl"),
    "TAMA_CLIENT_SECRET=registry.opentofu.org/private/probe-secret 1.2.3-private-secret\n",
  );
  assert.equal(lockedProvider(root), undefined);
  assert.equal(lockedProvider(temporaryDirectory("tama-kit-no-lock-")), undefined);
});

test("foundation diagnostic strips ANSI and control sequences before recognizing patterns", () => {
  const output =
    "\u001b[1;31mError: Invalid provider checksum\u001b[0m\r\n" +
    "\u001b[33mthe installed provider does not match any checksums\u0007\u001b[0m";
  const diagnostic = devSetupDiagnostic(
    "foundation",
    { stdout: output, stderr: "" },
    {
      provider: LOCK_PROVIDER,
    },
  );
  assert.equal(diagnostic.reason, "provider-checksum-mismatch");
  assert.deepEqual(diagnostic.provider, LOCK_PROVIDER);
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

function lockRoot() {
  const root = temporaryDirectory("tama-kit-safe-diagnostic-");
  const lockDir = join(root, "scripts", "setup");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, ".terraform.lock.hcl"),
    'provider "registry.opentofu.org/upmaru/tama" 0.7.0 {\n  "h1:abc="\n}\n',
  );
  return root;
}

test("safe dev diagnostic projection derives statics and enforces the trusted provider policy", () => {
  const adversarial = {
    diagnostic: {
      operation: "arbitrary-operation-with-arbitrary-private-output",
      phase: "foundation",
      reason: "provider-checksum-mismatch",
      subphase: "tofu-apply",
      provider: {
        source: "registry.opentofu.org/private/probe-secret",
        version: "1.2.3-private-secret",
      },
      remediation: "arbitrary remediation with super-secret-vault-value",
      nested: { raw: "arbitrary-private-output" },
    },
    root: lockRoot(),
  };
  const projected = safeDevSetupDiagnostic(adversarial);
  assert.equal(projected?.operation, "test-foundation-setup");
  assert.equal(projected?.phase, "foundation");
  assert.equal(projected?.reason, "provider-checksum-mismatch");
  assert.match(projected?.remediation ?? "", /providers lock/u);
  assertNoSecrets(JSON.stringify(projected));
  assert.equal(projected?.provider, undefined);

  const trusted = safeDevSetupDiagnostic({
    diagnostic: {
      operation: "ignored",
      phase: "foundation",
      reason: "provider-checksum-mismatch",
      subphase: "tofu-apply",
      provider: LOCK_PROVIDER,
      remediation: "ignored",
    },
    root: lockRoot(),
  });
  assert.deepEqual(trusted?.provider, LOCK_PROVIDER);
  assert.equal(trusted?.operation, "test-foundation-setup");
  assertNoSecrets(JSON.stringify(trusted));
});

test("safe dev diagnostic projection rejects unknown or unsafe nested details", () => {
  const known = {
    phase: "foundation",
    reason: "provider-checksum-mismatch",
    remediation: "ignored",
  };
  assert.equal(safeDevSetupDiagnostic(undefined), undefined);
  assert.equal(safeDevSetupDiagnostic({ paths: ["/private/env"] }), undefined);
  assert.equal(
    safeDevSetupDiagnostic({ diagnostic: { ...known, reason: "arbitrary", raw: "x" } }),
    undefined,
  );
  assert.equal(safeDevSetupDiagnostic({ diagnostic: { ...known, phase: "arbitrary" } }), undefined);
  const withExtras = safeDevSetupDiagnostic({
    diagnostic: { ...known, subphase: "tofu-apply", nested: { raw: "arbitrary-private-output" } },
  });
  assert.equal(withExtras?.operation, "test-foundation-setup");
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
    'provider "registry.opentofu.org/upmaru/tama" 0.7.0 {\n  "h1:verified="\n}\n',
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
  const checksumOutput =
    mode === "stderr"
      ? `process.stderr.write(${JSON.stringify(CHECKSUM_APPLY_OUTPUT)} + "\\n");`
      : `console.log(${JSON.stringify(CHECKSUM_APPLY_OUTPUT)} + "\\n");`;
  const applyOutput =
    mode === "generic"
      ? 'console.error("mix error: arbitrary-private-output");'
      : mode === "unrelated"
        ? "console.log(\"OpenTofu has planned 3 actions!\");\nconsole.error('Error: dial tcp 127.0.0.1:55432: connect: connection refused');"
        : mode === "ok"
          ? 'console.log("OpenTofu has planned 3 actions!");\nconsole.log("Apply complete! Resources: 3 added, 0 changed, 0 destroyed.");'
          : checksumOutput;
  const applyExit = mode === "ok" ? 0 : 1;
  const initOutput =
    mode === "generic"
      ? 'console.log("Initializing provider plugins...");\nconsole.log("OpenTofu has been successfully initialized!");'
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

test("dev setup JSON generic and unrelated apply failures omit unproven subphase and provider facts", async () => {
  for (const mode of ["generic", "unrelated"]) {
    const root = fakeTamaProject(mode);
    await prepareProject(root);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${join(root, "bin")}:${originalPath}`;
      const { code, output, errors } = await runDevSetupJson(root);
      assert.equal(code, 6, mode);
      assert.deepEqual(errors, [], mode);
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
