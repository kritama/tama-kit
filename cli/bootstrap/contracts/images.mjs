// @ts-check
import { usageError } from "../../errors.mjs";

const VERSION_CONSTRAINT_SOURCE = "(?:>=|<=|>|<|=)\\s*v?\\d+\\.\\d+\\.\\d+";
const VERSION_RANGE_PATTERN = new RegExp(
  `^${VERSION_CONSTRAINT_SOURCE}(?:\\s+and\\s+${VERSION_CONSTRAINT_SOURCE})*$`,
  "u",
);
const VERSION_CONSTRAINT_PATTERN = /(>=|<=|>|<|=)\s*v?(\d+\.\d+\.\d+)/gu;
/** @param {string} value @param {string} label */
export function validateSupportedVersionRange(value, label) {
  if (!VERSION_RANGE_PATTERN.test(value)) {
    throw usageError(
      `MCP App contract ${label} must be a comparison range such as >= 0.13.1 and < 0.14.0`,
    );
  }
}

/**
 * Rejects the official version form that GHCR does not publish. Floating
 * `latest` remains unsuffixed, while concrete server releases use
 * `<version>-server`.
 *
 * @param {string} image
 * @returns {string | null}
 */
export function invalidOfficialTamaImageTag(image) {
  const separator = image.lastIndexOf(":");
  const repository = separator > image.lastIndexOf("/") ? image.slice(0, separator) : image;
  const tag = separator > image.lastIndexOf("/") ? image.slice(separator + 1) : "latest";
  return repository === "ghcr.io/upmaru/tama" && /^v?\d+\.\d+\.\d+$/u.test(tag)
    ? `versioned ghcr.io/upmaru/tama image tag ${tag} is missing the required -server suffix`
    : null;
}

/**
 * Checks a Tama image tag against the contract's `supported_tama_versions`
 * range. Official versioned server images use `<version>-server`; the deployment
 * suffix is removed before comparison. The check is best-effort by design:
 * non-semver tags such as `latest` cannot be resolved offline, so they pass
 * with no warning. Other prerelease and build tags do resolve, but SemVer
 * orders them below the stable version they decorate and the range grammar
 * cannot express prerelease bounds, so they are reported as outside the range.
 *
 * @param {string} image
 * @param {unknown} supportedRange
 * @returns {string | null} a reason when the tag is provably outside the
 *   range, otherwise null
 */
export function unsupportedTamaImage(image, supportedRange) {
  const invalidOfficialTag = invalidOfficialTamaImageTag(image);
  if (invalidOfficialTag) {
    return invalidOfficialTag;
  }
  if (typeof supportedRange !== "string" || supportedRange.length === 0) {
    return null;
  }
  validateSupportedVersionRange(supportedRange, "supported_tama_versions");
  const separator = image.lastIndexOf(":");
  const tag = separator > image.lastIndexOf("/") ? image.slice(separator + 1) : "latest";
  const stableServerTag = tag.match(/^(v?\d+\.\d+\.\d+)-server$/u);
  const versionTag = stableServerTag?.[1] ?? tag;
  const version = parseSemver(versionTag);
  if (!version) {
    return null;
  }
  // A prerelease or build suffix orders the tag below the stable version it
  // decorates (0.13.1-rc.1 < 0.13.1), and the range grammar cannot express
  // prerelease bounds, so such a tag cannot be held to the range.
  if (!stableServerTag && !/^v?\d+\.\d+\.\d+$/u.test(tag)) {
    return `Tama image tag ${tag} is a prerelease or build tag; the supported Tama range ${supportedRange} admits stable release tags only`;
  }
  const constraints = supportedRange.matchAll(VERSION_CONSTRAINT_PATTERN);
  for (const match of constraints) {
    const bound = parseSemver(match[2]);
    if (!bound) {
      continue;
    }
    const comparison = compareSemver(version, bound);
    const ok =
      match[1] === ">="
        ? comparison >= 0
        : match[1] === "<="
          ? comparison <= 0
          : match[1] === ">"
            ? comparison > 0
            : match[1] === "<"
              ? comparison < 0
              : comparison === 0;
    if (!ok) {
      return `Tama image tag ${tag} is outside the supported Tama range ${supportedRange}`;
    }
  }
  return null;
}

/**
 * Reports the Tama image tag when it is not a pinned version. Floating tags
 * such as `latest` cannot be checked against the supported range offline, so
 * planning the MCP App integration against them would start a runtime Tama
 * Kit cannot hold to the contract once the tag moves.
 *
 * @param {string} image
 * @returns {string | null} the unresolvable tag, or null for a pinned one
 */
export function unpinnedTamaImageTag(image) {
  const separator = image.lastIndexOf(":");
  const tag = separator > image.lastIndexOf("/") ? image.slice(separator + 1) : "latest";
  return parseSemver(tag) === null ? tag : null;
}

/** @param {string} value @returns {[number, number, number] | null} */
function parseSemver(value) {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {[number, number, number]} left @param {[number, number, number]} right */
function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}
