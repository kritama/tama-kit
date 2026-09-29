/**
 * Typed contracts for private environment inspection and recovery.
 *
 * These types describe observations of the current project configuration only.
 * Nothing here is desired configuration, a receipt, or a generation inventory.
 */

import { shellQuote } from "../bootstrap/compose-command.mjs";
import { isValidVaultKey } from "../shared/environment.mjs";
import { validateOAuthPrivateJwk } from "../shared/oauth-key.mjs";

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
    targetPath?: string;
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
  /** Malformed optional history that did not hide another receipt. */
  warnings: string[];
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

const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/u;

/** Quote a command argument when it is not a single safe shell token. */
function commandArgument(value: string): string {
  return SAFE_COMMAND_TOKEN.test(value) ? value : shellQuote(value);
}

/** Render `tama-kit env <command>` with the caller's exact selection. */
export function environmentCommand(command: string, selection: EnvironmentSelection): string {
  const parts = command === "setup" ? ["tama-kit setup"] : [`tama-kit env ${command}`];
  if (selection.targetPath !== undefined) parts.push(commandArgument(selection.targetPath));
  for (const compose of selection.compose ?? []) parts.push("--compose", commandArgument(compose));
  if (selection.service !== undefined) parts.push("--service", commandArgument(selection.service));
  if (selection.envFile !== undefined) parts.push("--env-file", commandArgument(selection.envFile));
  if (selection.contract !== undefined)
    parts.push("--contract", commandArgument(selection.contract));
  if (selection.providerService !== undefined)
    parts.push("--provider-service", commandArgument(selection.providerService));
  return parts.join(" ");
}

/** Variables a core runtime file must define. Provisioner credentials may be empty. */
export const CORE_REQUIRED_VARIABLES = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "DATABASE_URL",
  "PHX_HOST",
  "PORT",
  "TAMA_PORT",
  "SECRET_KEY_BASE",
  "TAMA_VAULT_KEY",
  "TAMA_JWT_SECRET",
  "TAMA_OAUTH_PRIVATE_JWK",
  "TAMA_OAUTH_PRIVATE_JWK_ID",
  "TAMA_SETUP_TOKEN",
  "TAMA_DISABLE_CLUSTERING",
  "TAMA_OAUTH_ISSUER",
  "TAMA_MCP_RESOURCE",
  "TAMA_MCP_ALLOWED_ORIGINS",
  "TAMA_BASE_URL",
] as const;

/** Public identity recovery must preserve. Never contains secret values. */
export type PublicRuntimeIdentity = {
  port: number;
  phxHost: string;
  databaseHost: string;
  databaseUser: string;
  databaseName: string;
  containerPort: number;
  issuer: string;
  baseUrl: string;
  resource: string;
  allowedOrigin: string;
};

function tcpPort(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65_535 ? port : null;
}

function databaseHostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "ecto:" && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

function databasePathOf(value: string | undefined): { user: string; name: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    const user = decodeURIComponent(url.username);
    return user && name ? { user, name } : null;
  } catch {
    return null;
  }
}

const SAFE_PUBLIC_TOKEN = /^[A-Za-z0-9._~-]+$/u;

/**
 * Derive the public runtime identity from the project example and the
 * effective Compose publication. Conflicts and missing inputs are reported;
 * bootstrap defaults are never substituted.
 */
