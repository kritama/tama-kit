// @ts-check

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import { ambiguityError, ownershipError } from "../errors.mjs";
import { MANAGED_MARKER } from "./constants.mjs";
import { operationForContent } from "./files.mjs";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */
/** @typedef {Record<string, unknown>} ComposeMapping */

const OWNED_SERVICES = new Set(["tama", "tama-postgres"]);

/** @param {unknown} value @param {string} filename @returns {string | null} */
function localIncludePath(value, filename) {
  if (typeof value !== "string" || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    return null;
  }
  return isAbsolute(value) ? resolve(value) : resolve(dirname(filename), value);
}

/** @param {string} content @param {string} filename */
function parseCompose(content, filename) {
  const document = parseDocument(content, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw ambiguityError(`cannot parse Compose file ${filename}: ${document.errors[0].message}`, {
      path: filename,
    });
  }
  const rawValue = /** @type {unknown} */ (document.toJS());
  if (rawValue !== null && (typeof rawValue !== "object" || Array.isArray(rawValue))) {
    throw ambiguityError(`Compose file must contain a mapping: ${filename}`, { path: filename });
  }
  const value = /** @type {ComposeMapping} */ (rawValue ?? {});
  return { document, value };
}

/** @param {unknown} entry @returns {unknown[]} */
function includePaths(entry) {
  if (typeof entry === "string") {
    return [entry];
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const path = /** @type {{path?: unknown}} */ (entry).path;
  return Array.isArray(path) ? path : [path];
}

/** @param {unknown} entry @param {string} filename @param {string} managedComposeFilename */
function hasTamaInclude(entry, filename, managedComposeFilename) {
  const expected = resolve(managedComposeFilename);
  return includePaths(entry).some((item) => localIncludePath(item, filename) === expected);
}

/** @param {unknown} entry @param {string} filename @param {string} managedComposeFilename */
function relocatedManagedIncludes(entry, filename, managedComposeFilename) {
  const expected = resolve(managedComposeFilename);
  return includePaths(entry).filter((item) => {
    const includePath = localIncludePath(item, filename);
    if (!includePath || includePath === expected) {
      return false;
    }
    const conventionalTamaPath = /(?:^|[\\/])tama[\\/]compose\.ya?ml$/u.test(includePath);
    if (!existsSync(includePath) || lstatSync(includePath).isDirectory()) {
      return conventionalTamaPath;
    }
    if (lstatSync(includePath).isSymbolicLink()) {
      return conventionalTamaPath;
    }
    const firstLine = readFileSync(includePath, "utf8").split(/\r?\n/u, 1)[0];
    return conventionalTamaPath || firstLine.startsWith(`# ${MANAGED_MARKER}`);
  });
}

/** @param {string} filename @param {string} managedComposeFilename */
function relativeIncludePath(filename, managedComposeFilename) {
  const path = relative(dirname(filename), managedComposeFilename).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** @param {ComposeMapping} compose @param {string} filename */
function checkServiceCollisions(compose, filename) {
  const services = compose.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    return;
  }
  const collisions = Object.keys(services).filter((name) => OWNED_SERVICES.has(name));
  if (collisions.length > 0) {
    throw ownershipError(
      `Compose file already declares Tama Kit service names (${collisions.join(", ")}): ${filename}`,
      { path: filename, services: collisions },
    );
  }
}

/**
 * @param {string} filename
 * @param {string} managedComposeFilename
 * @param {string} newRootContent
 * @returns {FileOperation}
 */
export function planRootCompose(filename, managedComposeFilename, newRootContent) {
  if (!existsSync(filename)) {
    return operationForContent(filename, newRootContent);
  }

  const original = readFileSync(filename, "utf8");
  const { document, value } = parseCompose(original, filename);
  checkServiceCollisions(value, filename);

  const currentIncludes = value.include ?? [];
  if (!Array.isArray(currentIncludes)) {
    throw ambiguityError(`Compose include must be a sequence: ${filename}`, { path: filename });
  }
  const includePath = relativeIncludePath(filename, managedComposeFilename);
  const matches = currentIncludes.filter((entry) =>
    hasTamaInclude(entry, filename, managedComposeFilename),
  );
  if (matches.length > 1) {
    throw ownershipError(`Compose file contains multiple Tama Kit includes: ${filename}`, {
      path: filename,
    });
  }

  const relocated = currentIncludes.flatMap((entry) =>
    relocatedManagedIncludes(entry, filename, managedComposeFilename),
  );
  if (relocated.length > 0) {
    throw ownershipError(
      `Compose file already includes a Tama Kit fragment at a different path: ${filename}`,
      { path: filename, includes: relocated },
    );
  }

  const updated = [...currentIncludes];
  if (matches.length === 0) {
    updated.push(includePath);
  }
  document.set("include", updated);
  const content = String(document);
  return operationForContent(filename, content, {
    owner: "user",
    allowUnmanagedUpdate: true,
  });
}

/** @param {string} content @param {string} [filename] @returns {ComposeMapping} */
export function validateComposeDocument(content, filename = "compose.yaml") {
  return parseCompose(content, filename).value;
}
