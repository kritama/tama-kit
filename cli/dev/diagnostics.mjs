// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** @typedef {"database"|"mix-setup"|"tool-install"|"foundation"} DevSetupPhase */
/** @typedef {"database-startup-failed"|"mix-setup-failed"|"opentofu-install-failed"|"opentofu-unavailable"|"opentofu-unusable"|"provider-checksum-mismatch"|"lockfile-update-required"|"foundation-failed"} DevSetupReason */

/** Recognized development setup phases; also the allowlist for JSON output. */
export const DEV_SETUP_PHASES = ["database", "mix-setup", "tool-install", "foundation"];

/**
 * Sanitized development setup diagnostic: explicit operation/phase, stable
 * reason, optional evidence-based OpenTofu subphase and provider identity,
 * an optional allowlisted spawn error code, and a static remediation.
 * Never contains raw subprocess output; the provider record, when present,
 * comes only from the checkout's repository-owned dependency lock file,
 * never from captured output.
 * @typedef {{
 *   operation: string,
 *   phase: DevSetupPhase,
 *   subphase?: "tofu-init"|"tofu-apply",
 *   reason: string,
 *   provider?: {source: string, version: string},
 *   spawnFailure?: string,
 *   remediation: string,
 * }} DevSetupDiagnostic
 */

/** Node spawn errnos that are safe to publish as a spawnFailure fact. */
export const SPAWN_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EIO",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "ETXTBSY",
]);

/** @type {Record<DevSetupReason, string>} */
const REMEDIATIONS = Object.freeze({
  "database-startup-failed":
    "Docker Compose could not start the isolated PostgreSQL service. Verify Docker is running and the Tama compose file can start 'postgres', then re-run 'tama-kit dev setup' without --json to see the full Compose output.",
  "mix-setup-failed":
    "Mix setup failed. Re-run 'tama-kit dev setup' without --json to see the full Mix output, and verify the development database is reachable.",
  "opentofu-install-failed":
    "OpenTofu installation through mise failed. Install the OpenTofu version declared in .tool-versions manually or re-run 'mise install opentofu', then re-run 'tama-kit dev setup'.",
  "opentofu-unavailable":
    "OpenTofu is not installed and mise is not available, so the test foundation cannot be provisioned. Install the OpenTofu version declared in .tool-versions, or install mise and re-run 'tama-kit dev setup'.",
  "opentofu-unusable":
    "mise is installed but could not be used to run OpenTofu. Verify the mise installation with 'mise --version', re-run 'mise install opentofu' to repair the toolchain, confirm 'mise exec opentofu -- tofu --version', then re-run 'tama-kit dev setup'.",
  "provider-checksum-mismatch":
    "OpenTofu rejected a provider checksum recorded in the dependency lockfile. From the Tama root, keep the lockfile's selected provider version and refresh only its verified checksums for this platform, for example on macOS arm64: 'tofu -chdir=scripts/setup providers lock -platform=darwin_arm64 registry.opentofu.org/upmaru/tama'. When OpenTofu is available only through mise, prefix both repair and verification commands with 'mise exec opentofu --', for example 'mise exec opentofu -- tofu -chdir=scripts/setup providers lock -platform=darwin_arm64 registry.opentofu.org/upmaru/tama' and 'mise exec opentofu -- tofu -chdir=scripts/setup init -lockfile=readonly'. Review the signature information and the lock diff, re-run 'tofu -chdir=scripts/setup init -lockfile=readonly', then re-run 'tama-kit dev setup'. Do not delete the lockfile, disable checksum verification, or use a writable init.",
  "lockfile-update-required":
    "Test foundation provisioning runs 'tofu init -lockfile=readonly' and cannot update the dependency lockfile. Review the tofu report from the Tama root, deliberately lock the selected provider version for your platform with 'tofu -chdir=scripts/setup providers lock', re-verify with 'tofu -chdir=scripts/setup init -lockfile=readonly', then re-run 'tama-kit dev setup'. When OpenTofu is available only through mise, use 'mise exec opentofu -- tofu -chdir=scripts/setup providers lock' and 'mise exec opentofu -- tofu -chdir=scripts/setup init -lockfile=readonly'. Do not follow tofu's suggestion to re-run a writable init.",
  "foundation-failed":
    "Tama's test foundation setup script failed. Re-run 'tama-kit dev setup' without --json to see the full Mix and OpenTofu output, and verify the development database is running.",
});

