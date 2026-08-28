// @ts-check

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { usageError } from "../errors.mjs";

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
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

/** @param {string} filename */
function read(filename) {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return "";
  }
}

/** @param {{cwd: string, targetPath?: string}} options */
export function inspectDevProject({ cwd, targetPath }) {
  const requested = resolve(cwd, targetPath ?? ".");
  if (!isDirectory(requested)) {
    throw usageError(`Tama source path is not a directory: ${requested}`);
  }
  const root = realpathSync(targetPath === undefined ? nearestGitRoot(requested) : requested);
  const mixFile = resolve(root, "mix.exs");
  const mixSource = read(mixFile);
  const signatures = [
    /defmodule Tama\.MixProject/u.test(mixSource),
    /\bapp:\s*:tama\b/u.test(mixSource),
    existsSync(resolve(root, "lib", "tama", "application.ex")),
    existsSync(resolve(root, "config", "dev.exs")),
  ];
  if (signatures.some((matched) => !matched)) {
    throw usageError(`not a Tama source repository: ${root}`);
  }
  const composeFile = resolve(root, "compose.yml");
  if (!existsSync(composeFile)) {
    throw usageError(`Tama source repository is missing compose.yml: ${root}`);
  }
  return { root, composeFile };
}
