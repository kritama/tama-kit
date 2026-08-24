// @ts-check

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { buildInventory } from "../../skills/graph-builder/scripts/inspect-tama-repository.mjs";

import { ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";
import { renderTemplate } from "./templates.mjs";

/** @typedef {import("../types.mjs").TerraformPlan} TerraformPlan */
/** @typedef {import("../types.mjs").TerraformVersions} TerraformVersions */
/** @typedef {{name: string, source: string | null}} ModuleCall */

/** @param {string} directory @returns {string[]} */
function terraformFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
    .map((entry) => join(directory, entry.name));
}

/** @param {ModuleCall} call */
function isTamaFoundationCall(call) {
  return call.source?.replace(/^registry\.terraform\.io\//u, "") === "upmaru/base/tama";
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
  const foundationCalls = /** @type {ModuleCall[]} */ (
    inventory.declared.module_calls
  ).filter(isTamaFoundationCall);
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
  const referencesGlobal = inventory.global_foundation.module_global_reference_count > 0;
  const hasTamaResources = /\b(?:resource|data)\s+"tama_/u.test(sources);
  throw ownershipError(
    referencesGlobal || hasTamaResources
      ? `existing Terraform configuration needs a global foundation, but its ownership is unknown: ${directory}`
      : `existing Terraform root has no Tama global foundation; ownership must be declared before bootstrap: ${directory}`,
    { path: directory, warnings: inventory.warnings },
  );
}
