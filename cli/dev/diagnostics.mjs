// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** @typedef {"database"|"mix-setup"|"tool-install"|"foundation"} DevSetupPhase */
/** @typedef {"database-startup-failed"|"mix-setup-failed"|"opentofu-install-failed"|"provider-checksum-mismatch"|"lockfile-update-required"|"foundation-failed"} DevSetupReason */

/** Recognized development setup phases; also the allowlist for JSON output. */
export const DEV_SETUP_PHASES = ["database", "mix-setup", "tool-install", "foundation"];

/**
 * Sanitized development setup diagnostic: explicit operation/phase, stable
 * reason, optional evidence-based OpenTofu subphase and provider identity,
 * and a static remediation. Never contains raw subprocess output; the
 * provider record, when present, comes only from the checkout's
 * repository-owned dependency lock file, never from captured output.
 * @typedef {{
 *   operation: string,
 *   phase: DevSetupPhase,
 *   subphase?: "tofu-init"|"tofu-apply",
 *   reason: string,
 *   provider?: {source: string, version: string},
 *   remediation: string,
 * }} DevSetupDiagnostic
 */

/** @type {Record<DevSetupReason, string>} */
const REMEDIATIONS = Object.freeze({
  "database-startup-failed":
    "Docker Compose could not start the isolated PostgreSQL service. Verify Docker is running and the Tama compose file can start 'postgres', then re-run 'tama-kit dev setup' without --json to see the full Compose output.",
  "mix-setup-failed":
    "Mix setup failed. Re-run 'tama-kit dev setup' without --json to see the full Mix output, and verify the development database is reachable.",
  "opentofu-install-failed":
    "OpenTofu installation through mise failed. Install the OpenTofu version declared in .tool-versions manually or re-run 'mise install opentofu', then re-run 'tama-kit dev setup'.",
  "provider-checksum-mismatch":
    "OpenTofu rejected a provider checksum recorded in the dependency lockfile. From the Tama root, keep the lockfile's selected provider version and refresh only its verified checksums for this platform, for example on macOS arm64: 'tofu -chdir=scripts/setup providers lock -platform=darwin_arm64 registry.opentofu.org/upmaru/tama'. Review the signature information and the lock diff, re-run 'tofu -chdir=scripts/setup init -lockfile=readonly', then re-run 'tama-kit dev setup'. Do not delete the lockfile, disable checksum verification, or use a writable init.",
  "lockfile-update-required":
    "Test foundation provisioning runs 'tofu init -lockfile=readonly' and cannot update the dependency lockfile. Review the tofu report from the Tama root, deliberately lock the selected provider version for your platform with 'tofu -chdir=scripts/setup providers lock', re-verify with 'tofu -chdir=scripts/setup init -lockfile=readonly', then re-run 'tama-kit dev setup'. Do not follow tofu's suggestion to re-run a writable init.",
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
 * The lockfile patterns track OpenTofu's read-only init wording: the fatal
 * "Error: Provider dependency changes detected ... the lock file is read-only"
 * failure and the nonfatal "Warning: Provider lock file not updated" warning.
 * A warning (or any lock message) never explains a failure once apply output
 * is present, because init then completed and a later apply error has its
 * own cause.
 */
const CHECKSUM_EVIDENCE =
  /invalid (?:dependency |provider )?checksum|checksum (?:mismatch|verification failed)|does not match (?:any )?(?:of the )?checksums?/iu;
const LOCK_ERROR_EVIDENCE =
  /provider dependency changes detected|lock file is read-only|inconsistent dependency lock file|not in lock file/iu;
const LOCK_WARNING_EVIDENCE =
  /provider lock file not updated|provider (?:selections|dependencies) were detected, but not saved/iu;
const APPLY_EVIDENCE =
  /tofu apply|terraform apply|openTofu has planned \d+ actions|applying |planned \d+ (?:resource|action)|apply (?:complete|finished)/iu;
const INIT_EVIDENCE =
  /tofu init|terraform init|initializ\w+ (?:the |any )?(?:providers|backend|infrastructure)|initializ\w+ provider plugins|openTofu has been (?:successfully )?initialized|Terraform has been (?:successfully )?initialized/iu;

/** Strict `provider "registry.opentofu.org/ns/name" x.y.z {` lockfile record. */
const LOCK_PROVIDER_RECORD =
  /^provider\s+"(registry\.opentofu\.org\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)"\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\s*\{/gmu;

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
  const records = [];
  for (const match of content.matchAll(LOCK_PROVIDER_RECORD)) {
    records.push({
      source: /** @type {string} */ (match[1]),
      version: /** @type {string} */ (match[2]),
    });
  }
  return records.length === 1 ? records[0] : undefined;
}

/**
 * Project an allowlisted development diagnostic from bounded internal
 * subprocess tails. Output selects only the stable reason and, when there
 * is direct evidence, the OpenTofu subphase; provider metadata is included
 * only when the caller supplies the checkout's locked provider record.
 * @param {DevSetupPhase} phase
 * @param {{stdout: string, stderr: string}} captured bounded captured tails
 * @param {{provider?: {source: string, version: string}}} [trusted] caller-supplied trusted lock record
 * @returns {DevSetupDiagnostic}
 */
export function devSetupDiagnostic(phase, captured, trusted = {}) {
  const operation = PHASE_OPERATIONS[phase];
  if (phase === "database" || phase === "mix-setup" || phase === "tool-install") {
    const reason = /** @type {DevSetupReason} */ (
      PHASE_REASONS[/** @type {"database"|"mix-setup"|"tool-install"} */ (phase)]
    );
    return { operation, phase, reason, remediation: REMEDIATIONS[reason] };
  }

  const output = stripVTControlCharacters(
    `${captured.stdout.slice(-16 * 1024)}\n${captured.stderr.slice(-16 * 1024)}`,
  );
  /** @type {DevSetupDiagnostic} */
  const diagnostic = {
    operation,
    phase: "foundation",
    reason: "foundation-failed",
    remediation: REMEDIATIONS["foundation-failed"],
  };
  const applyEvidence = APPLY_EVIDENCE.test(output);
  /** @type {"provider-checksum-mismatch"|"lockfile-update-required"|undefined} */
  let reason;
  if (CHECKSUM_EVIDENCE.test(output)) reason = "provider-checksum-mismatch";
  else if (
    !applyEvidence &&
    (LOCK_ERROR_EVIDENCE.test(output) || LOCK_WARNING_EVIDENCE.test(output))
  )
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
      diagnostic.provider = { source: trusted.provider.source, version: trusted.provider.version };
    }
  }
  return diagnostic;
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
