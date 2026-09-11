import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Document } from "yaml";
import { inspectCurrentConfiguration } from "../bootstrap/current-config.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import {
  renderLocalCaDockerfile,
  renderLocalHttpsCaddyfile,
  resolveLocalHttpsTopology,
  usesLocalHttpsTopology,
} from "../bootstrap/local-https.mjs";
import { planMcpApp, resolveMcpAppState } from "../bootstrap/mcp-app.mjs";
import { serializeMcpAppLocalContract } from "../bootstrap/mcp-app-local-contract.mjs";
import { createOwnedFilePlanner } from "../bootstrap/owned-files.mjs";
import { resolveProviderTopology } from "../bootstrap/provider-topology.mjs";
import { normalizeGenerationPath } from "../domain/generation.mjs";
import type { InspectOptions, RuntimePlan } from "../domain/runtime.mjs";
import { ownershipError, prerequisiteError, usageError } from "../errors.mjs";
import { composeArguments } from "../shared/compose.mjs";
import { parseEnvironment } from "../shared/environment.mjs";
import { contentDigest, inspectRegularFile, operationForContent } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import { validateOAuthPrivateJwk } from "../shared/oauth-key.mjs";
import type { BootstrapCommandOptions, FileOperation, McpAppPrepared } from "../types.mjs";
import {
  ADDITION_TLS,
  additionCertificates,
  validateAdditionCertificateBundle,
} from "./mcp-app-certificates.mjs";
import { mcpAppOptions } from "./options.mjs";
import { writeScaffold } from "./scaffold-write.mjs";

