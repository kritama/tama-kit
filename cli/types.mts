import type { McpAppContract } from "./domain/contracts.mjs";

// Shared CLI contracts; runtime JSON is validated before entering these types.

export type WriteAction = "create" | "update";

export type DeleteAction = "delete";

export type UnchangedAction = "unchanged";

export type FileOwner = "tama-kit" | "user" | string;

export type WriteOperation = {
  action: WriteAction;
  path: string;
  content: string;
  owner: FileOwner;
  sensitive: boolean;
  mode?: number;
  beforeDigest: string | null;
  afterDigest: string;
  reason: string;
};

export type UnchangedOperation = {
  action: UnchangedAction;
  path: string;
  owner: FileOwner;
  sensitive: boolean;
  mode?: number;
  beforeDigest: string;
  afterDigest: string;
  reason: string;
};

export type DeleteOperation = {
  action: DeleteAction;
  path: string;
  owner: FileOwner;
  sensitive: boolean;
  mode?: number;
  beforeDigest: string;
  afterDigest: null;
  reason: string;
};

export type FileOperation = WriteOperation | DeleteOperation | UnchangedOperation;

export type FileOperationOptions = {
  owner?: FileOwner;
  sensitive?: boolean;
  mode?: number;
  allowUnmanagedUpdate?: boolean;
};

export type Framework = "rails" | "phoenix" | "node" | "generic";

export type AgentSkillMode = "local" | "manual";

export type McpAppMode = "disabled" | "prepared" | "enabled";

export type LocalHttpsTopology = {
  profile: "mcp-app-local-https";
  localDomain: string;
  providerHost: string;
  tamaHost: string;
  providerOrigin: string;
  tamaOrigin: string;
  resource: string;
  introspectionClientId: string;
  providerJwksUri: string;
  providerIntrospectionEndpoint: string;
  tamaJwksUri: string;
  healthUrl: string;
  providerUpstream: string;
  tamaUpstream: string;
  providerPort: number;
  tamaPort: number;
  httpsPort: number;
  certificateNames: string[];
  caddyImage: string;
  trustMechanism: string;
  allowedOrigins: string[];
};

export type EnvironmentLoadingEvidence = {
  status: "verified" | "unverified";
  mechanism: "direnv" | "compose-env-file" | null;
  evidencePath: string | null;
};

export type McpAppLocalContract = {
  schema_version: "1";
  kind: "tama-kit-mcp-app-local-provider-contract";
  compatibility_identifier: "tama-mcp-app-bootstrap-v1";
  scope: "local-development";
  source: {
    type: "generated" | "provider-contract";
    provider_contract_path: string | null;
    provider_contract_digest: string | null;
  };
  provider: { name: string; environment_prefix: string; environment_file: string };
  lifecycle: { modes: McpAppMode[] };
  bindings: Record<string, string>;
  public_endpoints: { authorization_server_metadata: string; jwks: string; introspection: string };
  environment_loading: {
    status: "verified" | "unverified";
    mechanism: "direnv" | "compose-env-file" | null;
    evidence_path: string | null;
  };
  topology?: {
    profile: "mcp-app-local-https";
    local_domain: string;
    provider_host: string;
    tama_host: string;
    provider_origin: string;
    tama_origin: string;
    resource: string;
    health_url: string;
    https_port: number;
    provider_port: number;
    certificate_names: string[];
    trust_mechanism: string;
    allowed_origins: string[];
  } | null;
};

export type ProviderIdentity = {
  name: string;
  environmentPrefix: string;
  environmentFile: string;
  source: "manifest" | "contract" | "flags" | "framework" | "git" | "directory";
};

export type ProviderBindings = {
  roles: Record<string, string>;
  source: "contract" | "conventional";
};

export type PersistedMcpAppProvider = {
  identity: ProviderIdentity;
  contractSource: "contract" | "conventional";
  contractPath: string | null;
  bindings: Record<string, string>;
  environmentLoading: "verified" | "unverified";
  environmentLoadingMechanism?: "direnv" | "compose-env-file" | null;
  environmentLoadingEvidencePath?: string | null;
  providerOrigin?: string;
  tamaOrigin?: string;
  allowedOrigins?: string[];
  localHttps?: LocalHttpsTopology | null;
  tamaImage?: string;
};

