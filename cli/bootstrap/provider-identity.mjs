// @ts-check

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { usageError } from "../errors.mjs";
import { assertUnreservedFragmentPath, safeRelativePath } from "./mcp-app-contract.mjs";

/** @typedef {import("../types.mjs").Framework} Framework */
/** @typedef {import("../types.mjs").ProviderIdentity} ProviderIdentity */

const MAX_NAME_LENGTH = 64;
const MAX_PREFIX_LENGTH = 24;
const MAX_READ_BYTES = 65_536;
const RESERVED_PREFIXES = Object.freeze([
  "COMPOSE",
  "DATABASE",
  "DOCKER",
  "PHX",
  "PORT",
  "POSTGRES",
  "SECRET",
  "TAMA",
  "TAMA_MCP",
  "TAMA_OAUTH",
]);

/** @param {string} path @returns {string | null} */
function readFileBounded(path) {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
      return null;
    }
    const content = readFileSync(path, "utf8");
    return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) : content;
  } catch {
    return null;
  }
}

/**
 * Normalizes a raw provider name into a lowercase ASCII slug: repeated
 * separators collapse to a single hyphen, names begin with a letter, and the
 * result is bounded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProviderName(value) {
  if (typeof value !== "string") {
    throw usageError("provider name is required");
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug.length === 0 || slug.length > MAX_NAME_LENGTH) {
    throw usageError(`provider name is not a valid slug: ${value}`);
  }
  if (!/^[a-z]/u.test(slug)) {
    throw usageError(`provider name must begin with a letter: ${value}`);
  }
  return slug;
}

/**
 * Normalizes a raw environment prefix to uppercase `A-Z0-9_` that begins with
 * a letter and is conservatively bounded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEnvironmentPrefix(value) {
  if (typeof value !== "string") {
    throw usageError("environment prefix is required");
  }
  const prefix = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/_{2,}/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (prefix.length === 0 || prefix.length > MAX_PREFIX_LENGTH) {
    throw usageError(`environment prefix is not valid: ${value}`);
  }
  if (!/^[A-Z]/u.test(prefix)) {
    throw usageError(`environment prefix must begin with a letter: ${value}`);
  }
  const reserved = RESERVED_PREFIXES.find((candidate) => prefix === candidate);
  if (reserved) {
    throw usageError(`environment prefix conflicts with reserved ${reserved} variables: ${value}`);
  }
  return prefix;
}

/** @param {string} name @returns {string} */
export function prefixFromName(name) {
  return normalizeEnvironmentPrefix(name.toUpperCase().replaceAll("-", "_"));
}

/** @param {string} name @returns {string} */
export function environmentFileForName(name) {
  return `.${name}.integration.env`;
}