export function validateComposeBuildOverrideVersion(execute = execFileSync) {
  const version = execute("docker", ["compose", "version", "--short"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .match(/v?(\d+)\.(\d+)\.(\d+)/u)
    ?.slice(1)
    .map(Number);
  if (
    !version ||
    version[0] < 2 ||
    (version[0] === 2 && (version[1] < 24 || (version[1] === 24 && version[2] < 4)))
  )
    throw prerequisiteError(
      "additive MCP App generation requires Docker Compose 2.24.4 or newer for build and port overrides",
    );
}

export const MCP_ADDITION = {
  receipt: "tama/.tama-kit-mcp-app.json",
  compose: "tama/compose.mcp-app.yaml",
  environment: "tama/.mcp-app.env",
  contract: "tama/contracts/mcp-app-provider-v1.json",
  readme: "tama/MCP_APP.md",
};
export type AdditionOptions = BootstrapCommandOptions & { selection: InspectOptions };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function additionStatus(root: string, resumeId?: string) {
  const evidence = readGenerationEvidence(join(root, MCP_ADDITION.receipt));
  if (evidence.kind === "legacy") throw ownershipError("invalid MCP App generation receipt");
  if (evidence.kind === "receipt") {
    if (evidence.receipt.operation.kind !== "mcp-app")
      throw ownershipError("the selected receipt is not an MCP App generation operation");
    if (evidence.receipt.progress.status === "complete") {
      if (resumeId)
        throw usageError("MCP App generation is already complete; there is nothing to resume");
      return { status: "existing" as const };
    }
    if (resumeId !== evidence.receipt.operation.id)
      throw ownershipError(
        `MCP App generation is incomplete; rerun generate mcp-app with --resume ${evidence.receipt.operation.id} and the original options`,
      );
    return {
      status: "resume" as const,
      id: resumeId,
      pending: evidence.receipt.progress.pendingDestinations,
    };
  }
  if (resumeId)
    throw ownershipError("resume requires the original unfinished MCP App generation receipt");
  return { status: "new" as const, id: randomUUID() };
}

/** Build only capability additions, never route an established project through bootstrap. */
export function planMcpAppAddition(
  current: RuntimePlan,
  options: AdditionOptions,
  prepared: McpAppPrepared,
  progress: { id: string; pending?: string[] },
  materializeKeys: boolean,
) {
  const root = current.root;
  const selected = current.runtime.service;
  if (current.mcpApp)
    throw usageError("MCP App is already configured; edit current files and use setup");
  let services: Record<
    string,
    {
      build?: unknown;
      environment?: Record<string, unknown>;
      networks?: Record<string, unknown>;
      network_mode?: string;
      profiles?: string[];
      depends_on?: Record<string, unknown> | string[];
      ports?: { published?: string | number }[];
    }
  >;
  try {
    services = JSON.parse(
      execFileSync(
        "docker",
        [...composeArguments(current), "config", "--format", "json", "--no-interpolate"],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    ).services;
  } catch {
    throw prerequisiteError("cannot inspect Compose declarations for MCP App generation");
  }
  const service = services[selected];
  const requested = mcpAppOptions(options);
  const rawTamaPort = current.runtime.environment.get("PORT") ?? "4000";
  if (!/^\d+$/u.test(rawTamaPort))
    throw ownershipError("the effective Tama PORT must be an integer between 1 and 65535", {
      variable: "PORT",
      actual: rawTamaPort,
    });
  const tamaPort = Number.parseInt(rawTamaPort, 10);
  if (!Number.isInteger(tamaPort) || tamaPort < 1 || tamaPort > 65_535)
    throw ownershipError("the effective Tama PORT must be between 1 and 65535", {
      variable: "PORT",
      actual: rawTamaPort,
    });
  const topology = usesLocalHttpsTopology(requested, prepared.contractDocument)
    ? {
        ...resolveLocalHttpsTopology({
          ...resolveProviderTopology(requested, current.runtime.composeFiles),
          localDomain: options.localDomain,
          providerPort: options.providerPort,
          allowedOrigins: prepared.allowedOrigins,
        }),
        tamaUpstream: `http://${selected}:${tamaPort}`,
      }
    : null;
  if (!topology && (options.providerService || options.providerRuntime))
    throw usageError("provider runtime selection requires local HTTPS");
  if (options.providerService === selected)
    throw usageError("Tama and provider must be different services");
  if (
    topology &&
    (services.caddy ||
      service.network_mode ||
      service.profiles?.length ||
      (service.networks && !("default" in service.networks)))
  )
    throw ownershipError(
      "local HTTPS addition needs an unprofiled Tama service on the default network and an unused caddy service name",
    );
  const startServices = new Set<string>();
  function selectDependencies(name: string) {
    if (name === options.providerService || startServices.has(name)) return;
    startServices.add(name);
    const dependencies = services[name]?.depends_on;
    const names = Array.isArray(dependencies)
      ? dependencies.filter((dependency): dependency is string => typeof dependency === "string")
      : dependencies && typeof dependencies === "object"
        ? Object.keys(dependencies)
        : [];
    for (const dependency of names) selectDependencies(dependency);
  }
  selectDependencies(selected);
  if (topology) {
    const conflictingServices = [...startServices].filter(
      (name) =>
        name !== selected &&
        services[name]?.ports?.some((port) => {
          const published = port.published;
          if (typeof published === "number") return published === 443;
          if (typeof published !== "string") return false;
          if (/^443$/u.test(published)) return true;
          return /^(?:\[[^\]]+\]|[^:]+):443(?::\d+)?$/u.test(published);
        }),
    );
    if (conflictingServices.length > 0)
      throw ownershipError(
        `local HTTPS addition cannot bind host port 443; a selected startup dependency already publishes it: ${conflictingServices.join(", ")}`,
        { port: 443, services: conflictingServices },
      );
  }
  if (service.build && !options.image)
    throw usageError(
      "the selected Tama service has a custom build; select its compatible release base explicitly with --image",
    );
  if (topology || (service.build && options.image)) validateComposeBuildOverrideVersion();
  const image = options.image ?? current.tamaImage;
  const owned = createOwnedFilePlanner(root, progress.id, Boolean(progress.pending));
  const state = resolveMcpAppState({
    root,
    identity: prepared.identity,
    contractPath: prepared.contractPath,
    contractDocument: prepared.contractDocument,
    selectedCompose: current.composeFile,
    topology,
  });
  const contractPath = join(root, MCP_ADDITION.contract);
  const placeholder = owned.plan(contractPath, serializeMcpAppLocalContract(state.localContract));
  const result = planMcpApp({
    root,
    options: {
      ...requested,
      localHttps: topology,
      allowedOrigins: prepared.allowedOrigins,
      tamaOrigin:
        options.tamaOrigin ?? (topology ? undefined : new URL(current.runtime.healthUrl).origin),
    },
    identity: prepared.identity,
    state,
    contractDocument: prepared.contractDocument,
    port: topology?.tamaPort ?? current.port,
    tamaImage: image,
    manageFile: owned.plan,
    localContractOperation: placeholder,
    materializeKeys,
    tamaEnvironmentFile: MCP_ADDITION.environment,
  });
  const variables = result.environmentInput.variables;
  const shadowed = Object.keys(variables).filter((name) =>
    Object.hasOwn(service.environment ?? {}, name),
  );
  if (shadowed.length)
    throw ownershipError(
      `inline Compose environment shadows the new MCP App fragment: ${shadowed.join(", ")}; move these declarations into your existing env_file before generation`,
    );
  const destinations = [
    MCP_ADDITION.environment,
    MCP_ADDITION.compose,
    MCP_ADDITION.contract,
    MCP_ADDITION.readme,
    MCP_ADDITION.receipt,
  ];
  if (destinations.includes(prepared.identity.environmentFile))
    throw usageError("provider fragment collides with an MCP App generation destination");
  const secrets = [
    MCP_ADDITION.environment,
    prepared.identity.environmentFile,
    ...(topology ? Object.values(ADDITION_TLS) : []),
  ];
  validateSecretFilesUntracked(root, secrets);
  const ignorePath = join(root, "tama/.gitignore");
  inspectRegularFile(ignorePath);
  const originalIgnore = inspectRegularFile(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const ignoreLines = secrets.map((path) => `/${relative("tama", path).split("\\").join("/")}`);
  const missing = ignoreLines.filter((line) => !originalIgnore.split(/\r?\n/u).includes(line));
  const ignore = operationForContent(
    ignorePath,
    missing.length
      ? `${originalIgnore}${originalIgnore.endsWith("\n") || !originalIgnore ? "" : "\n"}\n# MCP App private material\n${missing.join("\n")}\n`
      : originalIgnore,
    { owner: "user", allowUnmanagedUpdate: true },
  );
  const fromBase = (path: string) =>
    `./${relative(dirname(current.composeFile), join(root, path)).split("\\").join("/")}`;
  const serviceAddition: Record<string, unknown> = {
    image,
    env_file: [{ path: fromBase(MCP_ADDITION.environment), required: true }],
  };
  const additions: Record<string, unknown> = { [selected]: serviceAddition };
  if (topology) {
    serviceAddition.image = `${image.replace(/[^a-zA-Z0-9_.-]+/gu, "-")}-local-ca`;
    serviceAddition.build = { context: fromBase("tama"), dockerfile: "tama-local-ca.Dockerfile" };
    // The public listener moves to Caddy; free the old host port for the provider.
    serviceAddition.ports = [];
    additions.caddy = {
      image: topology.caddyImage,
      restart: "unless-stopped",
      depends_on: { [selected]: { condition: "service_started" } },
      ports: ["127.0.0.1:443:443", "[::1]:443:443"],
      ...(topology.providerService ? {} : { extra_hosts: ["host.docker.internal:host-gateway"] }),
      networks: { default: { aliases: [topology.providerHost, topology.tamaHost] } },
      volumes: [
        `${fromBase("tama/Caddyfile")}:/etc/caddy/Caddyfile:ro`,
        `${fromBase("tama/mcp-app-tls")}:/etc/tama-kit/tls:ro`,
      ],
    };
  } else if (new URL(result.plan.providerOrigin).hostname === "host.docker.internal") {
    serviceAddition.extra_hosts = ["host.docker.internal:host-gateway"];
  }
  if (!topology && service.build) serviceAddition.build = null;
  const document = new Document({ services: additions });
  if (!topology && service.build) {
    const build = document.getIn(["services", selected, "build"], true) as { tag: string };
    build.tag = "!reset";
  }
  if (topology) {
    const ports = document.getIn(["services", selected, "ports"], true) as { tag: string };
    ports.tag = "!reset";
    const build = document.getIn(["services", selected, "build"], true) as { tag: string };
    build.tag = "!override";
  }
  const composeFiles = [...current.runtime.composeFiles, join(root, MCP_ADDITION.compose)];
  const flags = composeFiles.map((path) => `--compose ${quote(relative(root, path))}`).join(" ");
  const environmentFlag = current.runtime.environmentFile
    ? ` --env-file ${quote(relative(root, current.runtime.environmentFile))}`
    : "";
  const selectFlags = `--service ${quote(selected)}${environmentFlag}${options.providerService ? ` --provider-service ${quote(options.providerService)}` : ""}`;
  const native = `docker compose ${composeFiles.map((path) => `-f ${quote(relative(root, path))}`).join(" ")}`;
  if (topology) startServices.add("caddy");
  const commands = {
    setup: `tama-kit setup ${flags} ${selectFlags}`,
    activate: `tama-kit setup ${flags} ${selectFlags} --activate`,
    doctor: `tama-kit doctor ${flags} ${selectFlags}`,
    native: `${native} up -d --no-deps${topology ? " --build" : ""} ${[...startServices].map(quote).join(" ")}`,
    status: `${native} ps`,
  };
  const environmentPath = join(root, MCP_ADDITION.environment);
  let environmentContent = `# Generated by Tama Kit. Project-owned; keep private.\n${Object.entries(
    variables,
  )
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  const validateResumedEnvironment = (existingContent: string) => {
    const values = parseEnvironment(existingContent, environmentPath);
    const expected = parseEnvironment(environmentContent, environmentPath);
    const persistedKeyVariables = new Set([
      "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
      "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
    ]);
    for (const [name, value] of expected)
      if (!persistedKeyVariables.has(name) && values.get(name) !== value)
        throw ownershipError(
          "resume configuration disagrees with existing MCP App environment; use the original generation options",
          { path: environmentPath },
        );
    const key = values.get("TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY");
    const kid = values.get("TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID");
    if (!key || !kid)
      throw ownershipError(
        "existing MCP App environment is missing its persisted introspection signing key pair",
        { path: environmentPath },
      );
    validateOAuthPrivateJwk(
      key,
      kid,
      "TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY",
      "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID",
    );
  };
  if (progress.pending && inspectRegularFile(environmentPath)) {
    const existing = readFileSync(environmentPath, "utf8");
    validateResumedEnvironment(existing);
    environmentContent = existing;
  }
  const operations: FileOperation[] = [
    ignore,
    owned.plan(environmentPath, environmentContent, {
      sensitive: true,
      mode: 0o600,
      validateExisting: validateResumedEnvironment,
    }),
    ...result.plan.operations.filter((operation) => operation.path !== contractPath),
    owned.plan(contractPath, serializeMcpAppLocalContract(state.localContract)),
    ...(topology
      ? [
          owned.plan(
            join(root, "tama/Caddyfile"),
            renderLocalHttpsCaddyfile(topology).replaceAll("/local-key.pem", "/local.pem"),
          ),
          owned.plan(
            join(root, "tama/tama-local-ca.Dockerfile"),
            renderLocalCaDockerfile(image).replace("COPY tls/", "COPY mcp-app-tls/"),
          ),
        ]
      : []),
    owned.plan(
      join(root, MCP_ADDITION.compose),
      `# Generated by Tama Kit. Project-owned; edit directly.\n${document.toString()}`,
    ),
    owned.documentation(
      join(root, MCP_ADDITION.readme),
      `# MCP App integration\n\nGenerated by Tama Kit. These files belong to the application.\n\nRun from the project root; preserve this Compose file order:\n\n\`\`\`sh\n${commands.setup}\n${commands.activate}\n${commands.doctor}\n\`\`\`\n\nThe provider must load \`${prepared.identity.environmentFile}\`. Loader status: ${state.environmentLoading}. Start the provider yourself. After Tama is enabled, set \`${state.bindings.mode}=enabled\`, restart the provider, and rerun activation. Generation does not verify live services or provision Terraform.\n\nNative operation (Tama Kit can be removed after generation):\n\n\`\`\`sh\n${commands.native}\n${commands.status}\n\`\`\`\n\n${topology ? "The override replaces the Tama build with a derived CA image and clears its old published ports; Caddy provides local HTTPS. Docker Compose 2.24.4 or later is required.\n\n" : ""}${topology ? "For a host provider, load the public CA at tama/mcp-app-tls/rootCA.pem into its development trust configuration. " : ""} Keep both MCP App environment fragments and private TLS material untracked. Existing runtime keys and Terraform remain in their original files. Bootstrap receipts record history only; deleting completed output does not authorize regeneration.\n`,
    ),
  ];
  if (topology) {
    for (const path of Object.values(ADDITION_TLS)) {
      const filename = join(root, path);
      const existing = inspectRegularFile(filename);
      if (existing && !progress.pending)
        throw ownershipError(
          "MCP App TLS destination already exists; inspect it before adding this capability",
          { path },
        );
      operations.push(
        owned.plan(
          filename,
          existing
            ? readFileSync(filename, "utf8")
            : "certificate material generated after review\n",
          {
            sensitive: path === ADDITION_TLS.bundle,
            mode: path === ADDITION_TLS.bundle ? 0o600 : 0o644,
            ...(path === ADDITION_TLS.bundle
              ? {
                  validateExisting: (content: string) =>
                    validateAdditionCertificateBundle(topology, content, options.installLocalCa),
                }
              : {}),
          },
        ),
      );
    }
  }
  if (progress.pending) {
    const paths = new Set(
      operations.map((operation) => normalizeGenerationPath(relative(root, operation.path))),
    );
    for (const path of progress.pending)
      if (!paths.has(path) && !(topology && secrets.includes(path)))
        throw ownershipError("resume options do not include every pending destination");
    for (const operation of operations)
      if (
        operation.action === "create" &&
        !progress.pending.includes(normalizeGenerationPath(relative(root, operation.path)))
      )
        throw ownershipError("resume cannot recreate output not listed as pending");
  }
  const receipt = `${JSON.stringify({ schemaVersion: 2, generator: "Generated by Tama Kit", operation: { id: progress.id, kind: "mcp-app" }, progress: { status: "complete" } }, null, 2)}\n`;
  const receiptPath = join(root, MCP_ADDITION.receipt);
  inspectRegularFile(receiptPath);
  operations.push(
    operationForContent(receiptPath, receipt, {
      owner: "user",
      allowUnmanagedUpdate: Boolean(progress.pending),
    }),
  );
  const plan: RuntimePlan = {
    ...current,
    tamaImage: image,
    localHttps: topology,
    mcpApp: result.plan,
    operations,
    runtime: { ...current.runtime, composeFiles },
  };
  return { plan, commands, secrets, variables };
}

export async function writeMcpAppAddition(
  addition: ReturnType<typeof planMcpAppAddition>,
  options: AdditionOptions,
) {
  const { plan, secrets, variables } = addition;
  if (plan.localHttps) {
    const tls = additionCertificates(plan.root, plan.localHttps, options.installLocalCa);
    plan.operations = plan.operations.map((operation) => {
      const materialized = tls.find(({ path }) => path === operation.path);
      if (!materialized) return operation;
      if (
        materialized.action !== operation.action ||
        materialized.beforeDigest !== operation.beforeDigest
      )
        throw ownershipError(
          "TLS destinations changed after review; no project files were written",
        );
      return materialized;
    });
  }
  await writeScaffold(
    plan,
    () => {
      validateSecretFilesIgnored(plan.root, secrets);
      const actual = inspectCurrentConfiguration({
        ...options.selection,
        targetPath: plan.root,
        composeFiles: plan.runtime.composeFiles,
        service: plan.runtime.service,
        environmentFile: MCP_ADDITION.environment,
        providerService: options.providerService,
      });
      if (!actual.runtime.modeSource || actual.mcpApp?.lifecycle !== "prepared")
        throw ownershipError("the new MCP App mode must have one unshadowed prepared source");
      for (const [name, value] of Object.entries(variables)) {
        const expected = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
        if (actual.runtime.environment.get(name) !== expected)
          throw ownershipError(`effective ${name} shadows the new MCP App fragment`);
      }
    },
    MCP_ADDITION.receipt,
  );
}

export function additionReviewDigest(addition: ReturnType<typeof planMcpAppAddition>) {
  return contentDigest(
    JSON.stringify(
      addition.plan.operations.map(({ action, path, beforeDigest, afterDigest }) => ({
        action,
        path,
        beforeDigest,
        afterDigest,
      })),
    ),
  );
}