export function resolvePublicIdentity(input: {
  exampleValues: Map<string, string> | null;
  /** Literal inline environment from the selected Tama service. It overrides the example. */
  inlineValues?: Map<string, string> | null;
  publishedPort: number | null;
  databaseService: string | null;
  containerPort: number;
}): {
  identity: PublicRuntimeIdentity | null;
  issues: string[];
  effectiveDatabaseHost: string | null;
} {
  const issues: string[] = [];
  const example = input.exampleValues;
  const inline = input.inlineValues ?? new Map<string, string>();
  if (example === null) {
    issues.push(
      "the project example is missing or unreadable, so public port, origin, and database host cannot be preserved",
    );
    return {
      identity: null,
      issues,
      effectiveDatabaseHost: databaseHostOf(inline.get("DATABASE_URL")),
    };
  }
  const examplePort = tcpPort(example.get("TAMA_PORT"));
  const inlinePort = tcpPort(inline.get("TAMA_PORT"));
  if (example.get("TAMA_PORT") !== undefined && examplePort === null) {
    issues.push("the project example has an invalid TAMA_PORT");
  }
  if (inline.get("TAMA_PORT") !== undefined && inlinePort === null) {
    issues.push("the selected Compose configuration has an invalid TAMA_PORT");
  }
  if (inlinePort !== null && examplePort !== null && inlinePort !== examplePort) {
    issues.push("the selected Compose TAMA_PORT does not match the project example");
  }
  if (examplePort !== null && input.publishedPort !== null && examplePort !== input.publishedPort) {
    issues.push("the project example TAMA_PORT does not match the published Compose port");
  }
  if (inlinePort !== null && input.publishedPort !== null && inlinePort !== input.publishedPort) {
    issues.push("the selected Compose TAMA_PORT does not match the published Compose port");
  }
  const port = inlinePort ?? examplePort ?? input.publishedPort;
  if (port === null)
    issues.push("the public port is not declared by the project example or Compose");
  const exampleHostName = example.get("PHX_HOST") ?? "";
  const inlineHostName = inline.get("PHX_HOST");
  if (inlineHostName !== undefined && inlineHostName !== exampleHostName) {
    issues.push("the selected Compose PHX_HOST does not match the project example");
  }
  const phxHost = inlineHostName || exampleHostName;
  if (!SAFE_PUBLIC_TOKEN.test(phxHost))
    issues.push("the project example PHX_HOST is missing or unsafe to preserve");
  const exampleHost = databaseHostOf(example.get("DATABASE_URL"));
  const inlineHost = databaseHostOf(inline.get("DATABASE_URL"));
  if (example.get("DATABASE_URL") && exampleHost === null) {
    issues.push("the project example DATABASE_URL does not name a database host");
  }
  if (inline.get("DATABASE_URL") && inlineHost === null) {
    issues.push("the selected Compose DATABASE_URL does not name a database host");
  }
  if (inlineHost !== null && exampleHost !== null && inlineHost !== exampleHost) {
    issues.push("the selected Compose DATABASE_URL host does not match the project example");
  }
  if (
    exampleHost !== null &&
    inlineHost === null &&
    input.databaseService !== null &&
    exampleHost !== input.databaseService
  ) {
    issues.push(
      "the project example DATABASE_URL host does not match the associated Compose database service",
    );
  }
  const databaseHost = inlineHost ?? exampleHost ?? input.databaseService;
  if (databaseHost === null) {
    issues.push("the current database host is not declared by the project example or Compose");
  } else if (!SAFE_PUBLIC_TOKEN.test(databaseHost)) {
    issues.push("the current database host is unsafe to preserve");
  }
  const databasePath = databasePathOf(example.get("DATABASE_URL"));
  const databaseUser = example.get("POSTGRES_USER") || databasePath?.user || "";
  const databaseName = example.get("POSTGRES_DB") || databasePath?.name || "";
  if (!SAFE_PUBLIC_TOKEN.test(databaseUser) || databaseUser === "replace-me") {
    issues.push("the project example does not declare a preservable POSTGRES_USER");
  }
  if (!SAFE_PUBLIC_TOKEN.test(databaseName) || databaseName === "replace-me") {
    issues.push("the project example does not declare a preservable POSTGRES_DB");
  }
  const origin = phxHost && port !== null ? `http://${phxHost}:${port}` : "";
  const issuer = inline.get("TAMA_OAUTH_ISSUER") || example.get("TAMA_OAUTH_ISSUER") || "";
  const baseUrl = inline.get("TAMA_BASE_URL") || example.get("TAMA_BASE_URL") || "";
  const resource = inline.get("TAMA_MCP_RESOURCE") || example.get("TAMA_MCP_RESOURCE") || "";
  const allowedOrigin =
    inline.get("TAMA_MCP_ALLOWED_ORIGINS") || example.get("TAMA_MCP_ALLOWED_ORIGINS") || "";
  for (const name of [
    "TAMA_OAUTH_ISSUER",
    "TAMA_BASE_URL",
    "TAMA_MCP_RESOURCE",
    "TAMA_MCP_ALLOWED_ORIGINS",
  ] as const) {
    const inlineValue = inline.get(name);
    const exampleValue = example.get(name);
    if (
      inlineValue !== undefined &&
      exampleValue !== undefined &&
      !samePublicValue(name, inlineValue, exampleValue)
    ) {
      issues.push(`the selected Compose ${name} does not match the project example`);
    }
  }
  if (origin && issuer && issuer !== origin) {
    issues.push("the project example TAMA_OAUTH_ISSUER does not match its PHX_HOST and TAMA_PORT");
  }
  if (origin && baseUrl && baseUrl !== origin) {
    issues.push("the project example TAMA_BASE_URL does not match its PHX_HOST and TAMA_PORT");
  }
  if (origin && resource && resource !== `${origin}/mcp`) {
    issues.push("the project example TAMA_MCP_RESOURCE does not match its public origin");
  }
  if (!issuer || !baseUrl || !resource || !allowedOrigin) {
    issues.push("the project example is missing public origin settings");
  }
  if (issues.length > 0 || port === null || !databaseHost) {
    return { identity: null, issues, effectiveDatabaseHost: databaseHost };
  }
  return {
    identity: {
      port,
      phxHost,
      databaseHost,
      databaseUser,
      databaseName,
      containerPort: input.containerPort,
      issuer: issuer || origin,
      baseUrl: baseUrl || origin,
      resource: resource || `${origin}/mcp`,
      allowedOrigin: allowedOrigin || origin,
    },
    issues,
    effectiveDatabaseHost: databaseHost,
  };
}

function samePublicValue(name: string, left: string, right: string): boolean {
  if (name === "TAMA_MCP_ALLOWED_ORIGINS") return sameOriginList(left, right);
  return left === right;
}