export type ResolvedMcpAppProvider = PersistedMcpAppProvider & {
  localContract: McpAppLocalContract;
  bindingSource: "contract" | "conventional";
  environmentLoadingMechanism: "direnv" | "compose-env-file" | null;
  environmentLoadingEvidencePath: string | null;
};

export type McpAppBootstrapOptions = {
  requested: boolean;
  contractPath?: string;
  providerName?: string;
  providerPrefix?: string;
  providerEnvironmentFile?: string;
  providerOrigin?: string;
  tamaOrigin?: string;
  allowedOrigins?: string[];
  localDomain?: string;
  acknowledgeLocalDomainRisk?: boolean;
  providerPort?: number;
  httpsPort?: number;
  installLocalCa?: boolean;
  migrateLocalHttps?: boolean;
  localHttps?: LocalHttpsTopology | null;
  activate: boolean;
  targetMode?: McpAppMode;
  providerMode?: McpAppMode;
  preserveEnabledProvider?: boolean;
  migrateProviderIdentity?: boolean;
  identitySource?: ProviderIdentity["source"];
};

export type McpAppEnvironmentInput = {
  variables: Record<string, string>;
  removeVariables?: string[];
  validation: McpAppEnvironmentValidation;
};

export type McpAppEnvironmentValidation = {
  mode: McpAppMode;
  resource: string;
  authorizationServerOrigin: string;
  serviceOrigin: string;
  allowedOrigins: string[];
  introspectionClientId: string;
  localHttps?: LocalHttpsTopology | null;
};

export type McpAppPrepared = {
  identity: ProviderIdentity;
  persisted: PersistedMcpAppProvider | null;
  contractPath: string | null;
  contractDocument: McpAppContract | null;
  allowedOrigins: string[];
  localHttps?: LocalHttpsTopology | null;
};

export type FrameworkDetection = {
  framework: Framework;
  evidence: string[];
};

export type BootstrapPlanOptions = {
  cwd: string;
  targetPath?: string;
  composePath?: string;
  port?: number;
  image?: string;
  skillMode?: AgentSkillMode;
  mcpApp?: McpAppBootstrapOptions;
  mcpAppPrepared?: McpAppPrepared | null;
  materializeSecrets?: boolean;
};

export type ProjectInspection = {
  root: string;
  framework: Framework;
  frameworkEvidence: string[];
  composeCandidates: string[];
  selectedCompose: string;
  composeExists: boolean;
  tamaDirectory: string;
};

export type EnvironmentPlan = {
  port: number;
  operation: FileOperation;
  postgresOperation: FileOperation;
};

export type TerraformVersions = {
  terraformVersion: string;
  providerVersion: string;
  globalModuleVersion: string;
};

export type TerraformPlan = {
  foundation: "created" | "preserved";
  operations: FileOperation[];
  localHttps?: LocalHttpsTopology | null;
  providerVersion: string | null;
  globalModuleVersion: string | null;
};

export type McpAppPlan = {
  provider: ProviderIdentity;
  contractSource: "contract" | "conventional";
  contractPath: string | null;
  bindings: ProviderBindings;
  lifecycle: McpAppMode;
  providerLifecycle: McpAppMode;
  environmentLoading: "verified" | "unverified";
  environmentLoadingMechanism: "direnv" | "compose-env-file" | null;
  environmentLoadingEvidencePath: string | null;
  localContract?: McpAppLocalContract;
  localContractOperation?: FileOperation;
  providerOrigin: string;
  tamaOrigin: string;
  resource: string;
  allowedOrigins: string[];
  introspectionClientId: string;
  providerSigningKeyId: string;
  introspectionSigningKeyId: string;
  operations: FileOperation[];
  localHttps?: LocalHttpsTopology | null;
};

export type McpAppProbe = {
  name: string;
  ok: boolean;
  reason: string | null;
};

export type McpAppVerification = {
  mode: McpAppMode;
  probes: McpAppProbe[];
  providerReachable: boolean;
  tamaReachable: boolean;
  verified: boolean;
};

