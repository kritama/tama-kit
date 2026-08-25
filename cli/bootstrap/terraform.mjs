// @ts-check

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { buildInventory } from "../../skills/graph-builder/scripts/inspect-tama-repository.mjs";

import { ownershipError } from "../errors.mjs";
import { operationForContent } from "./files.mjs";
import { renderTemplate } from "./templates.mjs";

/** @typedef {import("../types.mjs").TerraformPlan} TerraformPlan */
/** @typedef {import("../types.mjs").TerraformVersions} TerraformVersions */
/** @typedef {{name: string, source: string | null, file?: string, declared_version?: string | null, installed_version?: string | null}} ModuleCall */
/** @typedef {(filename: string, content: string) => import("../types.mjs").FileOperation} ManagedFilePlanner */
/** @typedef {(filename: string) => boolean} ManagedFilePredicate */

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
      (entry) => entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json")),
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
          declared_version: typeof call?.version === "string" ? call.version : null,
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

/** @param {ReturnType<typeof buildInventory>} inventory */
function preservedProviderVersion(inventory) {
  const lock = inventory.provider_locks.find(
    (provider) =>
      provider.source === "registry.terraform.io/upmaru/tama" || provider.source === "upmaru/tama",
  );
  return lock?.constraints ?? lock?.version ?? null;
}

/**
 * @param {string} directory
 * @param {TerraformVersions} versions
 * @param {ManagedFilePlanner} [planManagedFile]
 * @param {ManagedFilePredicate} [isManagedFile]
 * @returns {TerraformPlan}
 */
export function planTerraform(
  directory,
  versions,
  planManagedFile = operationForContent,
  isManagedFile = () => false,
) {
  const existingFiles = terraformFiles(directory);
  if (existingFiles.length === 0) {
    return {
      foundation: "created",
      providerVersion: versions.providerVersion,
      globalModuleVersion: versions.globalModuleVersion,
      operations: [
        planManagedFile(
          join(directory, "main.tf"),
          renderTemplate("main.tf", { GLOBAL_MODULE_VERSION: versions.globalModuleVersion }),
        ),
        planManagedFile(
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
    const foundation = foundationCalls[0];
    const foundationFile = foundation.file ? resolve(directory, foundation.file) : null;
    const versionsFile = join(directory, "versions.tf");
    const managesFoundation = foundationFile ? isManagedFile(foundationFile) : false;
    const managesVersions = isManagedFile(versionsFile);
    const operations = [];
    if (foundationFile && managesFoundation) {
      const template =
        basename(foundationFile) === "tama-kit-global.tf" ? "global-module.tf" : "main.tf";
      operations.push(
        planManagedFile(
          foundationFile,
          renderTemplate(template, { GLOBAL_MODULE_VERSION: versions.globalModuleVersion }),
        ),
      );
    }
    if (managesVersions) {
      operations.push(
        planManagedFile(
          versionsFile,
          renderTemplate("versions.tf", {
            TERRAFORM_VERSION: versions.terraformVersion,
            PROVIDER_VERSION: versions.providerVersion,
          }),
        ),
      );
    }
    return {
      foundation: "preserved",
      providerVersion: managesVersions
        ? versions.providerVersion
        : preservedProviderVersion(inventory),
      globalModuleVersion: managesFoundation
        ? versions.globalModuleVersion
        : (foundation.declared_version ?? foundation.installed_version ?? null),
      operations,
    };
  }

  const referencesGlobal = inventory.declared.global_reference_count > 0;
  const reservesGlobalAddress = [
    .../** @type {ModuleCall[]} */ (inventory.declared.module_calls),
    ...jsonInventory.moduleCalls,
  ].some((call) => call.name === "global");
  const hasTamaResources =
    Object.keys(inventory.declared.block_counts).some(
      (name) => name.startsWith("resource.tama_") || name.startsWith("data.tama_"),
    ) || jsonInventory.hasTamaResources;
  if (referencesGlobal || reservesGlobalAddress || hasTamaResources) {
    throw ownershipError(
      `existing Terraform configuration needs a global foundation, but its ownership is unknown: ${directory}`,
      { path: directory, warnings: inventory.warnings },
    );
  }

  return {
    foundation: "created",
    providerVersion: null,
    globalModuleVersion: versions.globalModuleVersion,
    operations: [
      planManagedFile(
        join(directory, "tama-kit-global.tf"),
        renderTemplate("global-module.tf", {
          GLOBAL_MODULE_VERSION: versions.globalModuleVersion,
        }),
      ),
    ],
  };
}