function originList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .sort();
}

function sameOriginList(left: string | undefined, right: string | undefined): boolean {
  const a = originList(left);
  const b = originList(right);
  return a.length === b.length && a.every((origin, index) => origin === b[index]);
}

/**
 * Semantic core-file checks. Messages name variables only; values never appear.
 * Expected empty provisioner credentials are not failures.
 */
export function coreSemanticIssues(
  values: Map<string, string>,
  identity: PublicRuntimeIdentity | null,
): { issues: string[]; publicConflict: boolean } {
  const issues: string[] = [];
  const missing = CORE_REQUIRED_VARIABLES.filter((name) => !(values.get(name) ?? ""));
  if (missing.length > 0) {
    issues.push(`missing required variables: ${missing.join(", ")}`);
  }
  if (!values.get("TAMA_OAUTH_PRIVATE_JWK") || !values.get("TAMA_OAUTH_PRIVATE_JWK_ID")) {
    if (!issues.some((issue) => issue.startsWith("missing required variables"))) {
      issues.push("TAMA_OAUTH_PRIVATE_JWK and TAMA_OAUTH_PRIVATE_JWK_ID are required together");
    }
  } else {
    try {
      validateOAuthPrivateJwk(
        values.get("TAMA_OAUTH_PRIVATE_JWK") ?? "",
        values.get("TAMA_OAUTH_PRIVATE_JWK_ID") ?? "",
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "TAMA_OAUTH_PRIVATE_JWK is invalid");
    }
  }
  const invalidSecrets = [];
  if (
    (values.get("SECRET_KEY_BASE") ?? "") &&
    Buffer.byteLength(values.get("SECRET_KEY_BASE") ?? "", "utf8") < 64
  ) {
    invalidSecrets.push("SECRET_KEY_BASE");
  }
  if (
    (values.get("TAMA_VAULT_KEY") ?? "") &&
    !isValidVaultKey(values.get("TAMA_VAULT_KEY") ?? "")
  ) {
    invalidSecrets.push("TAMA_VAULT_KEY");
  }
  if (invalidSecrets.length > 0) {
    issues.push(`runtime secrets have invalid formats: ${invalidSecrets.join(", ")}`);
  }
  const urlIssues = databaseUrlIssues(values, identity?.databaseHost);
  issues.push(...urlIssues);
  if (values.get("PORT") && identity && values.get("PORT") !== String(identity.containerPort)) {
    issues.push(`PORT does not match the container port ${identity.containerPort}`);
  }
  const publicConflict = identity !== null && publicSettingsDisagree(values, identity);
  if (publicConflict) {
    issues.push(
      "public identity does not match the selected Compose configuration and project example",
    );
  }
  if (identity === null) {
    issues.push(
      "public identity could not be established, so this file was not accepted as current",
    );
  }
  return {
    issues,
    publicConflict:
      publicConflict ||
      (identity === null && !issues.some((issue) => issue.startsWith("missing required"))),
  };
}

function databaseUrlIssues(
  values: Map<string, string>,
  databaseHost: string | undefined,
): string[] {
  const raw = values.get("DATABASE_URL");
  if (!raw) return [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ["DATABASE_URL is not a valid URL"];
  }
  const issues: string[] = [];
  if (url.protocol !== "ecto:") issues.push("DATABASE_URL is not an ecto URL");
  if (databaseHost && url.hostname !== databaseHost) {
    issues.push("DATABASE_URL host does not match the current database service");
  }
  const user = values.get("POSTGRES_USER");
  const password = values.get("POSTGRES_PASSWORD");
  const database = values.get("POSTGRES_DB");
  if (user && decodeURIComponent(url.username) !== user) {
    issues.push("DATABASE_URL user does not match POSTGRES_USER");
  }
  if (password && decodeURIComponent(url.password) !== password) {
    issues.push("DATABASE_URL password does not match POSTGRES_PASSWORD");
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (database && name !== database)
    issues.push("DATABASE_URL database does not match POSTGRES_DB");
  return issues;
}

function publicSettingsDisagree(
  values: Map<string, string>,
  identity: PublicRuntimeIdentity,
): boolean {
  const comparisons: [string, string][] = [
    ["TAMA_PORT", String(identity.port)],
    ["PHX_HOST", identity.phxHost],
    ["TAMA_OAUTH_ISSUER", identity.issuer],
    ["TAMA_BASE_URL", identity.baseUrl],
    ["TAMA_MCP_RESOURCE", identity.resource],
  ];
  if (comparisons.some(([name, expected]) => values.get(name) !== expected)) return true;
  return !sameOriginList(values.get("TAMA_MCP_ALLOWED_ORIGINS"), identity.allowedOrigin);
}

/** Published host port for the container's Tama listen port, if declared. */
export function publishedHostPort(
  ports: { target?: number; published?: string | number }[] | undefined,
  containerPort: number,
): number | null {
  for (const port of ports ?? []) {
    if (port.target !== containerPort || port.published === undefined) continue;
    const published = tcpPort(String(port.published));
    if (published !== null) return published;
  }
  return null;
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
