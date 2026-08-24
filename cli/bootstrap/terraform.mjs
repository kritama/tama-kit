import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { buildInventory } from "../../skills/graph-builder/scripts/inspect-tama-repository.mjs";

import { ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";
import { renderTemplate } from "./templates.mjs";

function terraformFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
    .map((entry) => join(directory, entry.name));
}

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

  const inventory = buildInventory(directory);
  if (inventory.global_foundation.status === "multiple") {
    throw ownershipError(
      `multiple Tama global foundations found in existing Terraform root: ${directory}`,
      { moduleCalls: inventory.global_foundation.module_calls },
    );
  }
  if (inventory.global_foundation.status === "present") {
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