/** @param {string} value @returns {string} */
function camelToSlug(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

/** @param {string} value @returns {string} */
function unscopedName(value) {
  const segments = value.split("/").filter(Boolean);
  return segments.at(-1) ?? value;
}

/**
 * @param {string} root
 * @param {Framework} framework
 * @returns {{name: string, source: "framework"} | null}
 */
function frameworkIdentity(root, framework) {
  if (framework === "phoenix") {
    const mix = readFileBounded(join(root, "mix.exs"));
    const match = mix?.match(/\bapp:\s*:([a-z][a-z0-9_]*)/u);
    if (match) {
      return { name: match[1], source: "framework" };
    }
  }
  if (framework === "rails") {
    const application = readFileBounded(join(root, "config", "application.rb"));
    const match = application?.match(/\bclass\s+([A-Z][A-Za-z0-9]*)::Application\b/u);
    if (match) {
      return { name: camelToSlug(match[1]), source: "framework" };
    }
  }
  if (framework === "node") {
    const packageJson = readFileBounded(join(root, "package.json"));
    if (packageJson) {
      try {
        const parsed = /** @type {{name?: unknown}} */ (JSON.parse(packageJson));
        if (typeof parsed.name === "string" && parsed.name.length > 0) {
          return { name: unscopedName(parsed.name), source: "framework" };
        }
      } catch {
        // A malformed package.json must not block bootstrap; fall through.
      }
    }
  }
  return null;
}

/** @param {string} root @returns {string | null} */
function gitRemoteName(root) {
  let output;
  try {
    output = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const trimmed = output.trim().replace(/\.git$/u, "");
  const segment = trimmed.split(/[\\/]/u).filter(Boolean).at(-1);
  return segment && segment.length > 0 ? segment : null;
}

/**
 * @typedef {object} IdentityDetection
 * @property {string} name
 * @property {"framework" | "git" | "directory"} source
 */

/**
 * Suggests a provider name from the weakest acceptable signal: framework-owned
 * application metadata, then the Git remote repository name, then the
 * project-root directory name. No provider application code is executed.
 *
 * @param {string} root
 * @param {Framework} framework
 * @returns {IdentityDetection}
 */
export function detectProviderIdentity(root, framework) {
  const fromFramework = frameworkIdentity(root, framework);
  if (fromFramework) {
    return fromFramework;
  }
  const fromGit = gitRemoteName(root);
  if (fromGit) {
    return { name: fromGit, source: "git" };
  }
  const directory = basename(resolve(root));
  return {
    name: directory.length > 0 ? directory : "provider",
    source: "directory",
  };
}

/**
 * @typedef {object} ResolveIdentityInput
 * @property {string} root
 * @property {Framework} framework
 * @property {ProviderIdentity | null} manifestProvider
 * @property {Record<string, unknown> | null} contractDocument
 * @property {string | undefined} name
 * @property {string | undefined} prefix
 * @property {string | undefined} environmentFile
 * @property {ProviderIdentity["source"]} [identitySource]
 */

/**
 * A provider fragment may only be written to a safe project-relative path
 * that no bootstrap-managed or application-owned file occupies, no matter
 * where the path came from (contract, manifest, or flag).
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertFragmentPath(value, label) {
  const path = safeRelativePath(value, label);
  assertUnreservedFragmentPath(path, label);
  return path;
}

/**
 * Resolves the accepted provider identity using the documented precedence:
 * managed manifest, then explicit contract identity, then explicit flags, then
 * safe static detection. The directory name is only ever a suggestion and is
 * accepted here when a stronger signal is absent; the command layer is
 * responsible for interactive confirmation and for requiring an explicit name
 * in non-interactive runs.
 *
 * @param {ResolveIdentityInput} input
 * @returns {ProviderIdentity}
 */
export function resolveProviderIdentity(input) {
  const {
    root,
    framework,
    manifestProvider,
    contractDocument,
    name,
    prefix,
    environmentFile,
    identitySource,
  } = input;

  if (manifestProvider) {
    // The manifest is trusted state, but it is disk-resident: re-validate the
    // fragment path so a tampered or stale entry cannot point the fragment at
    // a bootstrap-managed file.
    return {
      name: manifestProvider.name,
      environmentPrefix: manifestProvider.environmentPrefix,
      environmentFile: assertFragmentPath(
        manifestProvider.environmentFile,
        "the persisted MCP App provider environment file",
      ),
      source: "manifest",
    };
  }

  const contractIdentity =
    contractDocument !== null && isIdentityDocument(contractDocument.provider)
      ? /** @type {Record<string, unknown>} */ (contractDocument.provider)
      : null;
  const contractName =
    typeof contractIdentity?.name === "string" ? contractIdentity.name : undefined;

  if (contractName !== undefined) {
    const resolvedName = normalizeProviderName(contractName);
    return {
      name: resolvedName,
      environmentPrefix:
        typeof contractIdentity?.environment_prefix === "string"
          ? normalizeEnvironmentPrefix(contractIdentity.environment_prefix)
          : prefixFromName(resolvedName),
      environmentFile:
        typeof contractIdentity?.environment_file === "string"
          ? assertFragmentPath(
              contractIdentity.environment_file,
              "the provider MCP App contract environment file",
            )
          : environmentFileForName(resolvedName),
      source: identitySource ?? "contract",
    };
  }

  if (name || prefix || environmentFile) {
    if (!name) {
      throw usageError(
        "--provider-name is required when --provider-prefix or --provider-env-file is supplied",
      );
    }
    const resolvedName = normalizeProviderName(name);
    return {
      name: resolvedName,
      environmentPrefix: prefix ? normalizeEnvironmentPrefix(prefix) : prefixFromName(resolvedName),
      environmentFile:
        environmentFile === undefined
          ? environmentFileForName(resolvedName)
          : assertFragmentPath(environmentFile, "--provider-env-file"),
      source: identitySource ?? "flags",
    };
  }

  const detection = detectProviderIdentity(root, framework);
  return {
    name: normalizeProviderName(detection.name),
    environmentPrefix: prefixFromName(detection.name),
    environmentFile: environmentFileForName(detection.name),
    source: identitySource ?? detection.source,
  };
}

/** @param {unknown} value @returns {boolean} */
function isIdentityDocument(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
