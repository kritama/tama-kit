import assert from "node:assert/strict";
import test from "node:test";
import { startupError } from "../../cli/errors.mjs";
import { createBootstrapWorkflow } from "../../cli/workflows/bootstrap.mjs";
import { createDevWorkflow } from "../../cli/workflows/dev.mjs";
import { createBootstrapRuntime } from "../../cli/workflows/mcp-app-runtime.mjs";

const options = {
  dryRun: false,
  start: true,
  json: true,
  activate: true,
  mcpApp: true,
  acknowledgeLocalDomainRisk: false,
  installLocalCa: false,
  migrateLocalHttps: false,
  migrateProviderIdentity: false,
  noColor: true,
  help: false,
};
const progress = { update() {}, finish() {}, stop() {} };
const prepared = { identity: { name: "acme" }, allowedOrigins: [] };
function plan(tama = "prepared", provider = "prepared") {
  return {
    root: "/project",
    operations: [],
    localHttps: null,
    mcpAppVerification: null,
    mcpApp: {
      lifecycle: tama,
      providerLifecycle: provider,
      providerOrigin: "https://app.localhost",
      tamaOrigin: "https://tama.app.localhost",
    },
  };
}
function fixture({
  startFailure,
  verifyFailure,
  verifyException,
  recoveryFailure,
  transportFailure,
  startDiagnostic,
  recoveryDiagnostic,
} = {}) {
  const events = [];
  let starts = 0;
  let verifications = 0;
  const runtime = createBootstrapRuntime({
    platform: transportFailure ? "linux" : "darwin",
    planTamaModeChange() {
      events.push("mode:enabled");
      return {
        operation: {},
        plan: plan("enabled", "prepared"),
        restore() {
          events.push("mode:restore");
          return {};
        },
      };
    },
    async applyOperationsTransactionally(_operations, validate) {
      events.push("write");
      await validate();
    },
    validateWrittenSecretsIgnored() {
      events.push("secrets");
    },
    async validateCompose() {
      events.push("validate");
    },
    async startCompose(value) {
      starts++;
      events.push(`start:${value.mcpApp.lifecycle}/${value.mcpApp.providerLifecycle}`);
      if (starts === startFailure)
        throw startDiagnostic
          ? startupError("startup fault", { diagnostic: startDiagnostic, internal: "do-not-copy" })
          : startupError("startup fault");
      if (recoveryFailure && starts > 1 && value.mcpApp.lifecycle === "prepared") {
        throw recoveryDiagnostic
          ? startupError("recovery fault", {
              diagnostic: recoveryDiagnostic,
              internal: "do-not-copy",
            })
          : startupError("recovery fault");
      }
      return "https://tama.app.localhost/";
    },
    resolveComposeHostGatewayAddress() {
      throw startupError("transport fault");
    },
    async verifyMcpApp({ plan: value }) {
      verifications++;
      if (verifications === verifyException) throw startupError("verification exception");
      events.push(`verify:${value.lifecycle}/${value.providerLifecycle}`);
      return {
        verified: verifications !== verifyFailure,
        mode: value.lifecycle,
        providerReachable: true,
        tamaReachable: true,
        probes: [
          { name: "checkpoint", ok: verifications !== verifyFailure, reason: "probe fault" },
        ],
      };
    },
  });
  return {
    events,
    run(value = plan(), overrides = {}) {
      return runtime({
        options: { ...options, ...overrides },
        cwd: "/project",
        skillMode: "manual",
        mcpAppPrepared: prepared,
        plan: value,
        progress,
      });
    },
  };
}

test("activation verifies prepared services before enabling Tama and requesting provider restart", async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(f.events, [
    "start:prepared/prepared",
    "verify:prepared/prepared",
    "mode:enabled",
    "write",
    "validate",
    "start:enabled/prepared",
    "verify:enabled/prepared",
  ]);
  assert.equal(result.plan.mcpApp.lifecycle, "enabled");
  assert.equal(result.plan.mcpApp.providerLifecycle, "prepared");
  assert.equal(result.plan.mcpAppVerification.verified, true);
});

test("already-enabled reruns verify both services without rewriting lifecycle state", async () => {
  const f = fixture();
  await f.run(plan("enabled", "enabled"));
  assert.deepEqual(f.events, ["start:enabled/enabled", "verify:enabled/enabled"]);
});

test("starting prepared services without activation leaves both services prepared", async () => {
  const f = fixture();
  await f.run(plan(), { activate: false });
  assert.deepEqual(f.events, ["start:prepared/prepared", "verify:prepared/prepared"]);
});

