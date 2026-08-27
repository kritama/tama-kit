#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  placeholderNames,
  validatePublicExampleUrl,
  validateTemplateMatch,
} from "./lib/mcp-config.mjs";

const CATEGORIES = new Set([
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
]);
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SubmissionError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireCondition(condition, message) {
  if (!condition) {
    throw new SubmissionError(message);
  }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SubmissionError(`Cannot read valid JSON from ${path}: ${error.message}`);
  }
}

function requireText(value, field, maximum, { oneLine = true } = {}) {
  requireCondition(
    typeof value === "string" && value.trim() === value && value.length > 0,
    `${field} must be non-empty text`,
  );
  requireCondition(
    value.length <= maximum,
    `${field} must be ${maximum} characters or fewer (found ${value.length})`,
  );
  if (oneLine) {
    requireCondition(!/[\r\n]/u.test(value), `${field} must fit on one line`);
  }
  return value;
}

function requireHttpsUrl(value, field) {
  const text = requireText(value, field, 1024);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new SubmissionError(`${field} must be a public HTTPS URL`);
  }
  requireCondition(
    parsed.protocol === "https:" && Boolean(parsed.hostname),
    `${field} must be a public HTTPS URL`,
  );
  requireCondition(!parsed.username && !parsed.password, `${field} must not embed credentials`);
}

function attributeValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, "su"));
  return match?.[2];
}

function parseSvgDimensions(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SubmissionError(`Cannot parse SVG ${path}: ${error.message}`);
  }
  const root = text.match(/<svg\b([^>]*)>/su);
  requireCondition(root !== null, `${path} must have an <svg> root`);

  const viewBox = attributeValue(root[1], "viewBox");
  let width;
  let height;
  if (viewBox) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    requireCondition(
      values.length === 4 && values.every(Number.isFinite),
      `${path} viewBox must contain four numbers`,
    );
    width = values[2];
    height = values[3];
  } else {
    const widthText = attributeValue(root[1], "width") ?? "";
    const heightText = attributeValue(root[1], "height") ?? "";
    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
    requireCondition(numeric.test(widthText), `${path} width must be numeric and unitless`);
    requireCondition(numeric.test(heightText), `${path} height must be numeric and unitless`);
    width = Number(widthText);
    height = Number(heightText);
  }

  requireCondition(width >= 48 && height >= 48, `${path} must be at least 48x48`);
  requireCondition(width === height, `${path} must be square (found ${width}x${height})`);
  return [width, height];
}

function validateAsset(root, value, field) {
  const text = requireText(value, field, 2048);
  requireCondition(text.startsWith("./"), `${field} must start with ./`);
  const parts = text.slice(2).split("/");
  requireCondition(
    !parts.includes("..") && !parts.includes("") && !text.slice(2).startsWith("/"),
    `${field} must stay inside the plugin`,
  );
  const path = join(root, ...parts);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new SubmissionError(`${field} must reference a regular packaged file`);
  }
  requireCondition(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `${field} must reference a regular packaged file`,
  );
  const suffix = extname(path).toLowerCase();
  requireCondition(IMAGE_SUFFIXES.has(suffix), `${field} uses an unsupported image type`);
  requireCondition(metadata.size <= 5 * 1024 * 1024, `${field} must not exceed 5 MiB`);
  if (suffix === ".svg") {
    parseSvgDimensions(path);
  }
}

