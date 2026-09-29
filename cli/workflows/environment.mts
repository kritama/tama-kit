import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  type ComposeExecute,
  inspectComposeDeclarations,
} from "../bootstrap/compose-inspection.mjs";
import { PENDING_SECRET_VALUE } from "../bootstrap/environment.mjs";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { validateMcpAppLocalContract } from "../bootstrap/mcp-app-local-contract.mjs";
import {
  classifyEnvironmentReference,
  type EnvironmentDoctorResult,
  type EnvironmentFileReference,
  type EnvironmentFileReport,
  isSupportedRole,
} from "../domain/environment.mjs";
import { parseEnvironment } from "../shared/environment.mjs";
import { inspectRegularFile } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import { validateOAuthPrivateJwk } from "../shared/oauth-key.mjs";

/**
 * Read-only private environment inspection.
 *
 * The doctor is independent of runtime readiness: it diagnoses the files the
 * current configuration declares, never starts services, and never compares
 * secrets against examples or receipt hashes. Optional files and pending
 * manual provisioner setup never make a valid environment fail.
 */

export type EnvironmentDoctorOptions = {
  cwd: string;
  targetPath?: string;
  composeFiles?: string[];
  service?: string;
  environmentFile?: string;
  contractPath?: string;
  providerService?: string;
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
