import type { BootstrapPlan } from "../types.mjs";

/** Invocation-local selection and observations, never persisted as desired configuration. */
export type RuntimeSelection = {
  composeFiles: string[];
  service: string;
  startServices?: string[];
  proxyService?: string;
  environmentFile?: string;
  caFile?: string;
  healthUrl: string;
  environment: Map<string, string>;
  modeSource?: { path: string; value: string };
};

export type InspectOptions = {
  cwd: string;
  targetPath?: string;
  composeFiles?: string[];
  service?: string;
  proxyService?: string;
  environmentFile?: string;
  contractPath?: string;
  providerService?: string;
  caFile?: string;
  /** Internal additive-generation baseline: pending contracts are validated by its writer. */
  discoverMcpContract?: boolean;
};

export type RuntimePlan = BootstrapPlan & { runtime: RuntimeSelection };
