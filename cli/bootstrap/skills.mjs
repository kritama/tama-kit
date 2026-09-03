// @ts-check

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @typedef {import("../types.mjs").FileOperation} FileOperation */

const SKILLS_ROOT = new URL("../../skills/", import.meta.url);
const SKILL_NAMES = ["app-integration", "graph-audit", "graph-builder", "tama-kit-cli"];

/**
 * @param {URL} directory
 * @param {string} relativeDirectory
 * @returns {Array<{path: string, content: string}>}
 */
function skillFiles(directory, relativeDirectory = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .flatMap((entry) => {
      const relativePath = join(relativeDirectory, entry.name);
      const source = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        return skillFiles(new URL(`${entry.name}/`, directory), relativePath);
      }
      if (!entry.isFile()) {
        throw new Error(`Tama Kit skill source must be a regular file: ${source.pathname}`);
      }
      return [{ path: relativePath, content: readFileSync(source, "utf8") }];
    });
}

/**
 * @param {string} root
 * @param {(filename: string, content: string) => FileOperation} planManagedFile
 * @returns {FileOperation[]}
 */
export function planAgentSkills(root, planManagedFile) {
  return SKILL_NAMES.flatMap((skillName) =>
    skillFiles(new URL(`${skillName}/`, SKILLS_ROOT)).map(({ path, content }) =>
      planManagedFile(join(root, ".agents", "skills", skillName, path), content),
    ),
  );
}