function validateManifest(root) {
  const manifest = readJson(join(root, ".codex-plugin", "plugin.json"));
  const packageJson = readJson(join(root, "package.json"));
  requireCondition(isObject(manifest), "Plugin manifest must contain a JSON object");
  requireCondition(isObject(packageJson), "package.json must contain a JSON object");

  const name = requireText(manifest.name, "name", 64);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name), "name has unsupported characters");
  const version = requireText(manifest.version, "version", 64);
  requireCondition(SEMVER.test(version), "version must use semantic versioning");
  requireCondition(
    packageJson.version === version,
    "package.json and plugin manifest versions must match",
  );
  requireCondition(
    packageJson.name === `@kritama/${name}`,
    "npm package name must match the plugin name under the @kritama scope",
  );
  requireCondition(packageJson.license === "Apache-2.0", "package.json license must be Apache-2.0");
  requireCondition(
    !("mcpServers" in manifest) && !existsSync(join(root, ".mcp.json")),
    "Platform submission configures the Template MCP URL instead of bundling MCP configuration",
  );

  const pluginInterface = manifest.interface;
  requireCondition(isObject(pluginInterface), "interface must contain a JSON object");
  requireText(pluginInterface.displayName, "interface.displayName", 30);
  requireText(pluginInterface.shortDescription, "interface.shortDescription", 30);
  requireText(pluginInterface.longDescription, "interface.longDescription", 4000, {
    oneLine: false,
  });
  requireText(pluginInterface.developerName, "interface.developerName", 80);
  requireCondition(CATEGORIES.has(pluginInterface.category), "interface.category is unsupported");

  const capabilities = pluginInterface.capabilities ?? [];
  requireCondition(
    Array.isArray(capabilities) && capabilities.length <= 20,
    "interface.capabilities must contain at most 20 entries",
  );
  capabilities.forEach((capability, index) => {
    requireText(capability, `interface.capabilities[${index}]`, 120);
  });

  const prompts = pluginInterface.defaultPrompt ?? [];
  requireCondition(
    Array.isArray(prompts) && prompts.length <= 3,
    "interface.defaultPrompt must contain at most three entries",
  );
  const normalizedPrompts = new Set();
  prompts.forEach((prompt, index) => {
    const promptText = requireText(prompt, `interface.defaultPrompt[${index}]`, 128);
    requireCondition(
      !promptText.includes("@"),
      `interface.defaultPrompt[${index}] must not contain an app @mention`,
    );
    const normalized = promptText.trim().split(/\s+/u).join(" ").toLowerCase();
    requireCondition(
      !normalizedPrompts.has(normalized),
      "interface.defaultPrompt entries must be unique",
    );
    normalizedPrompts.add(normalized);
  });

  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) {
    if (field in pluginInterface) {
      requireHttpsUrl(pluginInterface[field], `interface.${field}`);
    }
  }
  validateAsset(root, pluginInterface.logo, "interface.logo");
  validateAsset(root, pluginInterface.composerIcon, "interface.composerIcon");
  return [manifest, packageJson];
}

function validateCaseText(testCase, field, caseId) {
  requireText(testCase[field], `${caseId}.${field}`, 4000, { oneLine: false });
}

function validateMarketplace(root, manifest, packageJson) {
  const marketplace = readJson(join(root, ".agents", "plugins", "marketplace.json"));
  requireCondition(isObject(marketplace), "marketplace.json must contain a JSON object");
  requireCondition(Array.isArray(marketplace.plugins), "marketplace plugins must be a list");
  const matching = marketplace.plugins.filter(
    (entry) => isObject(entry) && entry.name === manifest.name,
  );
  requireCondition(matching.length === 1, "marketplace must contain exactly one plugin-name match");
  const source = matching[0].source;
  requireCondition(isObject(source), "marketplace source must be an object");
  requireCondition(source.source === "npm", "marketplace source must use npm");
  requireCondition(
    source.package === packageJson.name,
    "marketplace npm package must match package.json",
  );
  requireCondition(source.registry === "https://registry.npmjs.org", "npm registry is unsupported");
  const policy = matching[0].policy;
  requireCondition(isObject(policy), "marketplace policy must be an object");
  requireCondition(policy.installation === "AVAILABLE", "plugin must be available to install");
  requireCondition(
    policy.authentication === "ON_INSTALL",
    "plugin authentication must run on install",
  );
  requireCondition(matching[0].category === "Developer Tools", "marketplace category must match");
}