export type BootstrapPlan = {
  schemaVersion: number;
  root: string;
  framework: Framework;
  frameworkEvidence: string[];
  composeFile: string;
  port: number;
  tamaImage: string;
  postgresImage: string;
  skillMode: AgentSkillMode;
  terraform: {
    foundation: "created" | "preserved";
    providerVersion: string | null;
    globalModuleVersion: string | null;
  };
  operations: FileOperation[];
  mcpApp: McpAppPlan | null;
  mcpAppVerification: McpAppVerification | null;
  localHttps: LocalHttpsTopology | null;
};

export type PublicChange = {
  action: WriteAction | DeleteAction | UnchangedAction;
  path: string;
  owner: FileOwner;
  sensitive: boolean;
  beforeDigest: string | null;
  afterDigest: string | null;
  reason: string;
};

export type PublicMcpApp = {
  compatibilityIdentifier: string;
  mode: McpAppMode;
  providerOrigin: string;
  tamaOrigin: string;
  resource: string;
  allowedOrigins: string[];
  jwksUri: string;
  introspectionEndpoint: string;
  introspectionClientId: string;
  providerSigningKeyId: string;
  introspectionSigningKeyId: string;
  environmentLoading: "verified" | "unverified";
  activated: boolean;
  providerActivationRequired: boolean;
  providerReachable: boolean;
  tamaReachable: boolean;
  verified: boolean;
  probes: McpAppProbe[];
};

export type PublicBootstrapPlan = {
  schemaVersion: number;
  root: string;
  framework: Framework;
  frameworkEvidence: string[];
  composeFile: string;
  port: number;
  tamaImage: string;
  postgresImage: string;
  skillMode: AgentSkillMode;
  terraform: {
    foundation: "created" | "preserved";
    providerVersion: string | null;
    globalModuleVersion: string | null;
  };
  changes: PublicChange[];
  provider: {
    name: string;
    environmentPrefix: string;
    environmentFile: string;
    identitySource: string;
    contractPath: string | null;
    mode: McpAppMode;
    modeVariable: string;
    environmentLoading: "verified" | "unverified";
  } | null;
  providerContract: {
    path: string;
    source: "generated" | "provider-contract";
    sourcePath: string | null;
    bindingSource: "contract" | "conventional";
    compatibilityIdentifier: string;
    environmentLoading: "verified" | "unverified";
    environmentLoadingMechanism: "direnv" | "compose-env-file" | null;
    environmentLoadingEvidencePath: string | null;
    action: WriteAction | DeleteAction | UnchangedAction;
  } | null;
  mcpApp: PublicMcpApp | null;
  localHttps: Record<string, unknown> | null;
};

export type BootstrapResult = PublicBootstrapPlan & {
  ok: true;
  mode: "dry-run" | "write";
  started: boolean;
  healthUrl: string | null;
  agentPrompt: string | null;
};

export type DevSetupPlan = {
  root: string;
  composeFile: string;
  postgresPort: number;
  tamaPort: number;
  environment: Map<string, string>;
  operations: FileOperation[];
};

export type CommandIO = {
  cwd: string;
  stdout: (message?: string) => void;
  stderr: (message?: string) => void;
  write?: (message: string) => void;
  prompt?: (question: string) => Promise<string>;
  interactive?: boolean;
  color?: boolean;
  columns?: number;
  includeErrorDetails?: boolean;
};

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type CLIErrorDetails = Record<string, unknown>;

export type BootstrapCommandOptions = {
  targetPath?: string;
  composePath?: string;
  port?: number;
  image?: string;
  skillMode?: AgentSkillMode;
  dryRun: boolean;
  start: boolean;
  json: boolean;
  noColor: boolean;
  help: boolean;
  mcpApp: boolean;
  mcpAppContract?: string;
  providerName?: string;
  providerPrefix?: string;
  providerEnvironmentFile?: string;
  providerOrigin?: string;
  localDomain?: string;
  acknowledgeLocalDomainRisk: boolean;
  providerPort?: number;
  installLocalCa: boolean;
  migrateLocalHttps: boolean;
  tamaOrigin?: string;
  allowedOrigins?: string[];
  activate: boolean;
  migrateProviderIdentity: boolean;
};

export type DevCommandOptions = {
  targetPath?: string;
  port?: number;
  postgresPort?: number;
  prepareOnly: boolean;
  dryRun: boolean;
  json: boolean;
  noColor: boolean;
  help: boolean;
};
