// @ts-check

export { MANAGED_MARKER } from "../shared/files.mjs";
export const BOOTSTRAP_SCHEMA_VERSION = 1;

export const BOOTSTRAP_PATHS = Object.freeze({
  tamaDirectory: "tama",
  environment: "tama/.tama.env",
  postgresEnvironment: "tama/.tama.postgres.env",
  environmentExample: "tama/.tama.env.example",
  manifest: "tama/.tama-kit.json",
  compose: "tama/compose.yaml",
  mcpAppLocalContract: "tama/contracts/mcp-app-provider-v1.json",
});

export const DEFAULTS = Object.freeze({
  port: 4000,
  containerPort: 4000,
  tamaImage: "ghcr.io/upmaru/tama:latest",
  mcpAppTamaImage: "ghcr.io/upmaru/tama:0.13.2-server",
  postgresImage: "pgvector/pgvector:0.8.6-pg15-bookworm",
  caddyImage: "caddy:2.10.2-alpine",
  terraformVersion: ">= 1.0.0",
  providerVersion: "~> 0.6.3",
  globalModuleVersion: "0.5.6",
});

export const COMPOSE_FILENAMES = Object.freeze([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
]);
