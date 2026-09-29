/**
 * Typed contracts for private environment inspection and recovery.
 *
 * These types describe observations of the current project configuration only.
 * Nothing here is desired configuration, a receipt, or a generation inventory.
 */

/** Roles the current recovery workflows understand. */
export type EnvironmentFileRole = "core" | "postgres" | "mcp-app" | "provider" | "application";

/** A normalized required/optional private environment destination. */
export type EnvironmentFileReference = {
  role: EnvironmentFileRole;
  /** Resolved absolute destination. */
  path: string;
  /** Display path relative to the project root. */
  relative: string;
  /** Services declaring the destination, in composition order. */
  services: string[];
  required: boolean;
  source: "compose" | "contract";
};

export type EnvironmentFileStatus =
  | "valid"
  | "missing"
  | "invalid"
  | "public-configuration-conflict"
  | "optional-absent"
  | "unsupported";

/** One discovered environment destination and its read-only assessment. */
export type EnvironmentFileReport = {
  role: EnvironmentFileRole;
  relative: string;
  services: string[];
  required: boolean;
  source: "compose" | "contract";
  status: EnvironmentFileStatus;
  /** Sanitized findings: filenames, variable names and facts; never values. */
  issues: string[];
  /** Number of dotenv assignments, present only for readable files. */
  variables: number | null;
};

export type EnvironmentDoctorResult = {
  schemaVersion: 1;
  ok: boolean;
  command: "env";
  subcommand: "doctor";
  mode: "inspect";
  root: string;
  composeFiles: string[];
  selection: {
    composeFiles: string[];
    service?: string;
    envFile?: string;
    contract?: string;
    providerService?: string;
  };
  files: EnvironmentFileReport[];
  persistence: { status: "not-checked" };
  changes: [];
  nextActions: string[];
  warnings: string[];
};

/** One planned or applied environment destination during init. */
export type EnvironmentInitFile = {
  role: EnvironmentFileRole;
  relative: string;
  source: "compose" | "contract";
  /** Create-only: existing files are preserved and reported. */
  action: "create" | "preserve";
  /** Where the file's secret material comes from. */
  issuance: "none" | "derived" | "new";
  /** True only after an applied write in this invocation. */
  created: boolean;
};

/** Stable init result schema; never contains file contents or secret values. */
export type EnvironmentInitResult = {
  schemaVersion: 1;
  ok: boolean;
  command: "env";
  subcommand: "init";
  mode: "dry-run" | "write";
  root: string;
  composeFiles: string[];
  selection: EnvironmentDoctorResult["selection"];
  files: EnvironmentInitFile[];
  persistence: {
    status: "not-required" | "absent" | "detected" | "unknown";
    /** True when --fresh asserted an unobservable persistence state. */
    freshAsserted: boolean;
    detail: string;
    checked: string[];
  };
  changes: { action: "create"; relative: string; sensitive: true }[];
  blockers: string[];
  nextActions: string[];
};

/**
 * Classify a destination by name. Only the fixed Tama file set and the
 * fragment named by the current local contract are supported for automatic
 * creation; everything else is application-owned.
 *
 * @param name Basename of the destination.
 * @param providerFragment Basename of the contract provider fragment, if any.
 */
export function classifyEnvironmentReference(
  name: string,
  providerFragment?: string,
): EnvironmentFileRole {
  if (providerFragment !== undefined && name === providerFragment) return "provider";
  switch (name) {
    case ".tama.env":
      return "core";
    case ".tama.postgres.env":
      return "postgres";
    case ".mcp-app.env":
      return "mcp-app";
    default:
      return "application";
  }
}

export function isSupportedRole(role: EnvironmentFileRole): boolean {
  return role !== "application";
}

export type EnvironmentPreflightFinding = {
  /** Missing required destinations this project's workflows can recreate. */
  missing: EnvironmentFileReference[];
  /** Missing required application-owned destinations that need manual restore. */
  missingUnsupported: EnvironmentFileReference[];
  /** Missing `required: false` declarations; informational only. */
  missingOptional: EnvironmentFileReference[];
};

/**
 * @param references Normalized, deduplicated environment destinations.
 * @param exists Whether the destination exists as a safe regular file.
 */
export function environmentPreflight(
  references: EnvironmentFileReference[],
  exists: (path: string) => boolean,
): EnvironmentPreflightFinding {
  const finding: EnvironmentPreflightFinding = {
    missing: [],
    missingUnsupported: [],
    missingOptional: [],
  };
  for (const reference of references) {
    if (exists(reference.path)) continue;
    if (!reference.required) {
      finding.missingOptional.push(reference);
    } else if (isSupportedRole(reference.role)) {
      finding.missing.push(reference);
    } else {
      finding.missingUnsupported.push(reference);
    }
  }
  return finding;
}

/** The project configuration selectors recovery commands must preserve. */
export type EnvironmentSelection = {
  targetPath?: string;
  compose?: string[];
  service?: string;
  envFile?: string;
  contract?: string;
  providerService?: string;
};

/** Render `tama-kit env <command>` with the caller's exact selection. */
export function environmentCommand(command: string, selection: EnvironmentSelection): string {
  const parts = command === "setup" ? ["tama-kit setup"] : [`tama-kit env ${command}`];
  if (selection.targetPath !== undefined) parts.push(selection.targetPath);
  for (const compose of selection.compose ?? []) parts.push("--compose", compose);
  if (selection.service !== undefined) parts.push("--service", selection.service);
  if (selection.envFile !== undefined) parts.push("--env-file", selection.envFile);
  if (selection.contract !== undefined) parts.push("--contract", selection.contract);
  if (selection.providerService !== undefined)
    parts.push("--provider-service", selection.providerService);
  return parts.join(" ");
}

/**
 * Safe preflight diagnostic for setup/doctor: filenames and commands only.
 * Compose stderr and resolved environments never reach the message.
 */
export function missingEnvironmentDiagnosis(
  finding: EnvironmentPreflightFinding,
  selection: EnvironmentSelection,
): {
  message: string;
  details: { missingEnvironmentFiles: string[]; suggestedCommands: string[] };
} {
  const lines = ["Missing required private environment files:"];
  const files: string[] = [];
  for (const reference of [...finding.missing, ...finding.missingUnsupported]) {
    lines.push(`  ${reference.relative}`);
    files.push(reference.relative);
  }
  if (finding.missing.length > 0) {
    lines.push(
      `Run ${environmentCommand("doctor", selection)}, then ${environmentCommand("init", selection)} for a fresh local runtime.`,
    );
    lines.push(
      "Restore the missing files from a private backup when the local runtime is not fresh.",
    );
  }
  for (const reference of finding.missingUnsupported) {
    lines.push(
      `${reference.relative} is not a Tama-owned file; restore it from your project template or provider documentation.`,
    );
  }
  return {
    message: lines.join("\n"),
    details: {
      missingEnvironmentFiles: files,
      suggestedCommands:
        finding.missing.length > 0
          ? [environmentCommand("doctor", selection), environmentCommand("init", selection)]
          : [],
    },
  };
}