function validateSkillLayout(root) {
  const skillsRoot = join(root, "skills");
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
  requireCondition(
    names.length === 2 && names.includes("graph-builder") && names.includes("graph-audit"),
    "packaged skills must be exactly graph-builder and graph-audit",
  );
  for (const name of names) {
    const skillText = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
    requireCondition(
      new RegExp(`^name:\\s*${name}\\s*$`, "mu").test(skillText),
      `skills/${name}/SKILL.md name must match its folder`,
    );
    const agentText = readFileSync(join(skillsRoot, name, "agents", "openai.yaml"), "utf8");
    requireCondition(
      agentText.includes(`$${name}`),
      `skills/${name}/agents/openai.yaml must invoke $${name}`,
    );
  }
  return new Set(names);
}

function validateTemplateMcp(root, portal, manifest, reviewReady) {
  requireCondition(
    portal.submissionType === "MCP and Skills",
    "submissionType must be MCP and Skills",
  );
  const mcpServer = portal.mcpServer;
  requireCondition(isObject(mcpServer), "submission.mcpServer must be an object");
  requireCondition(mcpServer.urlMode === "Template", "mcpServer.urlMode must be Template");
  const template = requireText(
    mcpServer.templateMcpServerURL,
    "mcpServer.templateMcpServerURL",
    1024,
  );
  requireHttpsUrl(template, "mcpServer.templateMcpServerURL");
  const placeholders = placeholderNames(template);
  requireCondition(
    placeholders.length > 0,
    "Template MCP URL must contain at least one {name} placeholder",
  );
  requireCondition(
    placeholders.length === new Set(placeholders).size,
    "Template MCP URL placeholders must be unique",
  );
  requireCondition(
    template.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/gu, "workspace") === "https://workspace/mcp",
    "Tama Kit Template MCP URL must keep the deployment host variable and /mcp path",
  );
  requireCondition(
    mcpServer.authentication === "OAuth 2.1",
    "mcpServer.authentication must be OAuth 2.1",
  );
  requireCondition(
    !("registeredAppId" in mcpServer),
    "mcpServer must not contain an integration or registered app ID",
  );
  requireCondition(
    !("apps" in manifest),
    "plugin.json apps is for local registered connections, not Platform submission",
  );
  requireCondition(
    !existsSync(join(root, ".app.json")),
    ".app.json is for local registered connections, not Platform submission",
  );

  const exampleUrl = mcpServer.exampleMcpServerURL;
  if (reviewReady) {
    requireCondition(
      exampleUrl !== null && exampleUrl !== undefined,
      "Example MCP Server URL is not configured; run npm run configure:mcp",
    );
  }
  if (exampleUrl === null || exampleUrl === undefined) {
    return;
  }
  const exampleText = requireText(exampleUrl, "mcpServer.exampleMcpServerURL", 1024);
  try {
    validatePublicExampleUrl(exampleText);
    validateTemplateMatch(template, exampleText);
  } catch (error) {
    throw new SubmissionError(error.message);
  }
}