test("disabled providers skip live MCP endpoint verification", async () => {
  const f = fixture({ verifyException: 1 });
  const result = await f.run(plan("prepared", "disabled"), { activate: false });
  assert.deepEqual(f.events, ["start:prepared/disabled"]);
  assert.equal(result.plan.mcpAppVerification, null);
});

test("failed prepared verification cannot enable or rewrite the integration", async () => {
  const f = fixture({ verifyFailure: 1 });
  await assert.rejects(
    f.run(),
    /Failed probes: checkpoint: probe fault.*Configuration was preserved/u,
  );
  assert.deepEqual(f.events, ["start:prepared/prepared", "verify:prepared/prepared"]);
});

test("failed startup of an already-enabled project never writes configuration", async () => {
  const f = fixture({ startFailure: 1 });
  await assert.rejects(f.run(plan("enabled", "enabled")), /startup fault/u);
  assert.deepEqual(f.events, ["start:enabled/enabled"]);
});

test("failed verification after this invocation enables Tama restores only its own mode change", async () => {
  const f = fixture({ verifyFailure: 2 });
  await assert.rejects(f.run(), /provider configuration was preserved/u);
  assert.deepEqual(f.events.slice(-4), [
    "mode:restore",
    "write",
    "validate",
    "start:prepared/prepared",
  ]);
});

test("failed transport resolution preserves previously enabled configuration", async () => {
  const f = fixture({ transportFailure: true });
  const value = plan("enabled", "enabled");
  value.mcpApp.providerOrigin = "http://host.docker.internal:4000";
  await assert.rejects(f.run(value), /transport fault.*Configuration was preserved/u);
  assert.deepEqual(f.events, ["start:enabled/enabled"]);
});

test("dry-run planning does not invoke write, prerequisite, or startup effects", async () => {
  const events = [];
  const unexpected = () => {
    throw new Error("unexpected side effect");
  };
  const run = createBootstrapWorkflow({
    createBootstrapPlan(input) {
      events.push(input.materializeSecrets);
      return plan();
    },
    validateComposePrerequisite: unexpected,
    applyOperationsTransactionally: unexpected,
    startBootstrapRuntime: unexpected,
  });
  await run({
    options: { ...options, dryRun: true, start: false, activate: false },
    cwd: "/project",
    skillMode: "manual",
    mcpAppPrepared: prepared,
    progress,
  });
  assert.deepEqual(events, [false]);
});

test("development prepare-only writes files without Docker, Mix, or foundation setup", async () => {
  const events = [];
  const unexpected = () => {
    throw new Error("unexpected runtime operation");
  };
  const run = createDevWorkflow({
    createDevSetupPlan() {
      return { operations: [] };
    },
    async applyOperationsTransactionally(_operations, validate) {
      events.push("write");
      await validate();
    },
    validateComposePrerequisite: unexpected,
    startDevDatabase: unexpected,
    runMixSetup: unexpected,
    runTestFoundationSetup: unexpected,
  });
  await run({
    options: { prepareOnly: true, dryRun: false, json: true },
    cwd: "/project",
    progress,
  });
  assert.deepEqual(events, ["write"]);
});

test("failed verification of an already-enabled project never compensates with generation", async () => {
  const f = fixture({ verifyException: 1 });
  await assert.rejects(
    f.run(plan("enabled", "enabled")),
    /verification exception.*Configuration was preserved/u,
  );
  assert.deepEqual(f.events, ["start:enabled/enabled"]);
});

test("failed recovery retains both sanitized failures", async () => {
  const f = fixture({ startFailure: 2, recoveryFailure: true });
  await assert.rejects(
    f.run(),
    /startup fault.*Restoring the selected Tama mode also failed: recovery fault/u,
  );
});

test("activation recovery preserves the original sanitized startup diagnostic", async () => {
  const diagnostic = { operation: "compose-up", reason: "port-conflict", port: 443 };
  const recoveryDiagnostic = { operation: "compose-up", reason: "image-unavailable" };
  for (const recoveryFailure of [false, true]) {
    const f = fixture({
      startFailure: 2,
      startDiagnostic: diagnostic,
      recoveryFailure,
      recoveryDiagnostic,
    });
    await assert.rejects(f.run(), (error) => {
      assert.equal(error.category, "startup");
      assert.deepEqual(error.details, { diagnostic });
      assert.doesNotMatch(JSON.stringify(error.details), /do-not-copy/);
      return true;
    });
    assert.equal(f.events.at(-1), "start:prepared/prepared");
  }
});
