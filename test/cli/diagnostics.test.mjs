import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { composeStartupDiagnostic } from "../../cli/bootstrap/diagnostics.mjs";
import { run } from "../../cli/index.mjs";
import { CapturedProcessError, runCapturedProcess } from "../../cli/shared/captured-process.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

test("startup diagnostics retain port conflicts without copying arbitrary secret-bearing stderr", () => {
  const stderr =
    'SECRET=never-print-this\n/setup/root?token=private\nBind for 0.0.0.0:443 failed: port is already allocated\n{"d":"private-jwk"}';
  assert.deepEqual(composeStartupDiagnostic(stderr), {
    operation: "compose-up",
    reason: "port-conflict",
    port: 443,
  });
  assert.deepEqual(
    composeStartupDiagnostic("listen tcp4 127.0.0.1:4567: bind: address already in use"),
    { operation: "compose-up", reason: "port-conflict", port: 4567 },
  );
  assert.equal(composeStartupDiagnostic("service SECRET is unhealthy").reason, "unhealthy-service");
  assert.deepEqual(composeStartupDiagnostic("arbitrary private output"), {
    operation: "compose-up",
    reason: "compose-failed",
  });
});

test("process diagnostics bound stderr and wait for stream closure", async () => {
  await assert.rejects(
    runCapturedProcess(process.execPath, [
      "-e",
      "process.stderr.write('x'.repeat(100000) + 'END'); process.exitCode = 1",
    ]),
    (error) => {
      assert.ok(error instanceof CapturedProcessError);
      assert.ok(Buffer.byteLength(error.stderr) <= 16 * 1024);
      assert.ok(error.stderr.endsWith("END"));
      return true;
    },
  );
  await runCapturedProcess(process.execPath, ["-e", "process.stderr.write('ignored on success')"]);
});

test("bootstrap JSON startup errors expose a single sanitized diagnostic envelope", async () => {
  const root = temporaryDirectory("tama-kit-diagnostic-cli-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}
if (process.argv.includes('version')) console.log('2.20.0');
else if (process.argv.includes('up')) {
  process.stderr.write('TOKEN=do-not-emit\\nBind for 127.0.0.1:4000 failed: port is already allocated\\n');
  process.exitCode = 1;
}
`,
  );
  chmodSync(docker, 0o755);
  const originalPath = process.env.PATH;
  const output = [];
  const errors = [];
  try {
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const code = await run(["bootstrap", "--start", "--json"], {
      cwd: root,
      interactive: false,
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
    });
    assert.equal(code, 6);
    assert.equal(output.length, 1);
    assert.deepEqual(errors, []);
    const result = JSON.parse(output[0]);
    assert.equal(result.error.category, "startup");
    assert.deepEqual(result.error.diagnostic, {
      operation: "compose-up",
      reason: "port-conflict",
      port: 4000,
    });
    assert.doesNotMatch(output[0], /TOKEN|do-not-emit/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
