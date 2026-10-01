import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  type ComposeDeclarationInspection,
  type ComposeExecute,
  inspectComposeDeclarations,
  loadComposeModel,
  loadComposeServiceEnvironment,
} from "../bootstrap/compose-inspection.mjs";
import { DEFAULTS } from "../bootstrap/constants.mjs";
import {
  newEnvironment,
  PENDING_SECRET_VALUE,
  postgresEnvironment,
} from "../bootstrap/environment.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { validateMcpAppLocalContract } from "../bootstrap/mcp-app-local-contract.mjs";
import {
  inspectMcpAppRecovery,
  type McpAppRecovery,
  renderMcpAppRecovery,
  topologyRuntimeValues,
  validateRecoveredMcpApp,
} from "../bootstrap/mcp-app-recovery.mjs";
import {
  associateTamaDatabase,
  inspectPersistence,
  type PersistenceObservation,
  postgresDataSources,
  providerDataSources,
} from "../bootstrap/persistence.mjs";
import {
  CORE_REQUIRED_VARIABLES,
  classifyEnvironmentReference,
  coreSemanticIssues,
  databaseUrlIssues,
  type EnvironmentDoctorResult,
  type EnvironmentFileReference,
  type EnvironmentFileReport,
  type EnvironmentInitFile,
  type EnvironmentInitResult,
  type EnvironmentSelection,
  environmentCommand,
  isSupportedRole,
  type PublicRuntimeIdentity,
  publishedHostPort,
  resolvePublicIdentity,
  serializeDatabaseUrl,
} from "../domain/environment.mjs";
import { ownershipError, usageError } from "../errors.mjs";
import { parseEnvironment } from "../shared/environment.mjs";
import { contentDigest, inspectRegularFile } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import { validateOAuthPrivateJwk } from "../shared/oauth-key.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import type { FileOperation, McpAppLocalContract } from "../types.mjs";

/**
 * Read-only private environment inspection.
 *
 * The doctor is independent of runtime readiness: it diagnoses the files the
 * current configuration declares, never starts services, and never compares
 * secrets against examples or receipt hashes. Optional files and pending
 * manual provisioner setup never make a valid environment fail.
 */

export type EnvironmentCommandSelection = {
  targetPath?: string;
  composeFiles?: string[];
  service?: string;
  environmentFile?: string;
  contractPath?: string;
  providerService?: string;
};

export type EnvironmentDoctorOptions = EnvironmentCommandSelection & {
  cwd: string;
};

export type EnvironmentInitOptions = EnvironmentCommandSelection & {
  cwd: string;
  dryRun: boolean;
  fresh: boolean;
};

type Dependencies = {
  execute?: ComposeExecute;
  validatePrerequisite?: () => void;
};

type Assessment = {
  status: EnvironmentFileReport["status"];
  issues: string[];
  values: Map<string, string> | null;
};

const JWK_PAIRS: [string, string][] = [
  ["TAMA_OAUTH_PRIVATE_JWK", "TAMA_OAUTH_PRIVATE_JWK_ID"],
  ["TAMA_MCP_APP_INTROSPECTION_PRIVATE_KEY", "TAMA_MCP_APP_INTROSPECTION_SIGNING_KEY_ID"],
];

const GENERATION_RECEIPTS = ["tama/.tama-kit.json", "tama/.tama-kit-mcp-app.json"];

