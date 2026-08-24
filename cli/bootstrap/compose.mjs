import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

import { parseDocument } from "yaml";

import { ambiguityError, ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";

const OWNED_SERVICES = new Set(["tama", "tama-postgres"]);

function normalizePath(value) {
  return typeof value === "string" ? value.replace(/^\.\//u, "") : null;
}

function parseCompose(content, filename) {
  const document = parseDocument(content, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw ambiguityError(`cannot parse Compose file ${filename}: ${document.errors[0].message}`, {
      path: filename,
    });
  }
  const value = document.toJS();
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw ambiguityError(`Compose file must contain a mapping: ${filename}`, { path: filename });
  }
  return { document, value: value ?? {} };
}

function includePaths(entry) {
  if (typeof entry === "string") {
    return [entry];
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  return Array.isArray(entry.path) ? entry.path : [entry.path];
}

function hasTamaInclude(entry, includePath) {
  return includePaths(entry).some(
    (item) => normalizePath(item) === normalizePath(includePath),
  );
}

function relativeIncludePath(filename, managedComposeFilename) {
  const path = relative(dirname(filename), managedComposeFilename).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

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
  const matches = currentIncludes.filter((entry) => hasTamaInclude(entry, includePath));
  if (matches.length > 1) {
    throw ownershipError(`Compose file contains multiple Tama Kit includes: ${filename}`, {
      path: filename,
    });
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

export function validateComposeDocument(content, filename = "compose.yaml") {
  return parseCompose(content, filename).value;
}
