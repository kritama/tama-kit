import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  type ComposeDeclarationInspection,
  type ComposeExecute,
  inspectComposeDeclarations,
  loadComposeModel,
} from "../bootstrap/compose-inspection.mjs";
import { DEFAULTS } from "../bootstrap/constants.mjs";
import {
  newEnvironment,
  PENDING_SECRET_VALUE,
  postgresEnvironment,
} from "../bootstrap/environment.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { validateMcpAppLocalContract } from "../bootstrap/mcp-app-local-contract.mjs";
import { findPostgresDataSources, inspectPersistence } from "../bootstrap/persistence.mjs";
import {
  classifyEnvironmentReference,
  type EnvironmentDoctorResult,
  type EnvironmentFileReference,
  type EnvironmentFileReport,
  type EnvironmentInitFile,
  type EnvironmentInitResult,
  environmentCommand,
  isSupportedRole,
} from "../domain/environment.mjs";
import { ownershipError } from "../errors.mjs";
import { parseEnvironment } from "../shared/environment.mjs";
import { contentDigest, inspectRegularFile } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import { validateOAuthPrivateJwk } from "../shared/oauth-key.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import type { FileOperation } from "../types.mjs";

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

export type EnvironmentDoctorOptions = EnvironmentCommandSelection & { cwd: string };

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
  context: { providerPairs?: [string, string][] } = {},
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
  return { status: issues.length > 0 ? "invalid" : "valid", issues, values };
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
  const references = [
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
  inspectGenerationHistory(root, warnings);
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
        return { ...base, status: "optional-absent", issues: [], variables: null };
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
    });
    parsed.set(reference.role, assessed.values);
    return {
      ...base,
      status: assessed.status,
      issues: assessed.issues,
      variables: assessed.values?.size ?? null,
    };
  });
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
  const requiredFailures = files.filter(
    (file) => file.required && ["missing", "invalid", "unsupported"].includes(file.status),
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
  const ok = requiredFailures.length === 0;
  return {
    schemaVersion: 1,
    ok,
    command: "env",
    subcommand: "doctor",
    mode: "inspect",
    root,
    composeFiles: inspection.composeFiles.map((path) => relative(root, path)),
    selection: {
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
  const root = inspection.root;
  const blockers: string[] = [];
  const contract = await readCurrentContract(root, options);
  const references = environmentReferences(inspection, contract.providerFragment);
  const assessed = new Map<string, Assessment | null>();
  for (const reference of references) {
    assessed.set(
      reference.path,
      lstatSyncSafe(reference.path) === null
        ? null
        : assessExistingFile(root, reference, {
            providerPairs: reference.role === "provider" ? contract.providerPairs : undefined,
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
  if (contract.valid && missing.some((reference) => reference.role !== "postgres")) {
    blockers.push(
      "the selected MCP App configuration requires reissued provider and introspection signing material; env init currently recovers the standard runtime only, so restore the missing MCP App files from a private backup or re-provision the integration with tama-kit generate mcp-app",
    );
  }

  const issuance = missingCore ? "new" : missing.length > 0 ? "derived" : "none";
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
    const dataSources = findPostgresDataSources(model, model.services);
    if (dataSources === null) {
      persistence = {
        status: "unknown",
        freshAsserted: false,
        detail:
          "the selected configuration has no local PostgreSQL data mount; the database may be external and was not inspected",
        checked: [],
      };
    } else {
      const observe = () =>
        inspectPersistence({
          root,
          project: model.name,
          sources: dataSources,
          execute: dependencies.execute,
        });
      recheckPersistence = () => {
        const observation = observe();
        return { status: observation.status, detail: observation.detail };
      };
      const observation = observe();
      persistence = {
        status: observation.status,
        freshAsserted: false,
        detail: observation.detail,
        checked: observation.checked,
      };
      if (persistence.status === "detected") {
        blockers.push(
          "local runtime data was detected, so new secret issuance is refused: changed PostgreSQL credentials would stop the application from connecting, a new TAMA_VAULT_KEY would make stored encrypted material unreadable, and new JWT or System OAuth keys would invalidate stored credentials and issued tokens. Restore the missing files from a private backup, or use a separately authorized runtime-reset process",
        );
      } else if (persistence.status === "unknown" && !options.fresh) {
        blockers.push(
          "persistence could not be verified; pass --fresh only when the local runtime is known to be new, and restore from a private backup otherwise",
        );
      }
      if (persistence.status === "unknown" && options.fresh) {
        persistence = { ...persistence, freshAsserted: true };
      }
    }
  }

  let operations: FileOperation[] = [];
  let applied = false;
  if (missing.length > 0 && blockers.length === 0 && !options.dryRun) {
    const plan = renderMissingSet(references, assessed);
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
      for (const [path, digest] of plan.sourceDigests) {
        if (contentDigest(readFileSync(path, "utf8")) !== digest) {
          throw ownershipError("a surviving environment file changed during the operation", {
            path,
          });
        }
      }
      if (recheckPersistence !== undefined) {
        const recheck = recheckPersistence();
        if (recheck.status === "detected") {
          throw ownershipError(`persistence appeared during the operation: ${recheck.detail}`);
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
      issuance: planned ? (missingCore ? "new" : "derived") : "none",
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
  }
  return {
    schemaVersion: 1,
    ok: blockers.length === 0,
    command: "env",
    subcommand: "init",
    mode: options.dryRun ? "dry-run" : "write",
    root,
    composeFiles: inspection.composeFiles.map((path) => relative(root, path)),
    selection: selectionFromOptions(options),
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
    nextActions,
  };
}

/** @param {EnvironmentCommandSelection} options */
function selectionFromOptions(options: EnvironmentCommandSelection) {
  return {
    composeFiles: options.composeFiles ?? [],
    ...(options.service !== undefined ? { service: options.service } : {}),
    ...(options.environmentFile !== undefined ? { envFile: options.environmentFile } : {}),
    ...(options.contractPath !== undefined ? { contract: options.contractPath } : {}),
    ...(options.providerService !== undefined ? { providerService: options.providerService } : {}),
  };
}

type ContractContext = {
  valid: boolean;
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
  if (!inspectRegularFile(contractPath)) return { valid: false, providerPairs: [] };
  try {
    const contract = validateMcpAppLocalContract(
      JSON.parse(readFileSync(contractPath, "utf8")) as unknown,
      { currentConfiguration: true },
    );
    return {
      valid: true,
      providerFragment: resolve(root, contract.provider.environment_file),
      providerPairs: [
        [
          contract.bindings.access_token_private_signing_key,
          contract.bindings.access_token_signing_key_id,
        ],
      ],
    };
  } catch {
    return { valid: false, providerPairs: [] };
  }
}

function environmentReferences(
  inspection: ComposeDeclarationInspection,
  providerFragment: string | undefined,
): EnvironmentFileReference[] {
  const root = inspection.root;
  return [
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
}

/** Credential characters the bootstrap core renderer emits unquoted. */
const SAFE_CORE_VALUE = /^[A-Za-z0-9+/_-]+$/u;

function renderMissingSet(
  references: EnvironmentFileReference[],
  assessed: Map<string, Assessment | null>,
): { operations: FileOperation[]; sourceDigests: [string, string][] } {
  const missing = references.filter((reference) => assessed.get(reference.path) === null);
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
    coreContent = newEnvironment(DEFAULTS.port, true);
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
          `DATABASE_URL=ecto://${user}:${password}@tama-postgres/${database}`,
        );
      coreValues = parseEnvironment(coreContent, "tama/.tama.env");
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
    if (reference.role !== "core" && reference.role !== "postgres") {
      throw ownershipError(
        `${reference.relative} requires newly issued signing material that env init does not currently reissue; restore it from a private backup`,
      );
    }
    const content =
      reference.role === "core"
        ? (coreContent ?? "")
        : postgresEnvironment(coreValues, reference.relative);
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
