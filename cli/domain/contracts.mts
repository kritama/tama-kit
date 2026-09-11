import type { McpAppMode } from "../types.mjs";

export type ContractVariable = {
  required?: boolean;
  required_in?: McpAppMode[];
  // Existing validation deliberately compares String(format); do not narrow
  // the original JSON value beyond what the runtime validator guarantees.
  format?: unknown;
  exact_path?: string;
  same_origin_as?: string;
  derived_from?: string;
  derived_template?: string;
  migration_assertion?: boolean;
  max_bytes?: number;
  max_items?: number;
  initial_value?: string | string[];
  allowed_values?: string | string[];
  values?: string | string[];
  default?: string | string[];
  [extension: `x-${string}`]: unknown;
};

export type ContractProvider = {
  name: string;
  environment_prefix: string;
  environment_file: string;
};

/** Guarantees established by validateMcpAppContract, without normalizing JSON. */
export type McpAppContract = {
  schema_version: "1";
  compatibility_identifier: "tama-mcp-app-bootstrap-v1";
  lifecycle: {
    modes: McpAppMode[];
    default_production_mode: McpAppMode;
    configured_modes: McpAppMode[];
    enabled_modes: ["enabled"];
  };
  variables: Record<string, ContractVariable>;
  public_endpoints: Record<string, string>;
  availability: Record<McpAppMode, Record<string, boolean>>;
  local_development?: Record<string, string>;
  local_loopback: Record<string, string | string[]>;
  environment_loading?: { mechanism: string; loader: string; loads: string };
  cache_policy?: Record<string, string>;
  mode_gate_responses?: Partial<
    Record<McpAppMode, Record<string, { available: boolean } | { status: number; error?: string }>>
  >;
  [supported: `supported_${string}`]: string | undefined;
} & (
  | { provider: ContractProvider; bindings?: Record<string, string> }
  // Provider-less runtime contracts are not role-bound by the schema validator.
  | { provider?: undefined; bindings?: unknown }
);