function assessExistingFile(
  root: string,
  reference: EnvironmentFileReference,
  context: {
    providerPairs?: [string, string][];
    identity?: PublicRuntimeIdentity | null;
    effectiveValues?: Map<string, string> | null;
    allowPublicOverlay?: boolean;
  } = {},
): Assessment {
  const issues: string[] = [];
  let values: Map<string, string> | null = null;
  let stat: import("node:fs").Stats;
  try {
    stat = lstatSync(reference.path);
  } catch {
    return { status: "missing", issues: [], values: null };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    issues.push("destination is not a regular file; replace it with a real file");
    return { status: "invalid", issues, values: null };
  }
  if ((stat.mode & 0o077) !== 0) {
    issues.push(`permissions must be owner-only (0600); run: chmod 600 ${reference.relative}`);
  }
  if (isSupportedRole(reference.role)) {
    for (const check of [validateSecretFilesUntracked, validateSecretFilesIgnored]) {
      try {
        check(root, [reference.path]);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  try {
    values = parseEnvironment(readFileSync(reference.path, "utf8"), reference.relative);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return { status: "invalid", issues, values: null };
  }
  const pending = [...values.values()].filter((value) => value === PENDING_SECRET_VALUE);
  if (pending.length > 0) {
    issues.push(
      "contains pending Tama Kit secret material from an interrupted generation; resume it with tama-kit bootstrap --resume <operation-id>",
    );
  }
  const pairs = context.providerPairs ?? [];
  for (const [key, keyId] of [...JWK_PAIRS, ...pairs]) {
    if (Boolean(values.get(key)) !== Boolean(values.get(keyId))) {
      issues.push(`${key} and ${keyId} must be defined together`);
    }
    if (values.get(key) && values.get(key) !== PENDING_SECRET_VALUE) {
      try {
        validateOAuthPrivateJwk(values.get(key) ?? "", values.get(keyId) ?? "", key, keyId);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (reference.role === "postgres") {
    const missingPostgres = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"].filter(
      (name) => !(values.get(name) ?? ""),
    );
    if (missingPostgres.length > 0) {
      issues.push(`missing required variables: ${missingPostgres.join(", ")}`);
    }
  }
  let publicConflict = false;
  if (reference.role === "core") {
    const semantic = coreSemanticIssues(values, context.identity ?? null);
    for (const issue of semantic.issues) {
      if (
        context.allowPublicOverlay &&
        issue ===
          "public identity does not match the selected Compose configuration and project example"
      )
        continue;
      if (!issues.includes(issue)) issues.push(issue);
    }
    publicConflict = context.allowPublicOverlay ? false : semantic.publicConflict;
    if (context.effectiveValues) {
      const effective = coreSemanticIssues(context.effectiveValues, context.identity ?? null);
      for (const issue of effective.issues) issues.push(`effective Compose environment: ${issue}`);
      publicConflict ||= effective.publicConflict;
    }
  }
  const incomplete = issues.some((issue) => issue.startsWith("missing required"));
  const status = incomplete
    ? "invalid"
    : publicConflict
      ? "public-configuration-conflict"
      : issues.length > 0
        ? "invalid"
        : "valid";
  return { status, issues, values };
}

function inspectGenerationHistory(root: string, warnings: string[]) {
  for (const relativePath of GENERATION_RECEIPTS) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    try {
      const evidence = readGenerationEvidence(path);
      if (evidence.kind === "legacy") {
        warnings.push(
          `${relativePath} is legacy v1 history and does not authorize recovery decisions`,
        );
      } else if (evidence.kind === "receipt" && evidence.receipt.progress.status === "incomplete") {
        warnings.push(
          `${relativePath} records an incomplete generation; resume it with tama-kit bootstrap --resume <operation-id> before recovering environment files`,
        );
      }
    } catch {
      warnings.push(`${relativePath} could not be read; current-file diagnosis continues`);
    }
  }
}

export async function runEnvironmentDoctor(
  options: EnvironmentDoctorOptions,
  dependencies: Dependencies = {},
): Promise<EnvironmentDoctorResult> {
  const inspection = inspectComposeDeclarations(options, dependencies);
  validateEnvironmentSelectors(inspection, options);
  const root = inspection.root;
  /** @type {string[]} */ const warnings = [];
  if (inspection.unresolvedInterpolation.length > 0) {
    warnings.push(
      `unresolved interpolation in env_file declarations: ${inspection.unresolvedInterpolation.join(", ")}; fix the Compose declarations before trusting this inspection`,
    );
  }
  const contractPath = resolve(
    root,
    options.contractPath ?? "tama/contracts/mcp-app-provider-v1.json",
  );
  const contractReferenced = options.contractPath !== undefined || existsSync(contractPath);
  let providerFragment: string | undefined;
  let providerPairs: [string, string][] = [];
  let mcpContract: McpAppLocalContract | undefined;
  if (contractReferenced) {
    if (!inspectRegularFile(contractPath)) {
      warnings.push(
        `local MCP App contract is missing: ${relative(root, contractPath)}; its provider fragment could not be inspected`,
      );
    } else {
      try {
        const contract = validateMcpAppLocalContract(
          JSON.parse(readFileSync(contractPath, "utf8")),
          { currentConfiguration: true },
        );
        mcpContract = contract;
        providerFragment = resolve(root, contract.provider.environment_file);
        providerPairs = [
          [
            contract.bindings.access_token_private_signing_key,
            contract.bindings.access_token_signing_key_id,
          ],
        ];
      } catch {
        warnings.push(
          `local MCP App contract is invalid: ${relative(root, contractPath)}; its provider fragment could not be inspected`,
        );
      }
    }
  }
  const references = environmentReferences(inspection, providerFragment);
  inspectGenerationHistory(root, warnings);
  const identity = publicIdentityFor(
    root,
    inspection,
    options,
    references,
    dependencies,
    mcpContract ? topologyRuntimeValues(mcpContract) : undefined,
  );
  const parsed = new Map<EnvironmentFileReference["role"], Map<string, string> | null>();
  const files: EnvironmentFileReport[] = references.map((reference): EnvironmentFileReport => {
    const base = {
      role: reference.role,
      relative: reference.relative,
      services: reference.services,
      required: reference.required,
      source: reference.source,
    };
    if (lstatSyncSafe(reference.path) === null) {
      if (!reference.required) {
        return {
          ...base,
          status: "optional-absent",
          issues: [],
          variables: null,
        };
      }
      return {
        ...base,
        status: isSupportedRole(reference.role) ? "missing" : "unsupported",
        issues: isSupportedRole(reference.role)
          ? [`${reference.relative} is required by the current configuration but absent`]
          : [
              `${reference.relative} is required by the current configuration but absent; restore it from your project template or provider documentation`,
            ],
        variables: null,
      };
    }
    const assessed = assessExistingFile(root, reference, {
      providerPairs: reference.role === "provider" ? providerPairs : undefined,
      identity: reference.role === "core" ? identity.identity : undefined,
      effectiveValues: reference.role === "core" ? identity.effectiveValues : undefined,
      allowPublicOverlay: Boolean(
        mcpContract?.topology && references.some((item) => item.role === "mcp-app"),
      ),
    });
    parsed.set(
      reference.role,
      reference.role === "core" ? (identity.effectiveValues ?? assessed.values) : assessed.values,
    );
    return {
      ...base,
      status: assessed.status,
      issues: assessed.issues,
      variables: assessed.values?.size ?? null,
    };
  });
  for (const reference of inspection.envReferences.filter((item) => item.interpolated)) {
    if (!reference.required) continue;
    files.push({
      role: "application",
      relative: reference.declaredPath,
      services: reference.services,
      required: true,
      source: "compose",
      status: "invalid",
      issues: [
        `${reference.declaredPath} contains unresolved interpolation; the destination was not guessed`,
      ],
      variables: null,
    });
  }
  if (identity.issues.length > 0) {
    warnings.push(...identity.issues);
  }
  // Core/PostgreSQL credential agreement between surviving valid files.
  const core = parsed.get("core");
  const postgres = parsed.get("postgres");
  if (core && postgres) {
    for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]) {
      if (core.get(name) && core.get(name) !== postgres.get(name)) {
        const report = files.find((file) => file.role === "postgres");
        if (report && !report.issues.some((issue) => issue.startsWith(`${name} disagrees`))) {
          report.issues.push(
            `${name} disagrees with the core environment file; the database would not authenticate`,
          );
          report.status = "invalid";
        }
      }
    }
  }
  const nextActions = [];
  if (mcpContract) {
    const service = tamaServiceName(inspection, options, references);
    const coreReference = references.find((reference) => reference.role === "core");
    const fragment = references.find(
      (reference) => reference.role === "mcp-app" && reference.services.includes(service ?? ""),
    );
    if (service && coreReference) {
      try {
        const recovery = inspectMcpAppRecovery({
          inspection,
          contract: mcpContract,
          contractPath,
          tamaService: service,
          corePath: coreReference.path,
          tamaPath: fragment?.path ?? coreReference.path,
          providerService: options.providerService,
          missingPaths: references
            .filter((reference) => !lstatSyncSafe(reference.path))
            .map((reference) => reference.path),
          reissuing: false,
          execute: dependencies.execute,
        });
        if (recovery.issues.length) {
          warnings.push(...recovery.issues);
          const report = files.find((file) => file.role === "mcp-app" || file.role === "provider");
          if (report && report.status === "valid") {
            report.status = "invalid";
            report.issues.push(...recovery.issues);
          }
        }
      } catch {
        warnings.push(
          "the MCP App effective environment could not be inspected safely; restore its configuration before setup",
        );
        const report = files.find((file) => file.role === "provider");
        if (report && report.status === "valid") {
          report.status = "invalid";
          report.issues.push("MCP App effective environment inspection failed");
        }
      }
    }
  }
  const requiredFailures = files.filter(
    (file) =>
      file.required &&
      ["missing", "invalid", "unsupported", "public-configuration-conflict"].includes(file.status),
  );
  if (requiredFailures.length > 0) {
    for (const file of requiredFailures) {
      if (file.status === "unsupported") {
        nextActions.push(
          `Restore ${file.relative} manually from your project template or provider documentation`,
        );
      } else if (file.status === "missing") {
        nextActions.push(
          `Restore ${file.relative} from a private backup or recreate it from the project's public examples (for example, ${exampleFor(file.role)})`,
        );
      } else {
        nextActions.push(`Repair ${file.relative} before running setup`);
      }
    }
  }
  for (const file of files) {
    if (file.status === "optional-absent" && file.role === "application")
      nextActions.push(
        `If ${file.relative} is needed, create it manually; optional files are never auto-created`,
      );
  }
  const coreValues = parsed.get("core");
  if (
    coreValues &&
    (coreValues.get("TAMA_CLIENT_ID") ?? "") === "" &&
    (coreValues.get("TAMA_CLIENT_SECRET") ?? "") === ""
  ) {
    nextActions.push(
      "Complete private root/provisioner onboarding and store TAMA_CLIENT_ID and TAMA_CLIENT_SECRET locally; empty provisioner credentials are expected until then",
    );
  }
  for (const warning of warnings) {
    if (warning.includes("incomplete generation"))
      nextActions.push("Resume the interrupted generation before issuing a new environment set");
  }
  const inspectionIncomplete =
    inspection.interpolationLoss ||
    inspection.envReferences.some((reference) => reference.interpolated && reference.required);
  const ok = requiredFailures.length === 0 && !inspectionIncomplete;
  return {
    schemaVersion: 1,
    ok,
    command: "env",
    subcommand: "doctor",
    mode: "inspect",
    root,
    composeFiles: inspection.composeFiles.map((path) => relative(root, path)),
    selection: {
      ...(options.targetPath !== undefined ? { targetPath: options.targetPath } : {}),
      composeFiles: options.composeFiles ?? [],
      ...(options.service !== undefined ? { service: options.service } : {}),
      ...(options.environmentFile !== undefined ? { envFile: options.environmentFile } : {}),
      ...(options.contractPath !== undefined ? { contract: options.contractPath } : {}),
      ...(options.providerService !== undefined
        ? { providerService: options.providerService }
        : {}),
    },
    files,
    persistence: { status: "not-checked" },
    changes: [],
    nextActions,
    warnings,
  };
}

/**
 * Create-only private environment recovery.
 *
 * Existing files are preserved byte-for-byte. Missing derived files are
 * reconstructed from surviving secrets without issuing anything new; new
 * issuance is refused when relevant persisted data is detected, and an
 * unknown persistence state requires the explicit --fresh assertion. Every
 * write is an exclusive, sensitive, mode-0600 create inside one transaction.
 */
export async function runEnvironmentInit(
  options: EnvironmentInitOptions,
  dependencies: Dependencies = {},
): Promise<EnvironmentInitResult> {
  const inspection = inspectComposeDeclarations(options, dependencies);
  validateEnvironmentSelectors(inspection, options);
  const root = inspection.root;
  const blockers: string[] = [];
  const contract = await readCurrentContract(root, options);
  const references = environmentReferences(inspection, contract.providerFragment);
  for (const reference of inspection.envReferences) {
    if (!reference.interpolated || !reference.required) continue;
    blockers.push(
      `${reference.declaredPath} contains unresolved interpolation; fix the Compose declaration before env init recovers it`,
    );
  }
  const history = generationHistory(root);
  if (history.blocker) blockers.push(history.blocker);
  const identity = publicIdentityFor(
    root,
    inspection,
    options,
    references,
    dependencies,
    contract.document ? topologyRuntimeValues(contract.document) : undefined,
  );
  const assessed = new Map<string, Assessment | null>();
  for (const reference of references) {
    assessed.set(
      reference.path,
      lstatSyncSafe(reference.path) === null
        ? null
        : assessExistingFile(root, reference, {
            providerPairs: reference.role === "provider" ? contract.providerPairs : undefined,
            identity: reference.role === "core" ? identity.identity : undefined,
            effectiveValues: reference.role === "core" ? identity.effectiveValues : undefined,
            allowPublicOverlay: Boolean(
              contract.document?.topology && references.some((item) => item.role === "mcp-app"),
            ),
          }),
    );
  }
  const missing = references.filter(
    (reference) =>
      reference.required &&
      isSupportedRole(reference.role) &&
      assessed.get(reference.path) === null,
  );
  for (const reference of references) {
    if (!reference.required || assessed.get(reference.path) !== null) continue;
    if (!isSupportedRole(reference.role)) {
      blockers.push(
        `${reference.relative} is not a Tama-owned file; restore it from your project template or provider documentation before running env init`,
      );
    }
  }
  for (const reference of references) {
    const assessment = assessed.get(reference.path);
    if (!reference.required || assessment === undefined || assessment === null) continue;
    if (assessment.status !== "valid") {
      blockers.push(
        `repair ${reference.relative} before running env init: ${assessment.issues.join("; ")}`,
      );
    }
  }
  const missingCore = missing.some((reference) => reference.role === "core");
  const newSecrets = missing.some((reference) => reference.role !== "postgres");
  if (!contract.document) {
    const mcpDeclared =
      references.some((reference) => reference.role === "mcp-app") ||
      identity.effectiveValues?.has("TAMA_MCP_APP_MODE") ||
      references
        .filter((reference) => reference.role === "core")
        .some((reference) => {
          for (const path of [reference.path, `${reference.path}.example`]) {
            if (
              inspectRegularFile(path) &&
              /^\s*(?:export\s+)?TAMA_MCP_APP_MODE\s*=/mu.test(readFileSync(path, "utf8"))
            )
              return true;
          }
          return false;
        });
    if (mcpDeclared)
      blockers.push(
        "the current MCP App configuration has no valid selected local contract; restore the contract or select --contract before environment recovery",
      );
  }
  let mcpRecovery: McpAppRecovery | undefined;
  if (contract.document && missing.length > 0) {
    const service = tamaServiceName(inspection, options, references);
    const core = references.find((reference) => reference.role === "core");
    const fragments = references.filter(
      (reference) => reference.role === "mcp-app" && reference.services.includes(service ?? ""),
    );
    if (!service || !core || fragments.length > 1)
      blockers.push(
        "the current MCP App destinations are ambiguous; select one Tama service and integration fragment",
      );
    else {
      try {
        mcpRecovery = inspectMcpAppRecovery({
          inspection,
          contract: contract.document,
          contractPath: contract.path ?? "",
          tamaService: service,
          corePath: core.path,
          tamaPath: fragments[0]?.path ?? core.path,
          providerService: options.providerService,
          missingPaths: missing.map((reference) => reference.path),
          reissuing: newSecrets,
          execute: dependencies.execute,
        });
        blockers.push(...mcpRecovery.issues);
      } catch {
        blockers.push(
          "the MCP App effective environment could not be inspected safely; check its env_file declarations and inputs before environment recovery",
        );
      }
    }
  }
  const issuance = newSecrets ? "new" : missing.length > 0 ? "derived" : "none";
  if (missingCore && identity.identity === null) {
    for (const issue of identity.issues) blockers.push(issue);
  }
  let persistence: EnvironmentInitResult["persistence"] = {
    status: "not-required",
    freshAsserted: false,
    detail: "no new secrets are issued",
    checked: [],
  };
  let recheckPersistence:
    | (() => { status: "absent" | "detected" | "unknown"; detail: string })
    | undefined;
  if (issuance === "new") {
    const model = loadComposeModel(
      root,
      inspection.composeFiles,
      { noEnvResolution: true },
      dependencies.execute,
    );
    const association = associateTamaDatabase({
      model,
      tamaService: tamaServiceName(inspection, options, references),
      postgresServices: [
        ...new Set(
          references
            .filter((reference) => reference.role === "postgres")
            .flatMap((reference) => reference.services),
        ),
      ],
      ...(identity.effectiveDatabaseHost ? { databaseHost: identity.effectiveDatabaseHost } : {}),
    });
    if (mcpRecovery) {
      if (association.kind === "ambiguous")
        blockers.push(`${association.detail}; new secret issuance is refused`);
      const observe = () =>
        observeMcpPersistence(
          root,
          model,
          association,
          mcpRecovery,
          inspection,
          dependencies.execute,
        );
      recheckPersistence = observe;
      const decision = authorizeIssuance(observe(), options.fresh);
      persistence = decision.persistence;
      if (decision.blocker) blockers.push(decision.blocker);
    } else if (association.kind === "ambiguous") {
      persistence = {
        status: "unknown",
        freshAsserted: false,
        detail: association.detail,
        checked: [],
      };
      blockers.push(`${association.detail}; new secret issuance is refused`);
    } else if (association.kind === "none") {
      const decision = authorizeIssuance(
        { status: "unknown", detail: association.detail, checked: [] },
        options.fresh,
      );
      persistence = decision.persistence;
      if (decision.blocker) blockers.push(decision.blocker);
    } else {
      const sources = association.sources;
      const observe = () =>
        inspectPersistence({
          root,
          project: model.name,
          sources,
          execute: dependencies.execute,
        });
      recheckPersistence = () => {
        const observation = observe();
        return { status: observation.status, detail: observation.detail };
      };
      const decision = authorizeIssuance(observe(), options.fresh);
      persistence = decision.persistence;
      if (decision.blocker) blockers.push(decision.blocker);
    }
  }

  if (missing.length > 0)
    blockers.push(
      ...recoveryInputIssues(
        missing,
        assessed,
        identity.identity,
        identity.effectiveValues,
        Boolean(mcpRecovery),
      ),
    );
  let operations: FileOperation[] = [];
  let applied = false;
  if (missing.length > 0 && blockers.length === 0 && !options.dryRun) {
    const mcpContents = mcpRecovery
      ? renderMcpAppRecovery(
          mcpRecovery,
          missing.map((reference) => reference.path),
        )
      : new Map<string, string>();
    const plan = renderMissingSet(missing, assessed, identity.identity, mcpContents);
    plan.sourceDigests.push(...identity.sourceDigests);
    if (mcpRecovery) plan.sourceDigests.push(...mcpRecovery.sourceDigests);
    const verifySources = () => {
      if (mcpRecovery) {
        const current = inspectComposeDeclarations(options, dependencies);
        if (JSON.stringify(current.services) !== JSON.stringify(inspection.services))
          throw ownershipError(
            "the selected Compose declarations changed during environment recovery; all new files were rolled back",
          );
      }
      for (const [path, digest] of plan.sourceDigests) {
        if (!inspectRegularFile(path) || contentDigest(readFileSync(path, "utf8")) !== digest) {
          throw ownershipError("an environment recovery input changed during the operation", {
            path,
          });
        }
      }
    };
    verifySources();
    for (const operation of plan.operations) {
      if (lstatSyncSafe(operation.path) !== null) {
        throw ownershipError(
          `destination already exists; refusing to overwrite: ${operation.path}`,
          { path: operation.path },
        );
      }
    }
    operations = plan.operations;
    await applyOperationsTransactionally(operations, () => {
      for (const operation of operations) {
        if (lstatSyncSafe(operation.path) === null) {
          throw ownershipError(`destination is missing after the operation: ${operation.path}`, {
            path: operation.path,
          });
        }
      }
      verifySources();
      if (missingCore) {
        const service = tamaServiceName(inspection, options, references);
        if (!service) throw ownershipError("the selected Tama service is ambiguous");
        const effective = loadComposeServiceEnvironment(
          inspection,
          service,
          { missingPaths: [], suppliedVariables: [] },
          dependencies.execute,
        );
        const semantic = coreSemanticIssues(effective.values, identity.identity);
        if (semantic.issues.length > 0) {
          throw ownershipError(
            `the recovered effective environment is invalid: ${semantic.issues.join("; ")}`,
          );
        }
      }
      if (mcpRecovery) {
        const service = tamaServiceName(inspection, options, references);
        if (!service) throw ownershipError("the selected Tama service is ambiguous");
        validateRecoveredMcpApp(mcpRecovery, {
          inspection,
          tamaService: service,
          execute: dependencies.execute,
          created: new Map(
            operations.map((operation) => [
              operation.path,
              "content" in operation ? operation.content : "",
            ]),
          ),
        });
      }
      if (recheckPersistence !== undefined) {
        const recheck = recheckPersistence();
        if (recheck.status === "detected" || (recheck.status === "unknown" && !options.fresh)) {
          throw ownershipError(
            recheck.status === "detected"
              ? `persistence appeared during the operation: ${recheck.detail}`
              : `persistence became unverifiable during the operation: ${recheck.detail}`,
          );
        }
      }
    });
    applied = true;
  }
  const plansCreate = blockers.length === 0 && (applied || options.dryRun);
  const plannedPaths = new Set(operations.map((operation) => operation.path));
  const files: EnvironmentInitFile[] = references.map((reference) => {
    const planned =
      plansCreate &&
      (applied
        ? plannedPaths.has(reference.path)
        : missing.some((item) => item.path === reference.path));
    const created = applied && plannedPaths.has(reference.path);
    return {
      role: reference.role,
      relative: reference.relative,
      source: reference.source,
      action: planned ? "create" : "preserve",
      issuance: planned ? (reference.role === "postgres" ? "derived" : "new") : "none",
      created,
    };
  });
  const nextActions: string[] = [];
  if (applied) {
    nextActions.push(
      `Run ${environmentCommand("setup", selectionFromOptions(options))} to start and verify the selected services.`,
    );
    nextActions.push(
      "Complete private root/provisioner onboarding and store TAMA_CLIENT_ID and TAMA_CLIENT_SECRET locally; environment completion does not verify runtime readiness.",
    );
    nextActions.push(
      "Review terraform init, validate, and plan in the project's Terraform root before any apply.",
    );
    if (persistence.freshAsserted) {
      nextActions.push(
        "--fresh asserted an unverified persistence state; confirm the local database is empty before starting services.",
      );
    }
    if (mcpRecovery) {
      nextActions.push(
        `Load the provider fragment through its application-owned environment workflow, verify both services in prepared mode, then use ${environmentCommand("setup", selectionFromOptions(options))} --activate for the existing staged MCP App activation flow.`,
      );
      if (mcpRecovery.contract.topology)
        nextActions.push(
          "Prepare the project's local HTTPS certificates and trust with its mkcert instructions before setup; env init does not create certificates or install trust.",
        );
    }
  }
  return {
    schemaVersion: 1,
    ok: blockers.length === 0,
    command: "env",
    subcommand: "init",
    mode: options.dryRun ? "dry-run" : "write",
    root,
    composeFiles: inspection.composeFiles.map((path) => relative(root, path)),
    selection: recordedSelection(options),
    files,
    persistence,
    changes: plansCreate
      ? (applied
          ? operations
          : missing.map((reference) => ({
              action: "create" as const,
              path: reference.path,
              content: "",
              owner: "tama-kit" as const,
              sensitive: true as const,
              mode: 0o600,
              beforeDigest: null,
              afterDigest: null as string | null,
              reason: "environment recovery create (planned)",
            }))
        ).map((operation) => ({
          action: "create" as const,
          relative: relative(root, operation.path),
          sensitive: true as const,
        }))
      : [],
    blockers,
    warnings: history.warnings,
    nextActions,
  };
}

/** @param {EnvironmentCommandSelection} options */
function selectionFromOptions(options: EnvironmentCommandSelection): EnvironmentSelection {
  return {
    ...(options.targetPath !== undefined ? { targetPath: options.targetPath } : {}),
    compose: options.composeFiles ?? [],
    ...(options.service !== undefined ? { service: options.service } : {}),
    ...(options.environmentFile !== undefined ? { envFile: options.environmentFile } : {}),
    ...(options.contractPath !== undefined ? { contract: options.contractPath } : {}),
    ...(options.providerService !== undefined ? { providerService: options.providerService } : {}),
  };
}

type ContractContext = {
  valid: boolean;
  document?: McpAppLocalContract;
  path?: string;
  providerFragment?: string;
  providerPairs: [string, string][];
};

async function readCurrentContract(
  root: string,
  options: EnvironmentCommandSelection,
): Promise<ContractContext> {
  const contractPath = resolve(
    root,
    options.contractPath ?? "tama/contracts/mcp-app-provider-v1.json",
  );
  if (options.contractPath === undefined && !existsSync(contractPath)) {
    return { valid: false, providerPairs: [] };
  }
  if (!inspectRegularFile(contractPath))
    throw ownershipError(
      "the selected local MCP App contract is missing; restore it before env init",
    );
  try {
    const contract = validateMcpAppLocalContract(
      JSON.parse(readFileSync(contractPath, "utf8")) as unknown,
      { currentConfiguration: true },
    );
    return {
      valid: true,
      document: contract,
      path: contractPath,
      providerFragment: resolve(root, contract.provider.environment_file),
      providerPairs: [
        [
          contract.bindings.access_token_private_signing_key,
          contract.bindings.access_token_signing_key_id,
        ],
      ],
    };
  } catch {
    throw ownershipError(
      "the selected local MCP App contract is invalid; repair it before env init issues secrets",
    );
  }
}

function environmentReferences(
  inspection: ComposeDeclarationInspection,
  providerFragment: string | undefined,
): EnvironmentFileReference[] {
  const root = inspection.root;
  const references: EnvironmentFileReference[] = [
    ...inspection.envReferences
      .filter((reference) => !reference.interpolated)
      .map(
        (reference): EnvironmentFileReference => ({
          role: classifyEnvironmentReference(
            basename(reference.path),
            providerFragment ? basename(providerFragment) : undefined,
          ),
          path: reference.path,
          relative: relative(root, reference.path),
          services: reference.services,
          required: reference.required,
          source: "compose",
        }),
      ),
    ...(providerFragment
      ? [
          {
            role: "provider" as const,
            path: providerFragment,
            relative: relative(root, providerFragment),
            services: [] as string[],
            required: true,
            source: "contract" as const,
          },
        ]
      : []),
  ];
  const unique = new Map<string, EnvironmentFileReference>();
  for (const reference of references) {
    const previous = unique.get(reference.path);
    unique.set(
      reference.path,
      previous
        ? {
            ...reference,
            required: previous.required || reference.required,
            services: [...new Set([...previous.services, ...reference.services])],
          }
        : reference,
    );
  }
  return [...unique.values()];
}

/** Credential characters the core renderer can emit unquoted. */
const SAFE_CORE_VALUE = /^[A-Za-z0-9.+/_-]+$/u;

function recoveryInputIssues(
  missing: EnvironmentFileReference[],
  assessed: Map<string, Assessment | null>,
  identity: PublicRuntimeIdentity | null,
  effectiveValues: Map<string, string> | null,
  supportsMcpRecovery = false,
): string[] {
  const issues: string[] = [];
  for (const reference of missing) {
    if (reference.role === "core" || reference.role === "postgres") continue;
    if (supportsMcpRecovery && (reference.role === "provider" || reference.role === "mcp-app"))
      continue;
    issues.push(
      `${reference.relative} requires newly issued signing material that env init does not currently reissue; restore it from a private backup`,
    );
  }
  if (!missing.some((reference) => reference.role === "core")) return issues;
  let surviving: Map<string, string> | null = null;
  for (const [path, assessment] of assessed) {
    if (assessment?.values && classifyEnvironmentReference(basename(path)) === "postgres") {
      surviving = assessment.values;
    }
  }
  if (surviving === null) {
    if (
      ["DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"].some((name) =>
        effectiveValues?.has(name),
      )
    ) {
      issues.push(
        "the selected Compose database credentials override the missing core but cannot be verified without surviving PostgreSQL credentials; restore them from a private backup",
      );
    }
    if (identity) {
      const credentials = {
        user: identity.databaseUser,
        password: "tama-kit-preview-password",
        database: identity.databaseName,
        host: identity.databaseHost,
      };
      issues.push(
        ...databaseUrlIssues(
          new Map([
            ["POSTGRES_USER", credentials.user],
            ["POSTGRES_PASSWORD", credentials.password],
            ["POSTGRES_DB", credentials.database],
            ["DATABASE_URL", serializeDatabaseUrl(credentials)],
          ]),
          identity.databaseHost,
        ),
      );
    }
    return issues;
  }
  const user = surviving.get("POSTGRES_USER") ?? "";
  const password = surviving.get("POSTGRES_PASSWORD") ?? "";
  const database = surviving.get("POSTGRES_DB") ?? "";
  if (!user || !password || !database) {
    issues.push(
      "the surviving PostgreSQL environment is incomplete; restore the missing files from a private backup",
    );
  } else if (![user, password, database].every((value) => SAFE_CORE_VALUE.test(value))) {
    issues.push(
      "the surviving database credentials cannot be re-emitted safely into the core environment; restore the missing files from a private backup",
    );
  } else if (identity) {
    const candidate = new Map(surviving);
    candidate.set(
      "DATABASE_URL",
      serializeDatabaseUrl({
        user,
        password,
        database,
        host: identity.databaseHost,
      }),
    );
    issues.push(...databaseUrlIssues(candidate, identity.databaseHost));
    // Later env files and inline settings remain authoritative after recovery.
    // Validate their credential agreement before preview or any key generation.
    for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"] as const) {
      if (effectiveValues?.has(name) && effectiveValues.get(name) !== surviving.get(name)) {
        issues.push(
          `the selected Compose ${name} disagrees with the surviving PostgreSQL credentials`,
        );
      }
    }
    if (effectiveValues?.has("DATABASE_URL")) {
      candidate.set("DATABASE_URL", effectiveValues.get("DATABASE_URL") ?? "");
      issues.push(
        ...databaseUrlIssues(candidate, identity.databaseHost).map(
          (issue) => `effective Compose environment: ${issue}`,
        ),
      );
    }
  }
  return issues;
}

function renderMissingSet(
  missing: EnvironmentFileReference[],
  assessed: Map<string, Assessment | null>,
  identity: PublicRuntimeIdentity | null,
  mcpContents = new Map<string, string>(),
): { operations: FileOperation[]; sourceDigests: [string, string][] } {
  const coreMissing = missing.some((reference) => reference.role === "core");
  const survivingPath = (role: string): string | null => {
    for (const [path, assessment] of assessed) {
      if (assessment !== null && assessment.values !== null) {
        if (classifyEnvironmentReference(basename(path)) === role) return path;
      }
    }
    return null;
  };
  let coreValues = new Map<string, string>();
  let coreContent: string | null = null;
  if (coreMissing) {
    if (identity === null) {
      throw ownershipError(
        "public runtime identity is incomplete; refusing to generate secrets from bootstrap defaults",
      );
    }
    coreContent = applyPublicIdentity(newEnvironment(identity.port, true), identity);
    coreValues = parseEnvironment(coreContent, "tama/.tama.env");
    const postgresPath = survivingPath("postgres");
    if (postgresPath !== null) {
      const surviving = parseEnvironment(
        readFileSync(postgresPath, "utf8"),
        "tama/.tama.postgres.env",
      );
      const user = surviving.get("POSTGRES_USER") ?? "";
      const password = surviving.get("POSTGRES_PASSWORD") ?? "";
      const database = surviving.get("POSTGRES_DB") ?? "";
      if (!user || !password || !database) {
        throw ownershipError(
          "the surviving PostgreSQL environment is incomplete; restore the missing files from a private backup",
        );
      }
      if (![user, password, database].every((value) => SAFE_CORE_VALUE.test(value))) {
        throw ownershipError(
          "the surviving database credentials cannot be re-emitted safely into the core environment; restore the missing files from a private backup",
        );
      }
      coreContent = coreContent
        .replace(/^POSTGRES_USER=.*/mu, `POSTGRES_USER=${user}`)
        .replace(/^POSTGRES_PASSWORD=.*/mu, `POSTGRES_PASSWORD=${password}`)
        .replace(/^POSTGRES_DB=.*/mu, `POSTGRES_DB=${database}`)
        .replace(
          /^DATABASE_URL=.*/mu,
          `DATABASE_URL=${serializeDatabaseUrl({ user, password, database, host: identity.databaseHost })}`,
        );
      coreValues = parseEnvironment(coreContent, "tama/.tama.env");
    }
    const integration = missing.find((reference) => reference.role === "core");
    const extra = integration ? mcpContents.get(integration.path) : undefined;
    if (extra) {
      coreContent = `${coreContent.trimEnd()}\n\n${extra}`;
      coreValues = parseEnvironment(coreContent, "recovered core environment");
    }
    const semantic = coreSemanticIssues(coreValues, identity);
    if (semantic.issues.length > 0) {
      throw ownershipError(
        `the recovered core environment is invalid: ${semantic.issues.join("; ")}`,
      );
    }
  }
  if (missing.some((reference) => reference.role === "postgres") && !coreMissing) {
    const corePath = survivingPath("core");
    if (corePath === null) {
      throw ownershipError(
        "no surviving core environment can derive the PostgreSQL companion file",
      );
    }
    coreValues = parseEnvironment(readFileSync(corePath, "utf8"), "tama/.tama.env");
  }
  const operations: FileOperation[] = [];
  for (const reference of missing) {
    if (
      reference.role !== "core" &&
      reference.role !== "postgres" &&
      !mcpContents.has(reference.path)
    ) {
      throw ownershipError(
        `${reference.relative} requires newly issued signing material that env init does not currently reissue; restore it from a private backup`,
      );
    }
    const content =
      reference.role === "core"
        ? (coreContent ?? "")
        : reference.role === "postgres"
          ? postgresEnvironment(coreValues, reference.relative)
          : (mcpContents.get(reference.path) ?? "");
    operations.push({
      action: "create",
      path: reference.path,
      content,
      owner: "tama-kit",
      sensitive: true,
      mode: 0o600,
      beforeDigest: null,
      afterDigest: contentDigest(content),
      reason: "environment recovery create",
    });
  }
  const sourceDigests: [string, string][] = [];
  for (const [path, assessment] of assessed) {
    if (assessment === null) continue;
    if (missing.some((reference) => reference.path === path)) continue;
    const role = classifyEnvironmentReference(basename(path));
    if (role === "core" || role === "postgres") {
      sourceDigests.push([path, contentDigest(readFileSync(path, "utf8"))]);
    }
  }
  return { operations, sourceDigests };
}
function recordedSelection(
  options: EnvironmentCommandSelection,
): EnvironmentDoctorResult["selection"] {
  return {
    ...(options.targetPath !== undefined ? { targetPath: options.targetPath } : {}),
    composeFiles: options.composeFiles ?? [],
    ...(options.service !== undefined ? { service: options.service } : {}),
    ...(options.environmentFile !== undefined ? { envFile: options.environmentFile } : {}),
    ...(options.contractPath !== undefined ? { contract: options.contractPath } : {}),
    ...(options.providerService !== undefined ? { providerService: options.providerService } : {}),
  };
}

function validateEnvironmentSelectors(
  inspection: ComposeDeclarationInspection,
  options: EnvironmentCommandSelection,
) {
  if (options.service !== undefined && !inspection.services[options.service]) {
    throw usageError("selected --service does not exist in the effective Compose configuration");
  }
  if (options.providerService !== undefined && !inspection.services[options.providerService]) {
    throw usageError(
      "selected --provider-service does not exist in the effective Compose configuration",
    );
  }
  if (options.environmentFile === undefined) return;
  const selected = resolve(inspection.root, options.environmentFile);
  const matches = inspection.envReferences.filter(
    (reference) => !reference.interpolated && reference.path === selected,
  );
  const loaded =
    options.service === undefined
      ? matches.length > 0
      : matches.some((reference) => reference.services.includes(options.service ?? ""));
  if (!loaded) throw ownershipError("--env-file is not loaded by the selected Tama service");
}

function tamaServiceName(
  inspection: ComposeDeclarationInspection,
  options: EnvironmentCommandSelection,
  references: EnvironmentFileReference[],
): string | undefined {
  if (options.service !== undefined && inspection.services[options.service]) return options.service;
  const loaders = [
    ...new Set(
      references
        .filter((reference) => reference.role === "core")
        .flatMap((reference) => reference.services),
    ),
  ];
  return loaders.length === 1 ? loaders[0] : undefined;
}

function publicIdentityFor(
  root: string,
  inspection: ComposeDeclarationInspection,
  options: EnvironmentCommandSelection,
  references: EnvironmentFileReference[],
  dependencies: Dependencies,
  runtimeOverrides?: Map<string, string>,
): {
  identity: PublicRuntimeIdentity | null;
  issues: string[];
  effectiveDatabaseHost: string | null;
  effectiveValues: Map<string, string> | null;
  sourceDigests: [string, string][];
} {
  const core = references.find((reference) => reference.role === "core");
  const examplePath = core ? `${core.path}.example` : join(root, "tama/.tama.env.example");
  let exampleValues: Map<string, string> | null = null;
  const sourceDigests: [string, string][] = [];
  if (inspectRegularFile(examplePath)) {
    try {
      const content = readFileSync(examplePath, "utf8");
      exampleValues = parseEnvironment(content, examplePath);
      for (const [name, value] of runtimeOverrides ?? []) exampleValues.set(name, value);
      sourceDigests.push([examplePath, contentDigest(content)]);
    } catch {
      exampleValues = null;
    }
  }
  const serviceName = tamaServiceName(inspection, options, references);
  const postgresServices = [
    ...new Set(
      references
        .filter((reference) => reference.role === "postgres")
        .flatMap((reference) => reference.services),
    ),
  ];
  const inline = literalServiceEnvironment(
    serviceName ? inspection.services[serviceName]?.environment : undefined,
  );
  if (inline.unresolved.length > 0) {
    return {
      identity: null,
      issues: inline.unresolved.map(
        (name) => `the selected Compose ${name} contains unresolved interpolation`,
      ),
      effectiveDatabaseHost: inline.unresolved.includes("DATABASE_URL") ? "unresolved" : null,
      effectiveValues: null,
      sourceDigests,
    };
  }
  if (!serviceName)
    return {
      identity: null,
      issues: ["the selected Tama service is ambiguous"],
      effectiveDatabaseHost: "unresolved",
      effectiveValues: null,
      sourceDigests,
    };
  let effective: ReturnType<typeof loadComposeServiceEnvironment>;
  try {
    effective = loadComposeServiceEnvironment(
      inspection,
      serviceName,
      {
        missingPaths: references
          .filter(
            (reference) =>
              ["core", "mcp-app"].includes(reference.role) &&
              lstatSyncSafe(reference.path) === null,
          )
          .map((reference) => reference.path),
        suppliedVariables: CORE_REQUIRED_VARIABLES,
        suppliedVariablesByPath: new Map(
          references.map((reference) => [
            reference.path,
            reference.role === "core" ? CORE_REQUIRED_VARIABLES : [],
          ]),
        ),
        publicValuesByPath: runtimeOverrides?.size
          ? new Map(
              references
                .filter((reference) => reference.role === "mcp-app")
                .map((reference) => {
                  const values = new Map(runtimeOverrides);
                  const examplePath = `${reference.path}.example`;
                  const port = inspectRegularFile(examplePath)
                    ? parseEnvironment(readFileSync(examplePath, "utf8"), examplePath).get(
                        "TAMA_PORT",
                      )
                    : exampleValues?.get("PORT");
                  if (port) values.set("TAMA_PORT", port);
                  return [reference.path, values];
                }),
            )
          : undefined,
      },
      dependencies.execute,
    );
  } catch (error) {
    return {
      identity: null,
      issues: [
        error instanceof Error
          ? error.message
          : "the effective Compose environment could not be established",
      ],
      effectiveDatabaseHost: "unresolved",
      effectiveValues: null,
      sourceDigests,
    };
  }
  sourceDigests.push(...effective.sourceDigests);
  if (effective.unresolved.length > 0)
    return {
      identity: null,
      issues: effective.unresolved.map(
        (name) =>
          `the selected Compose ${name} depends on missing core variables; restore the private environment before recovery`,
      ),
      effectiveDatabaseHost: "unresolved",
      effectiveValues: effective.values,
      sourceDigests,
    };
  if (runtimeOverrides?.size && references.some((reference) => reference.role === "mcp-app")) {
    const port = effective.values.get("TAMA_PORT");
    if (port) exampleValues?.set("TAMA_PORT", port);
  }
  return {
    ...resolvePublicIdentity({
      exampleValues,
      inlineValues: effective.values,
      publicOrigin: runtimeOverrides?.get("TAMA_BASE_URL"),
      publishedPort: serviceName
        ? publishedHostPort(inspection.services[serviceName]?.ports, DEFAULTS.containerPort)
        : null,
      databaseService: postgresServices.length === 1 ? postgresServices[0] : null,
      containerPort: DEFAULTS.containerPort,
    }),
    effectiveValues: effective.values,
    sourceDigests,
  };
}

function literalServiceEnvironment(environment: Record<string, string | null> | undefined): {
  values: Map<string, string>;
  unresolved: string[];
} {
  const values = new Map<string, string>();
  const unresolved: string[] = [];
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (typeof value !== "string") continue;
    if (value.includes("$")) unresolved.push(name);
    else values.set(name, value);
  }
  return { values, unresolved };
}

