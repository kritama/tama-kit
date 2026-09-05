import assert from "node:assert/strict";
import test from "node:test";
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
} = {}) {
  const events = [];
  let starts = 0;
  let verifications = 0;
  const runtime = createBootstrapRuntime({
    platform: transportFailure ? "linux" : "darwin",
    createBootstrapPlan(input) {
      const result = plan(input.mcpApp.targetMode, input.mcpApp.providerMode);
      events.push(`plan:${result.mcpApp.lifecycle}/${result.mcpApp.providerLifecycle}`);
      return result;
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
      if (starts === startFailure) throw new Error("startup fault");
      if (recoveryFailure && starts > 1 && value.mcpApp.lifecycle === "prepared") {
        throw new Error("recovery fault");
      }
      return "https://tama.app.localhost/";
    },
    resolveComposeHostGatewayAddress() {
      throw new Error("transport fault");
    },
    async verifyMcpApp({ plan: value }) {
      verifications++;
      if (verifications === verifyException) throw new Error("verification exception");
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
    "plan:enabled/prepared",
    "write",
    "secrets",
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

test("failed prepared verification cannot enable or rewrite the integration", async () => {
  const f = fixture({ verifyFailure: 1 });
  await assert.rejects(
    f.run(),
    /The integration remains prepared.*Failed probes: checkpoint: probe fault/u,
  );
  assert.deepEqual(f.events, ["start:prepared/prepared", "verify:prepared/prepared"]);
});

test("failed enabled startup restores both fragments and restarts Tama prepared", async () => {
  const f = fixture({ startFailure: 1 });
  await assert.rejects(
    f.run(plan("enabled", "enabled")),
    /restart the provider.*Startup failure: startup fault/u,
  );
  assert.deepEqual(f.events, [
    "start:enabled/enabled",
    "plan:prepared/prepared",
    "write",
    "secrets",
    "validate",
    "start:prepared/prepared",
  ]);
});

test("failed verification after enabling Tama restores prepared state", async () => {
  const f = fixture({ verifyFailure: 2 });
  await assert.rejects(
    f.run(),
    /provider remained prepared.*Failed probes: checkpoint: probe fault/u,
  );
  assert.deepEqual(f.events.slice(-5), [
    "plan:prepared/prepared",
    "write",
    "secrets",
    "validate",
    "start:prepared/prepared",
  ]);
});

test("failed enabled transport resolution restores prepared state", async () => {
  const f = fixture({ transportFailure: true });
  const value = plan("enabled", "enabled");
  value.mcpApp.providerOrigin = "http://host.docker.internal:4000";
  await assert.rejects(f.run(value), /Transport failure: transport fault/u);
  assert.equal(f.events.at(-1), "start:prepared/prepared");
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

test("a rejected enabled verification effect compensates before reporting failure", async () => {
  const f = fixture({ verifyException: 1 });
  await assert.rejects(
    f.run(plan("enabled", "enabled")),
    /Verification failure: verification exception/u,
  );
  assert.equal(f.events.at(-1), "start:prepared/prepared");
});

test("a failed recovery reports both the activation and recovery failures", async () => {
  const f = fixture({ startFailure: 1, recoveryFailure: true });
  await assert.rejects(f.run(plan("enabled", "enabled")), (error) => {
    assert.equal(error.category, "startup");
    assert.match(
      error.message,
      /startup fault.*Restoring prepared mode also failed: recovery fault/u,
    );
    return true;
  });
});
