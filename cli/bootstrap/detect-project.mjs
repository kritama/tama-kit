// @ts-check

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ambiguityError, ownershipError, usageError } from "../errors.mjs";
import { COMPOSE_FILENAMES } from "./constants.mjs";

/** @typedef {import("../types.mjs").BootstrapPlanOptions} BootstrapPlanOptions */
/** @typedef {import("../types.mjs").FrameworkDetection} FrameworkDetection */
/** @typedef {import("../types.mjs").ProjectInspection} ProjectInspection */

/** @param {string} directory */
function isDirectory(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} start */
function nearestGitRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

/** @param {string} filename @param {RegExp} pattern */
function includesPattern(filename, pattern) {
  try {
    return pattern.test(readFileSync(filename, "utf8"));
  } catch {
    return false;
  }
}

/** @param {string} root @returns {FrameworkDetection} */
export function detectFramework(root) {
  const evidence = [];
  const gemfile = join(root, "Gemfile");
  if (
    existsSync(join(root, "config", "application.rb")) &&
    includesPattern(gemfile, /\bgem\s+["']rails["']/u)
  ) {
    evidence.push("Gemfile declares Rails", "config/application.rb exists");
    return { framework: "rails", evidence };
  }

  const mixfile = join(root, "mix.exs");
  if (
    existsSync(join(root, "config", "config.exs")) &&
    includesPattern(mixfile, /\{:phoenix\s*,/u)
  ) {
    evidence.push("mix.exs declares Phoenix", "config/config.exs exists");
    return { framework: "phoenix", evidence };
  }

  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    evidence.push("package.json exists");
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      const dependencies = /** @type {Record<string, unknown>} */ ({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      });
      for (const [name, label] of [
        ["next", "Next.js"],
        ["@tanstack/start", "TanStack Start"],
        ["@remix-run/react", "Remix"],
        ["vite", "Vite"],
      ]) {
        if (dependencies[name]) {
          evidence.push(`${label} dependency detected`);
        }
      }
    } catch {
      evidence.push("package.json could not be parsed");
    }
    return { framework: "node", evidence };
  }

  return { framework: "generic", evidence: ["no supported framework signature matched"] };
}

/** @param {BootstrapPlanOptions} options @returns {ProjectInspection} */
export function inspectProject({ cwd, targetPath, composePath }) {
  const explicitTarget = targetPath !== undefined;
  const requested = resolve(cwd, targetPath ?? ".");
  if (!isDirectory(requested)) {
    throw usageError(`project path is not a directory: ${requested}`);
  }
  const root = explicitTarget ? requested : nearestGitRoot(requested);
  const composeCandidates = COMPOSE_FILENAMES.map((name) => join(root, name)).filter(existsSync);

  let selectedCompose;
  if (composePath) {
    selectedCompose = isAbsolute(composePath) ? composePath : resolve(root, composePath);
    const composeRelative = relative(root, selectedCompose);
    const outsideRoot = composeRelative === ".." || composeRelative.startsWith(`..${sep}`);
    if (outsideRoot) {
      throw usageError(`Compose file must be inside the project root: ${selectedCompose}`);
    }
    if (!existsSync(selectedCompose)) {
      throw usageError(`Compose file does not exist: ${selectedCompose}`);
    }
  } else if (composeCandidates.length > 1) {
    throw ambiguityError(
      `multiple Compose files found; select one with --compose: ${composeCandidates
        .map((item) => relative(root, item))
        .join(", ")}`,
      { composeCandidates },
    );
  } else {
    selectedCompose = composeCandidates[0] ?? join(root, "compose.yaml");
  }

  const detected = detectFramework(root);
  const tamaDirectory = join(root, "tama");
  if (existsSync(tamaDirectory) && lstatSync(tamaDirectory).isSymbolicLink()) {
    throw ownershipError(`refusing to use a symbolic-link Tama directory: ${tamaDirectory}`);
  }
  return {
    root,
    framework: detected.framework,
    frameworkEvidence: detected.evidence,
    composeCandidates,
    selectedCompose,
    composeExists: existsSync(selectedCompose),
    tamaDirectory,
  };
}