function generationHistory(root: string): {
  blocker: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  let blocker: string | null = null;
  for (const relativePath of GENERATION_RECEIPTS) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    try {
      const evidence = readGenerationEvidence(path);
      if (
        blocker === null &&
        evidence.kind === "receipt" &&
        evidence.receipt.progress.status === "incomplete"
      ) {
        blocker = `${relativePath} records an incomplete generation; resume it with tama-kit bootstrap --resume <operation-id> before env init issues environment files`;
      }
    } catch {
      warnings.push(
        `${relativePath} could not be read; remaining generation history was still inspected`,
      );
    }
  }
  return { blocker, warnings };
}

const DETECTED_ISSUANCE_BLOCKER =
  "local runtime data was detected, so new secret issuance is refused: changed PostgreSQL credentials would stop the application from connecting, a new TAMA_VAULT_KEY would make stored encrypted material unreadable, and new JWT or System OAuth keys would invalidate stored credentials and issued tokens. Restore the missing files from a private backup, or use a separately authorized runtime-reset process";
const UNKNOWN_ISSUANCE_BLOCKER =
  "persistence could not be verified; pass --fresh only when the local runtime is known to be new, and restore from a private backup otherwise";

/** Both sides can retain tokens or encrypted configuration that depends on lost keys. */
function observeMcpPersistence(
  root: string,
  model: ReturnType<typeof loadComposeModel>,
  tama: ReturnType<typeof associateTamaDatabase>,
  recovery: McpAppRecovery,
  inspection: ComposeDeclarationInspection,
  execute?: ComposeExecute,
): PersistenceObservation {
  const observations: PersistenceObservation[] = [
    tama.kind === "local"
      ? inspectPersistence({ root, project: model.name, sources: tama.sources, execute })
      : { status: "unknown", detail: tama.detail, checked: [] },
  ];
  if (!recovery.providerService)
    observations.push({
      status: "unknown",
      detail: "host-provider persistence is not observable through the selected Compose project",
      checked: [],
    });
  else {
    const provider = recovery.providerService;
    const environment = loadComposeServiceEnvironment(
      inspection,
      provider,
      {
        missingPaths: [recovery.providerPath].filter((path) => !inspectRegularFile(path)),
        suppliedVariables: Object.values(recovery.contract.bindings),
      },
      execute,
    );
    let databaseHost: string | undefined;
    if (environment.values.has("DATABASE_URL")) {
      try {
        const url = new URL(environment.values.get("DATABASE_URL") ?? "");
        databaseHost = ["ecto:", "postgres:", "postgresql:"].includes(url.protocol)
          ? url.hostname
          : "unobservable";
      } catch {
        databaseHost = "unobservable";
      }
    }
    const localDependencies = Object.keys(model.services[provider]?.depends_on ?? {}).filter(
      (name) => postgresDataSources(model, name, model.services[name]) !== null,
    );
    const association =
      databaseHost || localDependencies.length
        ? associateTamaDatabase({
            model,
            tamaService: provider,
            postgresServices: [],
            ...(databaseHost ? { databaseHost } : {}),
          })
        : { kind: "none" as const, detail: "provider database is not declared" };
    if (association.kind === "ambiguous")
      throw ownershipError(
        "the provider database is ambiguous; repair its current Compose dependencies or DATABASE_URL before issuing keys",
      );
    observations.push(
      association.kind === "local"
        ? inspectPersistence({ root, project: model.name, sources: association.sources, execute })
        : {
            status: "unknown",
            detail:
              "the provider database is external or cannot be associated with a local data service",
            checked: [],
          },
    );
    for (const name of localDependencies) {
      if (association.kind === "local" && association.sources.service === name) continue;
      const sources = postgresDataSources(model, name, model.services[name]);
      if (sources)
        observations.push(inspectPersistence({ root, project: model.name, sources, execute }));
    }
    // Direct data mounts and stopped/running provider containers remain positive
    // evidence even when its database connection cannot be inspected.
    observations.push(
      inspectPersistence({
        root,
        project: model.name,
        sources: providerDataSources(model, provider) ?? {
          service: provider,
          volumes: [],
          binds: [],
        },
        execute,
      }),
    );
  }
  return {
    status: observations.some((observation) => observation.status === "detected")
      ? "detected"
      : observations.some((observation) => observation.status === "unknown")
        ? "unknown"
        : "absent",
    detail: observations.map((observation) => observation.detail).join("; "),
    checked: [...new Set(observations.flatMap((observation) => observation.checked))],
  };
}