function validateEvals(root, manifest, skillNames, reviewReady) {
  const data = readJson(join(root, "evals", "cases.json"));
  requireCondition(isObject(data), "evals/cases.json must contain a JSON object");
  const positive = data.positive_cases;
  const negative = data.negative_cases;
  requireCondition(
    Array.isArray(positive) && positive.length >= 5,
    "At least five positive test cases are required",
  );
  requireCondition(
    Array.isArray(negative) && negative.length >= 3,
    "At least three negative test cases are required",
  );

  const seenIds = new Set();
  for (const testCase of positive) {
    requireCondition(isObject(testCase), "Each positive test case must be an object");
    const caseId = requireText(testCase.id, "positive case id", 120);
    requireCondition(!seenIds.has(caseId), `Duplicate test case id: ${caseId}`);
    seenIds.add(caseId);
    validateCaseText(testCase, "prompt", caseId);
    const skillName = requireText(testCase.skill, `${caseId}.skill`, 120);
    requireCondition(skillNames.has(skillName), `${caseId}.skill must name a packaged skill`);
    requireCondition(
      Array.isArray(testCase.expected_behavior) && testCase.expected_behavior.length > 0,
      `${caseId}.expected_behavior must be a non-empty list`,
    );
    testCase.expected_behavior.forEach((item, index) => {
      requireText(item, `${caseId}.expected_behavior[${index}]`, 1000, { oneLine: false });
    });
    validateCaseText(testCase, "expected_result_shape", caseId);
    validateCaseText(testCase, "fixture_data", caseId);
  }

  for (const testCase of negative) {
    requireCondition(isObject(testCase), "Each negative test case must be an object");
    const caseId = requireText(testCase.id, "negative case id", 120);
    requireCondition(!seenIds.has(caseId), `Duplicate test case id: ${caseId}`);
    seenIds.add(caseId);
    validateCaseText(testCase, "prompt", caseId);
    validateCaseText(testCase, "expected_behavior", caseId);
    validateCaseText(testCase, "reason", caseId);
  }

  const portal = readJson(join(root, "submission", "portal.json"));
  requireCondition(isObject(portal), "submission/portal.json must contain a JSON object");
  validateTemplateMcp(root, portal, manifest, reviewReady);
  requireCondition(isObject(portal.listing), "submission listing must be an object");
  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) {
    requireHttpsUrl(portal.listing[field], `submission.listing.${field}`);
  }
  validateCaseText(portal, "releaseNotes", "submission");

  const positiveIds = new Set(positive.map((testCase) => testCase.id));
  const negativeIds = new Set(negative.map((testCase) => testCase.id));
  const selectedPositive = portal.positiveCaseIds;
  const selectedNegative = portal.negativeCaseIds;
  requireCondition(
    Array.isArray(selectedPositive) && selectedPositive.length >= 5,
    "submission.positiveCaseIds must select at least five positive cases",
  );
  requireCondition(
    Array.isArray(selectedNegative) && selectedNegative.length >= 3,
    "submission.negativeCaseIds must select at least three negative cases",
  );
  selectedPositive.forEach((caseId, index) => {
    requireText(caseId, `submission.positiveCaseIds[${index}]`, 120);
  });
  selectedNegative.forEach((caseId, index) => {
    requireText(caseId, `submission.negativeCaseIds[${index}]`, 120);
  });
  requireCondition(
    selectedPositive.length === new Set(selectedPositive).size,
    "submission.positiveCaseIds must be unique",
  );
  requireCondition(
    selectedNegative.length === new Set(selectedNegative).size,
    "submission.negativeCaseIds must be unique",
  );
  requireCondition(
    selectedPositive.every((caseId) => positiveIds.has(caseId)),
    "submission.positiveCaseIds contains an unknown case",
  );
  requireCondition(
    selectedNegative.every((caseId) => negativeIds.has(caseId)),
    "submission.negativeCaseIds contains an unknown case",
  );
  return [positive.length, negative.length];
}

export function validateRepository(root, { reviewReady = false } = {}) {
  const resolvedRoot = resolve(root);
  const [manifest, packageJson] = validateManifest(resolvedRoot);
  validateMarketplace(resolvedRoot, manifest, packageJson);
  const skillNames = validateSkillLayout(resolvedRoot);
  const [positiveCount, negativeCount] = validateEvals(
    resolvedRoot,
    manifest,
    skillNames,
    reviewReady,
  );
  console.log(
    `Submission validation passed: ${manifest.name} ${manifest.version} ` +
      `(${positiveCount} positive, ${negativeCount} negative cases, ` +
      `review_ready=${String(reviewReady)})`,
  );
  return [manifest, packageJson];
}

function usage() {
  return "Usage: validate-submission.mjs [--review-ready] [root]";
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "review-ready": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return 0;
  }
  requireCondition(positionals.length <= 1, usage());
  const root = positionals[0] ?? ROOT_DEFAULT;
  validateRepository(root, { reviewReady: values["review-ready"] });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Submission validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
