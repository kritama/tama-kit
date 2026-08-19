#!/usr/bin/env node

import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readObject,
  validatePublicExampleUrl,
  validateTemplateMatch,
  writeObject,
} from "./lib/mcp-config.mjs";

const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function configure(root, exampleUrl) {
  validatePublicExampleUrl(exampleUrl);

  const portalPath = join(root, "submission", "portal.json");
  const portal = readObject(portalPath);
  const mcpServer = portal.mcpServer;
  if (mcpServer === null || typeof mcpServer !== "object" || Array.isArray(mcpServer)) {
    throw new TypeError("submission/portal.json must contain an mcpServer object");
  }
  const template = mcpServer.templateMcpServerURL;
  if (typeof template !== "string") {
    throw new TypeError("mcpServer.templateMcpServerURL must be a string");
  }
  validateTemplateMatch(template, exampleUrl);

  mcpServer.exampleMcpServerURL = exampleUrl;
  writeObject(portalPath, portal);
  console.log(`Configured Tama Kit's Example MCP Server URL: ${exampleUrl}`);
}

function usage() {
  return [
    "Usage: configure-mcp-plugin.mjs --example-url <url> [--root <path>]",
    "",
    "Configure Tama Kit's concrete Template MCP review endpoint.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "example-url": { type: "string" },
      root: { type: "string", default: ROOT_DEFAULT },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (!values["example-url"]) {
    throw new TypeError("--example-url is required");
  }
  configure(resolve(values.root), values["example-url"]);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