function authorizeIssuance(
  observation: {
    status: "absent" | "detected" | "unknown";
    detail: string;
    checked: string[];
  },
  fresh: boolean,
): { persistence: EnvironmentInitResult["persistence"]; blocker?: string } {
  const base = {
    detail: observation.detail,
    checked: observation.checked,
    freshAsserted: false,
  };
  if (observation.status === "detected") {
    return {
      persistence: { ...base, status: "detected" },
      blocker: DETECTED_ISSUANCE_BLOCKER,
    };
  }
  if (observation.status === "unknown") {
    if (!fresh) {
      return {
        persistence: { ...base, status: "unknown" },
        blocker: UNKNOWN_ISSUANCE_BLOCKER,
      };
    }
    return { persistence: { ...base, status: "unknown", freshAsserted: true } };
  }
  return { persistence: { ...base, status: "absent" } };
}

function applyPublicIdentity(content: string, identity: PublicRuntimeIdentity): string {
  const password = content.match(/^POSTGRES_PASSWORD=(.*)$/mu)?.[1] ?? "";
  const user = identity.databaseUser;
  const database = identity.databaseName;
  return content
    .replace(/^POSTGRES_USER=.*/mu, `POSTGRES_USER=${user}`)
    .replace(/^POSTGRES_DB=.*/mu, `POSTGRES_DB=${database}`)
    .replace(
      /^DATABASE_URL=.*/mu,
      `DATABASE_URL=${serializeDatabaseUrl({ user, password, database, host: identity.databaseHost })}`,
    )
    .replace(/^PHX_HOST=.*/mu, `PHX_HOST=${identity.phxHost}`)
    .replace(/^TAMA_PORT=.*/mu, `TAMA_PORT=${identity.port}`)
    .replace(/^TAMA_OAUTH_ISSUER=.*/mu, `TAMA_OAUTH_ISSUER=${identity.issuer}`)
    .replace(/^TAMA_MCP_RESOURCE=.*/mu, `TAMA_MCP_RESOURCE=${identity.resource}`)
    .replace(/^TAMA_MCP_ALLOWED_ORIGINS=.*/mu, `TAMA_MCP_ALLOWED_ORIGINS=${identity.allowedOrigin}`)
    .replace(/^TAMA_BASE_URL=.*/mu, `TAMA_BASE_URL=${identity.baseUrl}`);
}

function lstatSyncSafe(path: string): import("node:fs").Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function exampleFor(role: EnvironmentFileReference["role"]) {
  switch (role) {
    case "core":
      return "tama/.tama.env.example";
    case "provider":
      return "the provider fragment's .example counterpart";
    default:
      return "the project's public examples";
  }
}
