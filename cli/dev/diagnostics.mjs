// @ts-check
import { stripVTControlCharacters } from "node:util";

/** @typedef {"database"|"mix-setup"|"tool-install"|"foundation"} DevSetupPhase */

/** Recognized development setup phases; also the allowlist for JSON output. */
export const DEV_SETUP_PHASES = ["database", "mix-setup", "tool-install", "foundation"];

/**
 * Sanitized development setup diagnostic: explicit operation/phase, stable
 * reason, optional evidence-based OpenTofu subphase and provider identity,
 * and a static remediation. Never contains raw subprocess output.
 * @typedef {{
 *   operation: string,
 *   phase: DevSetupPhase,
 *   subphase?: "tofu-init"|"tofu-apply",
 *   reason: string,
 *   provider?: {source: string, version?: string},
 *   remediation: string,
 * }} DevSetupDiagnostic
 */

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
    "Test foundation provisioning runs 'tofu init -lockfile=readonly' and cannot update the dependency lockfile. Review the tofu report from the Tama root, deliberately lock the selected provider version for your platform with 'tofu -chdir=scripts/setup providers lock', re-verify with 'tofu -chdir=scripts/setup init -lockfile=readonly', then re-run 'tama-kit dev setup'.",
  "foundation-failed":
    "Tama's test foundation setup script failed. Re-run 'tama-kit dev setup' without --json to see the full Mix and OpenTofu output, and verify the development database is running.",
});

const REASON_ALLOWLIST = new Set(Object.keys(REMEDIATIONS));

const PHASE_OPERATIONS = Object.freeze({
  database: "docker-compose-up",
  "mix-setup": "mix-setup",
  "tool-install": "opentofu-install",
  foundation: "test-foundation-setup",
});

/** Non-foundation phases always map to one stable reason. */
const PHASE_REASONS = Object.freeze({
  database: "database-startup-failed",
  "mix-setup": "mix-setup-failed",
  "tool-install": "opentofu-install-failed",
});

/**
 * Allowlisted patterns, checked against ANSI-stripped bounded tails. Only
 * normalized facts are projected; arbitrary subprocess text is never echoed.
 */
const CHECKSUM_EVIDENCE =
  /invalid (?:dependency |provider )?checksum|checksum (?:mismatch|verification failed)|does not match (?:any )?(?:of the )?checksums?/iu;
const LOCK_EVIDENCE =
  /inconsistent (?:dependency )?lock file|not in lock file|require[sd]? (?:an? )?update[sd]? to (?:the )?dependency lock file/iu;
const APPLY_EVIDENCE =
  /tofu apply|terraform apply|applying |planned \d+ (?:resource|action)|apply (?:complete|finished)/iu;
const INIT_EVIDENCE =
  /tofu init|terraform init|initializ\w+ (?:the |any )?(?:providers|backend|infrastructure)|Terraform has been (?:successfully )?initialized/iu;
const PROVIDER_SOURCE =
  /registry\.opentofu\.org\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/iu;
const SEMVER = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\b/u;

/**
 * Project an allowlisted development diagnostic from bounded internal
 * subprocess tails. Provider source/version are included only when a
 * strict registry address and semver appear together in the output.
 * @param {DevSetupPhase} phase
 * @param {{stdout: string, stderr: string}} captured bounded captured tails
 * @returns {DevSetupDiagnostic}
 */
export function devSetupDiagnostic(phase, captured) {
  const operation = PHASE_OPERATIONS[phase];
  if (phase === "database" || phase === "mix-setup" || phase === "tool-install") {
    const reason = PHASE_REASONS[phase];
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
  /** @type {"provider-checksum-mismatch"|"lockfile-update-required"|undefined} */
  let reason;
  if (CHECKSUM_EVIDENCE.test(output)) reason = "provider-checksum-mismatch";
  else if (LOCK_EVIDENCE.test(output)) reason = "lockfile-update-required";
  if (reason) {
    diagnostic.reason = reason;
    diagnostic.remediation = REMEDIATIONS[reason];
    diagnostic.subphase = APPLY_EVIDENCE.test(output)
      ? "tofu-apply"
      : INIT_EVIDENCE.test(output)
        ? "tofu-init"
        : undefined;
    const provider = extractProvider(output);
    if (provider) diagnostic.provider = provider;
  }
  return diagnostic;
}

/**
 * @param {string} output ANSI-stripped normalized output
 * @returns {{source: string, version?: string} | undefined}
 */
function extractProvider(output) {
  const source = output.match(PROVIDER_SOURCE)?.[0];
  if (!source) return undefined;
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(source) && SEMVER.test(candidate));
  const version = line ? /** @type {RegExpMatchArray} */ (line.match(SEMVER))[1] : undefined;
  return version ? { source, version } : { source };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-project CLIError details into the allowlisted dev diagnostic shape so
 * unrelated or unexpected nested details are never serialized into JSON.
 * @param {unknown} details
 * @returns {DevSetupDiagnostic | undefined}
 */
export function safeDevSetupDiagnostic(details) {
  const diagnostic = isRecord(details) ? details.diagnostic : undefined;
  if (!isRecord(diagnostic)) return undefined;
  /** @param {unknown} value */
  const text = (value) =>
    typeof value === "string" && value.length > 0 ? /** @type {string} */ (value) : undefined;
  const operation = text(diagnostic.operation);
  const phase = text(diagnostic.phase);
  const reason = text(diagnostic.reason);
  const remediation = text(diagnostic.remediation);
  if (
    !operation ||
    !phase ||
    !reason ||
    !remediation ||
    !DEV_SETUP_PHASES.includes(phase) ||
    !REASON_ALLOWLIST.has(reason)
  ) {
    return undefined;
  }
  /** @type {DevSetupDiagnostic} */
  const result = {
    operation,
    phase: /** @type {DevSetupPhase} */ (/** @type {string} */ (phase)),
    reason,
    remediation,
  };
  const subphase = text(diagnostic.subphase);
  if (subphase === "tofu-init" || subphase === "tofu-apply") result.subphase = subphase;
  if (isRecord(diagnostic.provider)) {
    const source = text(diagnostic.provider.source);
    if (source) {
      const version = text(diagnostic.provider.version);
      result.provider = { source, ...(version ? { version } : {}) };
    }
  }
  return result;
}
