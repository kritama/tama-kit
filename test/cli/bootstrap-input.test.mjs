import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBootstrapPlan, publicPlan } from "../../cli/bootstrap/plan.mjs";
import { resolveBootstrapInput } from "../../cli/commands/bootstrap-input.mjs";
import { parseBootstrap } from "../../cli/commands/bootstrap-options.mjs";
import { CancelledInput } from "../../cli/commands/questions.mjs";
import { prerequisiteError } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";
import { applyOperations } from "../../cli/shared/write.mjs";
import { createBootstrapWorkflow } from "../../cli/workflows/bootstrap.mjs";
import { memoveeContract, planWithMcp, preparedFor, writeContract } from "../helpers/mcp-app.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

function ioFor(root, answers) {
  const output = [];
  const prompts = [];
  return {
    cwd: root,
    interactive: true,
    color: false,
    output,
    prompts,
    stdout: (value) => output.push(value),
    stderr: (value) => output.push(value),
    write: () => {},
    prompt: async (question) => {
      prompts.push(question);
      assert.ok(
        answers.length,
        `Unexpected prompt: ${question}\nTranscript:\n${output.join("\n")}`,
      );
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("bare guided setup resolves the project and produces the same read-only plan as flags", async () => {
  const root = temporaryDirectory("tama-guided-");
  const io = ioFor(root, ["", "no", "1", "no", "no", "4567", "1"]);
  const result = await resolveBootstrapInput(parseBootstrap(["--dry-run"]), io);
  const equivalent = createBootstrapPlan({
    cwd: root,
    targetPath: root,
    port: 4567,
    skillMode: "manual",
    image: result.options.image,
    materializeSecrets: false,
  });
  assert.deepEqual(publicPlan(result.reviewedPlan), publicPlan(equivalent));
  assert.deepEqual(readdirSync(root), []);
  assert.equal(result.options.port, 4567);
});

test("Compose ambiguity is resolved in the questionnaire and cancellation writes nothing", async () => {
  const root = temporaryDirectory("tama-guided-compose-");
  writeFileSync(join(root, "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  const io = ioFor(root, ["2", "no", "1", "no", "no", "", ":cancel"]);
  await assert.rejects(resolveBootstrapInput(parseBootstrap([root]), io), CancelledInput);
  assert.ok(io.output.some((line) => line.includes("Compose: docker-compose.yml")));
  assert.equal(existsSync(join(root, "tama")), false);
});

test("invalid answers retry locally and :back revisits the preceding configuration step", async () => {
  const root = temporaryDirectory("tama-guided-back-");
  const io = ioFor(root, [
    "no",
    "invalid",
    "1",
    "no",
    ":back",
    "1",
    "no",
    "no",
    "bad",
    "4500",
    "1",
  ]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.options.port, 4500);
  assert.ok(io.output.some((line) => line.includes("between 1 and 65535")));
  assert.deepEqual(readdirSync(root), []);
});

test("fresh MCP App questions derive HTTPS identities without requiring flags", async () => {
  const root = temporaryDirectory("tama-guided-mcp-");
  const io = ioFor(root, [
    "no",
    "2",
    "no",
    "no",
    "acme",
    "",
    "1",
    "4005",
    "http://localhost:3000, https://app.localhost",
    "1",
  ]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.reviewedPlan.localHttps.providerOrigin, "https://app.localhost");
  assert.equal(result.reviewedPlan.localHttps.providerPort, 4005);
  assert.deepEqual(result.prepared.allowedOrigins, [
    "http://localhost:3000",
    "https://app.localhost",
  ]);
  assert.deepEqual(readdirSync(root), []);
});

test("JSON and explicit non-interactive modes never request user input", async () => {
  for (const flag of ["--json", "--non-interactive"]) {
    const root = temporaryDirectory("tama-guided-automation-");
    const io = ioFor(root, []);
    assert.equal(await run(["bootstrap", root, "--dry-run", flag], io), 0);
    assert.equal(io.prompts.length, 0);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("recorded Compose and image choices survive relocation and resume", async () => {
  const root = temporaryDirectory("tama-guided-resume-");
  writeFileSync(join(root, "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  applyOperations(
    createBootstrapPlan({
      cwd: root,
      composePath: "docker-compose.yml",
      image: "example/tama:pinned",
      skillMode: "manual",
    }).operations,
  );
  const io = ioFor(root, ["1", "1"]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.options.image, "example/tama:pinned");
  assert.equal(result.options.composePath, "docker-compose.yml");
  assert.ok(result.reviewedPlan.operations.every((operation) => operation.action === "unchanged"));
  assert.ok(io.prompts.every((question) => !question.includes("skills")));
});

test("a changed plan after approval is refused before secrets, writes, or startup", async () => {
  const root = temporaryDirectory("tama-guided-stale-");
  const io = ioFor(root, ["no", "1", "no", "no", "", "1"]);
  const result = await resolveBootstrapInput(parseBootstrap([root]), io);
  writeFileSync(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n");
  let effects = 0;
  const workflow = createBootstrapWorkflow({
    applyOperationsTransactionally: async () => {
      effects++;
    },
    validateComposePrerequisite: () => {
      effects++;
    },
  });
  await assert.rejects(
    workflow({
      options: result.options,
      cwd: root,
      skillMode: "manual",
      mcpAppPrepared: null,
      reviewedPlan: result.reviewedPlan,
      progress: { update() {}, finish() {}, stop() {} },
    }),
    /changed after review/,
  );
  assert.equal(effects, 0);
  assert.equal(existsSync(join(root, "tama")), false);
});

test("Ctrl-C/EOF cancellation is a clean command exit", async () => {
  const root = temporaryDirectory("tama-guided-cancel-");
  const io = ioFor(root, [new CancelledInput()]);
  assert.equal(await run(["init", root], io), 0);
  assert.match(io.output.join("\n"), /Setup paused/);
  assert.deepEqual(readdirSync(root), []);
});

test("configured status does not claim provisioning or live health", async () => {
  const root = temporaryDirectory("tama-guided-status-");
  applyOperations(createBootstrapPlan({ cwd: root, skillMode: "manual" }).operations);
  const before = readFileSync(join(root, "tama/.tama-kit.json"), "utf8");
  const io = ioFor(root, ["3"]);
  assert.equal(await run(["bootstrap", root], io), 0);
  assert.match(io.output.join("\n"), /Runtime health and Terraform provisioning were not checked/);
  assert.equal(readFileSync(join(root, "tama/.tama-kit.json"), "utf8"), before);
});

test("enabled resume preserves custom provider identity, modes, and signing material", async () => {
  const root = temporaryDirectory("tama-guided-enabled-");
  const prepared = preparedFor(root, {
    identity: {
      name: "acme",
      environmentPrefix: "CUSTOM",
      environmentFile: "tama/.custom.env",
      source: "flags",
    },
  });
  applyOperations(planWithMcp(root, prepared, { localDomain: "app.localhost" }).operations);
  for (const [file, variable] of [
    ["tama/.tama.env", "TAMA_MCP_APP_MODE"],
    ["tama/.custom.env", "CUSTOM_TAMA_MCP_APP_MODE"],
  ]) {
    const path = join(root, file);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes(`${variable}=prepared`));
    writeFileSync(path, content.replace(`${variable}=prepared`, `${variable}=enabled`));
  }
  const files = ["tama/.tama.env", "tama/.custom.env"];
  const before = files.map((file) => readFileSync(join(root, file), "utf8"));
  const io = ioFor(root, ["1", "1"]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.reviewedPlan.mcpApp.lifecycle, "enabled");
  assert.equal(result.reviewedPlan.mcpApp.providerLifecycle, "enabled");
  assert.equal(result.options.providerPrefix, "CUSTOM");
  assert.equal(result.options.providerEnvironmentFile, "tama/.custom.env");
  assert.deepEqual(
    files.map((file) => readFileSync(join(root, file), "utf8")),
    before,
  );
  assert.ok(
    result.reviewedPlan.operations.every(
      (op) => !files.includes(op.path.slice(root.length + 1)) || op.action === "unchanged",
    ),
  );
});

test("explicit flags skip their questions and remain authoritative", async () => {
  const root = temporaryDirectory("tama-guided-flags-");
  writeFileSync(join(root, "compose.yaml"), "services: {}\n");
  const io = ioFor(root, ["no", "1"]);
  const options = parseBootstrap([
    root,
    "--dry-run",
    "--mcp-app",
    "--compose",
    "compose.yaml",
    "--skills",
    "manual",
    "--provider-name",
    "acme",
    "--provider-prefix",
    "CUSTOM",
    "--provider-env-file",
    "tama/.custom.env",
    "--local-domain",
    "test.localhost",
    "--provider-runtime",
    "host",
    "--provider-port",
    "4567",
    "--allowed-origin",
    "https://client.example",
    "--image",
    "ghcr.io/upmaru/tama:0.13.2-server",
  ]);
  const result = await resolveBootstrapInput(options, io);
  for (const [key, value] of Object.entries(options)) assert.deepEqual(result.options[key], value);
  assert.equal(io.prompts.length, 2);
  assert.equal(result.reviewedPlan.localHttps.providerUpstream, "http://host.docker.internal:4567");
});

test("advanced identity defaults follow the accepted provider name", async () => {
  const root = temporaryDirectory("tama-guided-name-");
  const io = ioFor(root, [
    "no",
    "2",
    "yes",
    "no",
    "",
    "acme",
    "",
    "",
    "",
    "1",
    "",
    "",
    "",
    "",
    "",
    "1",
  ]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.options.providerPrefix, "ACME");
  assert.equal(result.options.providerEnvironmentFile, "tama/.acme.integration.env");
});

test("a contract-incompatible default image prompts for an offline-compatible pin", async () => {
  const root = temporaryDirectory("tama-guided-image-");
  writeContract(
    root,
    memoveeContract({
      supported_tama_versions: ">= 0.13.3 and < 0.14.0",
      local_development: {
        memovee_origin: "https://app.localhost",
        tama_origin: "https://tama.app.localhost",
        resource: "https://tama.app.localhost/mcp/app",
      },
    }),
  );
  const io = ioFor(root, [
    "no",
    "2",
    "no",
    "no",
    "",
    "1",
    "",
    "",
    "ghcr.io/upmaru/tama:0.13.3-server",
    "1",
  ]);
  const result = await resolveBootstrapInput(parseBootstrap([root, "--dry-run"]), io);
  assert.equal(result.options.image, "ghcr.io/upmaru/tama:0.13.3-server");
  assert.ok(io.prompts.some((prompt) => prompt.startsWith("Tama image")));
  assert.equal(existsSync(join(root, "tama")), false);
});

test("review is revalidated after CA consent and before certificate generation", async () => {
  const root = temporaryDirectory("tama-guided-ca-stale-");
  const io = ioFor(root, ["no", "2", "no", "no", "acme", "", "1", "", "", "1"]);
  const result = await resolveBootstrapInput(parseBootstrap([root]), io);
  let effects = 0;
  const workflow = createBootstrapWorkflow({
    validateComposePrerequisite() {},
    resolveLocalHttpsNames: async () => {},
    discoverMkcert() {
      throw prerequisiteError("missing local CA", { prerequisite: "mkcert-local-ca" });
    },
    planLocalHttpsCertificates() {
      effects++;
      throw new Error("must not generate certificates");
    },
    applyOperationsTransactionally: async () => {
      effects++;
    },
  });
  await assert.rejects(
    workflow({
      options: result.options,
      cwd: root,
      skillMode: "manual",
      mcpAppPrepared: result.prepared,
      reviewedPlan: result.reviewedPlan,
      progress: { update() {}, finish() {}, stop() {} },
      authorizeLocalCa: async () => {
        writeFileSync(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n");
        return true;
      },
    }),
    /changed after review/,
  );
  assert.equal(effects, 0);
  assert.equal(existsSync(join(root, "tama")), false);
});
