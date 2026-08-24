// @ts-check

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { buildInventory } from "../../skills/graph-builder/scripts/inspect-tama-repository.mjs";

import { ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";
import { renderTemplate } from "./templates.mjs";

/** @typedef {import("../types.mjs").TerraformPlan} TerraformPlan */
/** @typedef {import("../types.mjs").TerraformVersions} TerraformVersions */
/** @typedef {{name: string, source: string | null, file?: string}} ModuleCall */

/**
 * @typedef {object} JsonTerraformInventory
 * @property {ModuleCall[]} moduleCalls
 * @property {boolean} hasTamaResources
 */

/** @param {string} directory @returns {string[]} */
function terraformFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")),
    )
    .map((entry) => join(directory, entry.name));
}

/** @param {ModuleCall} call */
function isTamaFoundationCall(call) {
  return call.source?.replace(/^registry\.terraform\.io\//u, "") === "upmaru/base/tama";
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function mapping(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {string[]} files @returns {JsonTerraformInventory} */
function inspectTerraformJson(files) {
  /** @type {ModuleCall[]} */
  const moduleCalls = [];
  let hasTamaResources = false;

  for (const filename of files.filter((item) => item.endsWith(".tf.json"))) {
    let configuration;
    try {
      configuration = JSON.parse(readFileSync(filename, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw ownershipError(`cannot inspect Terraform JSON configuration ${filename}: ${message}`, {
        path: filename,
      });
    }

    const root = mapping(configuration);
    if (!root) {
      throw ownershipError(`Terraform JSON configuration must contain an object: ${filename}`, {
        path: filename,
      });
    }

    const modules = mapping(root.module);
    if (modules) {
      for (const [name, rawCall] of Object.entries(modules)) {
        const call = mapping(rawCall);
        moduleCalls.push({
          name,
          source: typeof call?.source === "string" ? call.source : null,
          file: filename,
        });
      }
    }

    for (const blockType of ["resource", "data"]) {
      const blocks = mapping(root[blockType]);
      if (blocks && Object.keys(blocks).some((name) => name.startsWith("tama_"))) {
        hasTamaResources = true;
      }
    }
  }

  return { moduleCalls, hasTamaResources };
}

/** @param {string} directory @param {TerraformVersions} versions @returns {TerraformPlan} */
export function planTerraform(directory, versions) {
  const existingFiles = terraformFiles(directory);
  if (existingFiles.length === 0) {
    return {
      foundation: "created",
      operations: [
        operationForContent(
          join(directory, "main.tf"),
          renderTemplate("main.tf", { GLOBAL_MODULE_VERSION: versions.globalModuleVersion }),
        ),
        operationForContent(
          join(directory, "versions.tf"),
          renderTemplate("versions.tf", {
            TERRAFORM_VERSION: versions.terraformVersion,
            PROVIDER_VERSION: versions.providerVersion,
          }),
        ),
      ],
    };
  }

  const inventory = buildInventory(directory, { recursive: false });
  const jsonInventory = inspectTerraformJson(existingFiles);
  const foundationCalls = [
    .../** @type {ModuleCall[]} */ (inventory.declared.module_calls),
    ...jsonInventory.moduleCalls,
  ].filter(isTamaFoundationCall);
  if (foundationCalls.length > 1) {
    throw ownershipError(
      `multiple Tama global foundations found in existing Terraform root: ${directory}`,
      { moduleCalls: foundationCalls },
    );
  }
  if (foundationCalls.length === 1) {
    return { foundation: "preserved", operations: [] };
  }

  const sources = existingFiles.map((filename) => readFileSync(filename, "utf8")).join("\n");
  const referencesGlobal = /\bmodule\.global\b/u.test(sources);
  const hasTamaResources =
    /\b(?:resource|data)\s+"tama_/u.test(sources) || jsonInventory.hasTamaResources;
  throw ownershipError(
    referencesGlobal || hasTamaResources
      ? `existing Terraform configuration needs a global foundation, but its ownership is unknown: ${directory}`
      : `existing Terraform root has no Tama global foundation; ownership must be declared before bootstrap: ${directory}`,
    { path: directory, warnings: inventory.warnings },
  );
}