const REASON_ALLOWLIST = new Set(Object.keys(REMEDIATIONS));

/** @type {Record<DevSetupPhase, string>} */
const PHASE_OPERATIONS = Object.freeze({
  database: "docker-compose-up",
  "mix-setup": "mix-setup",
  "tool-install": "opentofu-install",
  foundation: "test-foundation-setup",
});

/** @type {Record<"database"|"mix-setup"|"tool-install", string>} */
const PHASE_REASONS = Object.freeze({
  database: "database-startup-failed",
  "mix-setup": "mix-setup-failed",
  "tool-install": "opentofu-install-failed",
});

/** Only provider reasons may carry provider metadata. */
const PROVIDER_REASONS = new Set(["provider-checksum-mismatch", "lockfile-update-required"]);

/**
 * Allowlisted patterns, checked against ANSI-stripped bounded tails. Only
 * normalized facts are projected; arbitrary subprocess text is never echoed.
 *
 * Only fatal lockfile failures can select the lockfile reason: OpenTofu's
 * read-only init error "Error: Provider dependency changes detected ... the
 * lock file is read-only" and the inconsistent-lock-file wording. The
 * nonfatal "Warning: Provider lock file not updated" warning must never
 * explain a failure by itself, whether or not later apply output is
 * present: when init succeeds, any later error has its own cause.
 */
// Generic checksum output from Mix or application logs is insufficient:
// require a provider checksum failure or OpenTofu's cached/local package error.
const CHECKSUM_EVIDENCE =
  /invalid provider checksum|invalid checksum for [^\r\n]{0,256}\bprovider|provider (?:package|plugin)[^\r\n]{0,256}\bchecksum (?:mismatch|verification failed)|provider package (?:does not|doesn't) match (?:any )?(?:of the )?(?:expected )?checksums?|the (?:cached|local) package for [^\r\n]{1,2048} (?:does not|doesn't) match (?:any )?(?:of the )?checksums?/iu;
const LOCK_ERROR_EVIDENCE =
  /provider dependency changes detected|lock file is read-only|inconsistent dependency lock file|not in lock file/iu;
const APPLY_EVIDENCE =
  /tofu apply|terraform apply|openTofu has planned \d+ actions|applying |planned \d+ (?:resource|action)|apply (?:complete|finished)/iu;
const INIT_EVIDENCE =
  /tofu init|terraform init|initializ\w+ (?:the |any )?(?:providers|backend|infrastructure)|initializ\w+ provider plugins|openTofu has been (?:successfully )?initialized|Terraform has been (?:successfully )?initialized/iu;

/** Top-level `provider "<source>"` block header (any registry/source). */
const LOCK_PROVIDER_HEADER = /\bprovider\s+"([^"\n]+)"\s*\{/uy;

/** Every top-level `version` assignment inside a provider block body. */
const LOCK_VERSION_ASSIGNMENT = /^\s*version\s*=\s*(.*)$/gmu;

/** Quoted semver right-hand side; the only accepted version value. */
const LOCK_VERSION_VALUE = /^"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)"$/u;

/** Conservative metadata policy for the emitted provider record. */
const LOCK_SOURCE_POLICY =
  /^registry\.opentofu\.org\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/**
 * Strip hash, double-slash, and C-style block comments while preserving
 * quoted strings and newlines, so comment or string text can never be
 * mistaken for lockfile syntax.
 * @param {string} input
 * @returns {string}
 */
