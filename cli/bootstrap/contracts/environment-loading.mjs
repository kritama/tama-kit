// @ts-check
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { isPlainObject, safeRead } from "./files.mjs";
/** @typedef {import("../../domain/contracts.mjs").McpAppContract} McpAppContract */

/**
 * Determines whether the provider fragment is loaded by an application-owned
 * mechanism that Tama Kit can safely confirm. A provider contract declaration
 * records intent but is not evidence by itself. An active direnv
 * `dotenv`/`dotenv_load` directive or a Compose `env_file` entry that references
 * the fragment verifies it. A bare textual occurrence — a comment or an
 * unrelated command naming the file — does not count: migration deletes the
 * fragment this check exists to protect. When no loader can be confirmed the
 * integration is reported unverified rather than failing, because the
 * application owns its loader.
 *
 * @param {string} root
 * @param {string} environmentFile
 * @param {McpAppContract | null} contractDocument
 * @param {string} [selectedCompose]
 * @returns {"verified" | "unverified"}
 */
export function verifyEnvironmentLoading(root, environmentFile, contractDocument, selectedCompose) {
  return verifyEnvironmentLoadingEvidence(root, environmentFile, contractDocument, selectedCompose)
    .status;
}

/**
 * Returns the exact static evidence behind the loader status. Provider
 * contract declarations describe intent but are not evidence by themselves:
 * the referenced application-owned loader must exist and actively consume the
 * generated fragment.
 *
 * @param {string} root
 * @param {string} environmentFile
 * @param {McpAppContract | null} contractDocument
 * @param {string} [selectedCompose]
 * @returns {import("../../types.mjs").EnvironmentLoadingEvidence}
 */
export function verifyEnvironmentLoadingEvidence(
  root,
  environmentFile,
  contractDocument,
  selectedCompose,
) {
  // Reading the declaration keeps this verifier deliberately aware of the
  // accepted provider contract without treating the object as certification.
  // The validator already requires `loads` to match the provider fragment.
  void contractDocument;
  const envrc = safeRead(join(root, ".envrc"));
  if (envrc !== null && envrcLoadsFragment(envrc, environmentFile)) {
    return { status: "verified", mechanism: "direnv", evidencePath: ".envrc" };
  }
  const composePaths = [
    ...(selectedCompose ? [resolve(root, selectedCompose)] : []),
    ...["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].map((name) =>
      join(root, name),
    ),
  ];
  for (const composePath of new Set(composePaths)) {
    const compose = safeRead(composePath);
    if (
      compose !== null &&
      composeReferencesFragment(compose, resolve(root, environmentFile), composePath)
    ) {
      const local = relative(root, composePath);
      return {
        status: "verified",
        mechanism: "compose-env-file",
        evidencePath:
          local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)
            ? local.split(sep).join("/")
            : composePath,
      };
    }
  }
  return { status: "unverified", mechanism: null, evidencePath: null };
}

/** @param {string} value */
function unquote(value) {
  return value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

/**
 * Reports whether a direnv `.envrc` actively loads the fragment: a top-level
 * `dotenv` or `dotenv_load` directive whose path argument is the fragment.
 *
 * @param {string} envrc
 * @param {string} environmentFile
 * @returns {boolean}
 */
function envrcLoadsFragment(envrc, environmentFile) {
  for (const rawLine of envrc.split(/\r?\n/u)) {
    const tokens = rawLine
      .trim()
      .split(/\s+/u)
      .filter((token) => token !== "");
    if (tokens.length === 0) {
      continue;
    }
    const command = unquote(tokens[0]);
    if (command !== "dotenv" && command !== "dotenv_load") {
      continue;
    }
    let path = null;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith("-")) {
        continue;
      }
      if (path === null && token === "load") {
        continue;
      }
      path = unquote(token);
      break;
    }
    if (path === environmentFile || path === `./${environmentFile}`) {
      return true;
    }
  }
  return false;
}

/**
 * Reports whether a Compose file loads the fragment: the name must appear as
 * a service `env_file` entry (string, flow list, or block list form). A
 * textual mention in a command, label, or volume does not load the file, so
 * it does not count.
 *
 * @param {string} compose
 * @param {string} environmentFilePath
 * @param {string} composePath
 * @returns {boolean}
 */
function composeReferencesFragment(compose, environmentFilePath, composePath) {
  const document = parseDocument(compose);
  if (document.errors.length > 0) {
    return false;
  }
  const root = document.toJS();
  const services = isPlainObject(root) && isPlainObject(root.services) ? root.services : null;
  if (services === null) {
    return false;
  }
  for (const service of Object.values(services)) {
    if (!isPlainObject(service)) {
      continue;
    }
    const envFile = service.env_file;
    const entries = Array.isArray(envFile) ? envFile : envFile === undefined ? [] : [envFile];
    if (
      entries.some((entry) => {
        const path = typeof entry === "string" ? entry : isPlainObject(entry) ? entry.path : null;
        return (
          typeof path === "string" && resolve(dirname(composePath), path) === environmentFilePath
        );
      })
    ) {
      return true;
    }
  }
  return false;
}