function stripHclComments(input) {
  let out = "";
  /** @type {"code"|"string"|"line"|"block"} */
  let state = "code";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (state === "string") {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[++i];
        continue;
      }
      if (ch === '"') state = "code";
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        out += ch;
        state = "code";
      }
      continue;
    }
    if (state === "block") {
      if (ch === "\n") out += ch;
      if (ch === "*" && input[i + 1] === "/") {
        i += 1;
        state = "code";
      }
      continue;
    }
    if (ch === '"') {
      state = "string";
      out += ch;
      continue;
    }
    if (ch === "#" || (ch === "/" && input[i + 1] === "/")) {
      state = "line";
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      state = "block";
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * @param {string} text comment-stripped lockfile content
 * @param {number} openIndex index of the block's opening brace
 * @returns {number} index of the matching closing brace, or -1 when unbalanced
 */
function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract the selected version from a provider block body, requiring
 * exactly one legitimate top-level `version` assignment. Duplicate, missing,
 * unquoted, or malformed assignments make the record ambiguous; constraints,
 * hashes, comments, strings, and nested blocks can never be read as the
 * version.
 * @param {string} source quoted provider source from the header
 * @param {string} text comment-stripped lockfile content
 * @param {number} open index of the block's opening brace
 * @param {number} close index of the block's closing brace
 * @returns {{source: string, version: string | null}}
 */
function readProviderRecord(source, text, open, close) {
  const body = text.slice(open + 1, close);
  const nested = body.search(/\{/u);
  const topLevel = nested === -1 ? body : body.slice(0, nested);
  const assignments = [...topLevel.matchAll(LOCK_VERSION_ASSIGNMENT)];
  if (assignments.length !== 1) return { source, version: null };
  const value =
    /** @type {string} */ (assignments[0][1]).trim().match(LOCK_VERSION_VALUE)?.[1] ?? null;
  return { source, version: value };
}

/**
 * Parse the single provider record from lockfile content. Every real
 * top-level `provider` block is counted regardless of registry or source;
 * headers inside comments, quoted strings, or non-provider blocks do not
 * count. Metadata is emitted only when exactly one block exists, it has
 * exactly one legitimate top-level quoted version assignment, and its
 * source and version pass the conservative policy. Any missing, unbalanced,
 * ambiguous, or unsupported lockfile fails closed to undefined.
 * @param {string} content
 * @returns {{source: string, version: string} | undefined}
 */
function parseLockedProvider(content) {
  const text = stripHclComments(content);
  const providers = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\" && i + 1 < text.length) i += 2;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    LOCK_PROVIDER_HEADER.lastIndex = i;
    const header = LOCK_PROVIDER_HEADER.exec(text);
    if (header) {
      const open = i + header[0].length - 1;
      const close = findMatchingBrace(text, open);
      if (close === -1) return undefined;
      providers.push(readProviderRecord(/** @type {string} */ (header[1]), text, open, close));
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      const close = findMatchingBrace(text, i);
      if (close === -1) return undefined;
      i = close + 1;
      continue;
    }
    if (ch === "}") return undefined;
    i += 1;
  }
  if (providers.length !== 1) return undefined;
  const only = providers[0];
  if (!only.version || !LOCK_SOURCE_POLICY.test(only.source)) return undefined;
  return { source: only.source, version: only.version };
}

/**
 * Read the single provider record from the checkout's repository-owned
 * dependency lock file. This is the only trusted source for provider
 * metadata; captured subprocess output is untrusted and is never searched
 * for provider addresses or versions.
 * @param {string} root Tama checkout root
 * @returns {{source: string, version: string} | undefined}
 */
export function lockedProvider(root) {
  /** @type {string} */
  let content;
  try {
    content = readFileSync(join(root, "scripts", "setup", ".terraform.lock.hcl"), "utf8");
  } catch {
    return undefined;
  }
  return parseLockedProvider(content);
}

/**
 * Project an allowlisted development diagnostic from bounded internal
 * subprocess tails. Output selects only the stable reason and, when there
 * is direct evidence, the OpenTofu subphase; provider metadata is included
 * only when the caller supplies the checkout's locked provider record, and
 * the spawn failure code only when it is an allowlisted Node errno. An
 * empty capture (spawn failure) still yields the stable phase diagnostic.
 * @param {DevSetupPhase} phase
 * @param {{stdout: string, stderr: string}} captured bounded captured tails
 * @param {{provider?: {source: string, version: string}, spawnFailure?: string}} [trusted] caller-supplied trusted facts
 * @returns {DevSetupDiagnostic}
 */
export function devSetupDiagnostic(phase, captured, trusted = {}) {
  const operation = PHASE_OPERATIONS[phase];
  /** @type {DevSetupDiagnostic} */
  let diagnostic;
  if (phase === "database" || phase === "mix-setup" || phase === "tool-install") {
    const reason = /** @type {DevSetupReason} */ (
      PHASE_REASONS[/** @type {"database"|"mix-setup"|"tool-install"} */ (phase)]
    );
    diagnostic = { operation, phase, reason, remediation: REMEDIATIONS[reason] };
  } else {
    const output = stripVTControlCharacters(
      `${captured.stdout.slice(-16 * 1024)}\n${captured.stderr.slice(-16 * 1024)}`,
    );
    diagnostic = {
      operation,
      phase: "foundation",
      reason: "foundation-failed",
      remediation: REMEDIATIONS["foundation-failed"],
    };
    const applyEvidence = APPLY_EVIDENCE.test(output);
    /** @type {"provider-checksum-mismatch"|"lockfile-update-required"|undefined} */
    let reason;
    if (CHECKSUM_EVIDENCE.test(output)) reason = "provider-checksum-mismatch";
    else if (!applyEvidence && LOCK_ERROR_EVIDENCE.test(output))
      reason = "lockfile-update-required";
    if (reason) {
      diagnostic.reason = reason;
      diagnostic.remediation = REMEDIATIONS[reason];
      diagnostic.subphase = applyEvidence
        ? "tofu-apply"
        : INIT_EVIDENCE.test(output)
          ? "tofu-init"
          : undefined;
      if (trusted.provider?.source && trusted.provider?.version) {
        diagnostic.provider = {
          source: trusted.provider.source,
          version: trusted.provider.version,
        };
      }
    }
  }
  if (typeof trusted.spawnFailure === "string" && SPAWN_ERROR_CODES.has(trusted.spawnFailure)) {
    diagnostic.spawnFailure = trusted.spawnFailure;
  }
  return diagnostic;
}

/**
 * Stable diagnostic for OpenTofu availability failures detected by the
 * probes in ensureOpenTofu (no subprocess output is available there).
 * @param {"opentofu-unavailable"|"opentofu-unusable"} reason
 * @returns {DevSetupDiagnostic | undefined}
 */
export function toolInstallDiagnostic(reason) {
  if (reason !== "opentofu-unavailable" && reason !== "opentofu-unusable") return undefined;
  return {
    operation: PHASE_OPERATIONS["tool-install"],
    phase: "tool-install",
    reason,
    remediation: REMEDIATIONS[reason],
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isText(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Re-project CLIError details into the allowlisted dev diagnostic shape so
 * unrelated or unexpected nested details are never serialized into JSON.
 * operation and remediation are derived from the known phase/reason
 * mappings rather than copied, and provider metadata is emitted only when
 * it exactly matches the checkout's locked provider record.
 * @param {unknown} details
 * @returns {DevSetupDiagnostic | undefined}
 */
export function safeDevSetupDiagnostic(details) {
  const diagnostic = isRecord(details) ? details.diagnostic : undefined;
  if (!isRecord(diagnostic)) return undefined;
  const phase = isText(diagnostic.phase) ? diagnostic.phase : undefined;
  const reason = isText(diagnostic.reason) ? diagnostic.reason : undefined;
  if (!phase || !reason || !DEV_SETUP_PHASES.includes(phase) || !REASON_ALLOWLIST.has(reason)) {
    return undefined;
  }
  const typedPhase = /** @type {DevSetupPhase} */ (phase);
  const typedReason = /** @type {DevSetupReason} */ (reason);
  /** @type {DevSetupDiagnostic} */
  const result = {
    operation: PHASE_OPERATIONS[typedPhase],
    phase: typedPhase,
    reason: typedReason,
    remediation: REMEDIATIONS[typedReason],
  };
  if (diagnostic.subphase === "tofu-init" || diagnostic.subphase === "tofu-apply") {
    result.subphase = diagnostic.subphase;
  }
  if (
    typeof diagnostic.spawnFailure === "string" &&
    SPAWN_ERROR_CODES.has(diagnostic.spawnFailure)
  ) {
    result.spawnFailure = diagnostic.spawnFailure;
  }
  if (PROVIDER_REASONS.has(typedReason)) {
    const root = isRecord(details) && isText(details.root) ? details.root : undefined;
    const locked = root ? lockedProvider(root) : undefined;
    const provider = isRecord(diagnostic.provider) ? diagnostic.provider : undefined;
    if (
      locked &&
      provider &&
      provider.source === locked.source &&
      provider.version === locked.version
    ) {
      result.provider = { source: locked.source, version: locked.version };
    }
  }
  return result;
}
