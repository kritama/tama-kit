// @ts-check

/** @typedef {"create" | "update"} WriteAction */
/** @typedef {"delete"} DeleteAction */
/** @typedef {"unchanged"} UnchangedAction */
/** @typedef {"tama-kit" | "user" | string} FileOwner */

/**
 * @typedef {object} WriteOperation
 * @property {WriteAction} action
 * @property {string} path
 * @property {string} content
 * @property {FileOwner} owner
 * @property {boolean} sensitive
 * @property {number} [mode]
 * @property {string | null} beforeDigest
 * @property {string} afterDigest
 * @property {string} reason
 */

/**
 * @typedef {object} UnchangedOperation
 * @property {UnchangedAction} action
 * @property {string} path
 * @property {FileOwner} owner
 * @property {boolean} sensitive
 * @property {number} [mode]
 * @property {string} beforeDigest
 * @property {string} afterDigest
 * @property {string} reason
 */

/**
 * @typedef {object} DeleteOperation
 * @property {DeleteAction} action
 * @property {string} path
 * @property {FileOwner} owner
 * @property {boolean} sensitive
 * @property {number} [mode]
 * @property {string} beforeDigest
 * @property {null} afterDigest
 * @property {string} reason
 */

/** @typedef {WriteOperation | DeleteOperation | UnchangedOperation} FileOperation */

/**
 * @typedef {object} FileOperationOptions
 * @property {FileOwner} [owner]
 * @property {boolean} [sensitive]
 * @property {number} [mode]
 * @property {boolean} [allowUnmanagedUpdate]
 */

/** @typedef {"rails" | "phoenix" | "node" | "generic"} Framework */
/** @typedef {"local" | "manual"} AgentSkillMode */
/** @typedef {"disabled" | "prepared" | "enabled"} McpAppMode */

/** @typedef {object} LocalHttpsTopology
 * @property {"mcp-app-local-https"} profile
 * @property {string} localDomain
 * @property {string} providerHost
 * @property {string} tamaHost
 * @property {string} providerOrigin
 * @property {string} tamaOrigin
 * @property {string} resource
 * @property {string} introspectionClientId
 * @property {string} providerJwksUri
 * @property {string} providerIntrospectionEndpoint
 * @property {string} tamaJwksUri
 * @property {string} healthUrl
 * @property {string} providerUpstream
 * @property {string} tamaUpstream
 * @property {number} providerPort
 * @property {number} tamaPort
 * @property {number} httpsPort
 * @property {string[]} certificateNames
 * @property {string} caddyImage
 * @property {string} trustMechanism
 * @property {string[]} allowedOrigins
 */

/**
 * @typedef {object} EnvironmentLoadingEvidence
 * @property {"verified" | "unverified"} status
 * @property {"direnv" | "compose-env-file" | null} mechanism
 * @property {string | null} evidencePath
 */

/**
 * @typedef {object} McpAppLocalContract
 * @property {"1"} schema_version
 * @property {"tama-kit-mcp-app-local-provider-contract"} kind
 * @property {"tama-mcp-app-bootstrap-v1"} compatibility_identifier
 * @property {"local-development"} scope
 * @property {{type: "generated" | "provider-contract", provider_contract_path: string | null, provider_contract_digest: string | null}} source
 * @property {{name: string, environment_prefix: string, environment_file: string}} provider
 * @property {{modes: McpAppMode[]}} lifecycle
 * @property {Record<string, string>} bindings
 * @property {{authorization_server_metadata: string, jwks: string, introspection: string}} public_endpoints
 * @property {{status: "verified" | "unverified", mechanism: "direnv" | "compose-env-file" | null, evidence_path: string | null}} environment_loading
 * @property {{profile: "mcp-app-local-https", local_domain: string, provider_host: string, tama_host: string, provider_origin: string, tama_origin: string, resource: string, health_url: string, https_port: number, provider_port: number, certificate_names: string[], trust_mechanism: string, allowed_origins: string[]} | null} [topology]
 */

/**
 * @typedef {object} ProviderIdentity
 * @property {string} name
 * @property {string} environmentPrefix
 * @property {string} environmentFile
 * @property {"manifest" | "contract" | "flags" | "framework" | "git" | "directory"} source
 */

/**
 * @typedef {object} ProviderBindings
 * @property {Record<string, string>} roles
 * @property {"contract" | "conventional"} source
 */

/**
 * @typedef {object} PersistedMcpAppProvider
 * @property {ProviderIdentity} identity
 * @property {"contract" | "conventional"} contractSource
 * @property {string | null} contractPath
 * @property {Record<string, string>} bindings
 * @property {"verified" | "unverified"} environmentLoading
 * @property {"direnv" | "compose-env-file" | null} [environmentLoadingMechanism]
 * @property {string | null} [environmentLoadingEvidencePath]
 * @property {string} [providerOrigin]
 * @property {string} [tamaOrigin]
 * @property {string[]} [allowedOrigins]
 * @property {LocalHttpsTopology | null} [localHttps]
 * @property {string} [tamaImage]
 */

/**
 * @typedef {PersistedMcpAppProvider & {
 *   localContract: McpAppLocalContract,
 *   bindingSource: "contract" | "conventional",
 *   environmentLoadingMechanism: "direnv" | "compose-env-file" | null,
 *   environmentLoadingEvidencePath: string | null,
 * }} ResolvedMcpAppProvider
 */

/**
 * @typedef {object} McpAppBootstrapOptions
 * @property {boolean} requested
 * @property {string} [contractPath]
 * @property {string} [providerName]
 * @property {string} [providerPrefix]
 * @property {string} [providerEnvironmentFile]
 * @property {string} [providerOrigin]
 * @property {string} [tamaOrigin]
 * @property {string[]} [allowedOrigins]
 * @property {string} [localDomain]
 * @property {boolean} [acknowledgeLocalDomainRisk]
 * @property {number} [providerPort]
 * @property {number} [httpsPort]
 * @property {boolean} [installLocalCa]
 * @property {boolean} [migrateLocalHttps]
 * @property {LocalHttpsTopology | null} [localHttps]
 * @property {boolean} activate
 * @property {McpAppMode} [targetMode]
 * @property {McpAppMode} [providerMode]
 * @property {boolean} [preserveEnabledProvider]
 * @property {boolean} [migrateProviderIdentity]
 * @property {ProviderIdentity["source"]} [identitySource]
 */

/**
 * @typedef {object} McpAppEnvironmentInput
 * @property {Record<string, string>} variables
 * @property {string[]} [removeVariables]
 * @property {McpAppEnvironmentValidation} validation
 */

/**
 * @typedef {object} McpAppEnvironmentValidation
 * @property {McpAppMode} mode
 * @property {string} resource
 * @property {string} authorizationServerOrigin
 * @property {string} serviceOrigin
 * @property {string[]} allowedOrigins
 * @property {string} introspectionClientId
 * @property {LocalHttpsTopology | null} [localHttps]
 */

/**
 * The command layer resolves and (when detected) interactively confirms the
 * provider identity before planning, because a non-interactive run must fail
 * on ambiguity before any plan is produced.
 *
 * @typedef {object} McpAppPrepared
 * @property {ProviderIdentity} identity
 * @property {PersistedMcpAppProvider | null} persisted
 * @property {string | null} contractPath
 * @property {Record<string, unknown> | null} contractDocument
 * @property {string[]} allowedOrigins
 * @property {LocalHttpsTopology | null} [localHttps]
 */

/**
 * @typedef {object} FrameworkDetection
 * @property {Framework} framework
 * @property {string[]} evidence
 */

/**
 * @typedef {object} BootstrapPlanOptions
 * @property {string} cwd
 * @property {string} [targetPath]
 * @property {string} [composePath]
 * @property {number} [port]
 * @property {string} [image]
 * @property {AgentSkillMode} [skillMode]
 * @property {McpAppBootstrapOptions} [mcpApp]
 * @property {McpAppPrepared | null} [mcpAppPrepared]
 * @property {boolean} [materializeSecrets]
 */

/**
 * @typedef {object} ProjectInspection
 * @property {string} root
 * @property {Framework} framework
 * @property {string[]} frameworkEvidence
 * @property {string[]} composeCandidates
 * @property {string} selectedCompose
 * @property {boolean} composeExists
 * @property {string} tamaDirectory
 */

/**
 * @typedef {object} EnvironmentPlan
 * @property {number} port
 * @property {FileOperation} operation
 * @property {FileOperation} postgresOperation
 */

/**
 * @typedef {object} TerraformVersions
 * @property {string} terraformVersion
 * @property {string} providerVersion
 * @property {string} globalModuleVersion
 */

/**
 * @typedef {object} TerraformPlan
 * @property {"created" | "preserved"} foundation
 * @property {FileOperation[]} operations
 * @property {LocalHttpsTopology | null} [localHttps]
 * @property {string | null} providerVersion
 * @property {string | null} globalModuleVersion
 */

/**
 * @typedef {object} McpAppPlan
 * @property {ProviderIdentity} provider
 * @property {"contract" | "conventional"} contractSource
 * @property {string | null} contractPath
 * @property {ProviderBindings} bindings
 * @property {McpAppMode} lifecycle
 * @property {McpAppMode} providerLifecycle
 * @property {"verified" | "unverified"} environmentLoading
 * @property {"direnv" | "compose-env-file" | null} environmentLoadingMechanism
 * @property {string | null} environmentLoadingEvidencePath
 * @property {McpAppLocalContract} [localContract]
 * @property {FileOperation} [localContractOperation]
 * @property {string} providerOrigin
 * @property {string} tamaOrigin
 * @property {string} resource
 * @property {string[]} allowedOrigins
 * @property {string} introspectionClientId
 * @property {string} providerSigningKeyId
 * @property {string} introspectionSigningKeyId
 * @property {FileOperation[]} operations
 * @property {LocalHttpsTopology | null} [localHttps]
 */

/**
 * @typedef {object} McpAppProbe
 * @property {string} name
 * @property {boolean} ok
 * @property {string | null} reason
 */

/**
 * @typedef {object} McpAppVerification
 * @property {McpAppMode} mode
 * @property {McpAppProbe[]} probes
 * @property {boolean} providerReachable
 * @property {boolean} tamaReachable
 * @property {boolean} verified
 */

/**
 * @typedef {object} BootstrapPlan
 * @property {number} schemaVersion
 * @property {string} root
 * @property {Framework} framework
 * @property {string[]} frameworkEvidence
 * @property {string} composeFile
 * @property {number} port
 * @property {string} tamaImage
 * @property {string} postgresImage
 * @property {AgentSkillMode} skillMode
 * @property {{foundation: "created" | "preserved", providerVersion: string | null, globalModuleVersion: string | null}} terraform
 * @property {FileOperation[]} operations
 * @property {McpAppPlan | null} mcpApp
 * @property {McpAppVerification | null} mcpAppVerification
 * @property {LocalHttpsTopology | null} localHttps
 */

/**
 * @typedef {object} PublicChange
 * @property {WriteAction | DeleteAction | UnchangedAction} action
 * @property {string} path
 * @property {FileOwner} owner
 * @property {boolean} sensitive
 * @property {string | null} beforeDigest
 * @property {string | null} afterDigest
 * @property {string} reason
 */

/**
 * @typedef {object} PublicMcpApp
 * @property {string} compatibilityIdentifier
 * @property {McpAppMode} mode
 * @property {string} providerOrigin
 * @property {string} tamaOrigin
 * @property {string} resource
 * @property {string[]} allowedOrigins
 * @property {string} jwksUri
 * @property {string} introspectionEndpoint
 * @property {string} introspectionClientId
 * @property {string} providerSigningKeyId
 * @property {string} introspectionSigningKeyId
 * @property {"verified" | "unverified"} environmentLoading
 * @property {boolean} activated
 * @property {boolean} providerActivationRequired
 * @property {boolean} providerReachable
 * @property {boolean} tamaReachable
 * @property {boolean} verified
 * @property {McpAppProbe[]} probes
 */

/**
 * @typedef {object} PublicBootstrapPlan
 * @property {number} schemaVersion
 * @property {string} root
 * @property {Framework} framework
 * @property {string[]} frameworkEvidence
 * @property {string} composeFile
 * @property {number} port
 * @property {string} tamaImage
 * @property {string} postgresImage
 * @property {AgentSkillMode} skillMode
 * @property {{foundation: "created" | "preserved", providerVersion: string | null, globalModuleVersion: string | null}} terraform
 * @property {PublicChange[]} changes
 * @property {{name: string, environmentPrefix: string, environmentFile: string, identitySource: string, contractPath: string | null, mode: McpAppMode, modeVariable: string, environmentLoading: "verified" | "unverified"} | null} provider
 * @property {{path: string, source: "generated" | "provider-contract", sourcePath: string | null, bindingSource: "contract" | "conventional", compatibilityIdentifier: string, environmentLoading: "verified" | "unverified", environmentLoadingMechanism: "direnv" | "compose-env-file" | null, environmentLoadingEvidencePath: string | null, action: WriteAction | DeleteAction | UnchangedAction} | null} providerContract
 * @property {PublicMcpApp | null} mcpApp
 * @property {Record<string, unknown> | null} localHttps
 */

/**
 * @typedef {PublicBootstrapPlan & {
 *   ok: true,
 *   mode: "dry-run" | "write",
 *   started: boolean,
 *   healthUrl: string | null,
 *   agentPrompt: string | null
 * }} BootstrapResult
 */

/**
 * @typedef {object} DevSetupPlan
 * @property {string} root
 * @property {string} composeFile
 * @property {number} postgresPort
 * @property {number} tamaPort
 * @property {Map<string, string>} environment
 * @property {FileOperation[]} operations
 */

/**
 * @typedef {object} CommandIO
 * @property {string} cwd
 * @property {(message?: string) => void} stdout
 * @property {(message?: string) => void} stderr
 * @property {(message: string) => void} [write]
 * @property {(question: string) => Promise<string>} [prompt]
 * @property {boolean} [interactive]
 * @property {boolean} [color]
 * @property {number} [columns]
 * @property {boolean} [includeErrorDetails]
 */

/** @typedef {0 | 1 | 2 | 3 | 4 | 5 | 6} ExitCode */
/** @typedef {Record<string, unknown>} CLIErrorDetails */

/**
 * @typedef {object} BootstrapCommandOptions
 * @property {string} [targetPath]
 * @property {string} [composePath]
 * @property {number} [port]
 * @property {string} [image]
 * @property {AgentSkillMode} [skillMode]
 * @property {boolean} dryRun
 * @property {boolean} start
 * @property {boolean} json
 * @property {boolean} noColor
 * @property {boolean} help
 * @property {boolean} mcpApp
 * @property {string} [mcpAppContract]
 * @property {string} [providerName]
 * @property {string} [providerPrefix]
 * @property {string} [providerEnvironmentFile]
 * @property {string} [providerOrigin]
 * @property {string} [localDomain]
 * @property {boolean} acknowledgeLocalDomainRisk
 * @property {number} [providerPort]
 * @property {boolean} installLocalCa
 * @property {boolean} migrateLocalHttps
 * @property {string} [tamaOrigin]
 * @property {string[]} [allowedOrigins]
 * @property {boolean} activate
 * @property {boolean} migrateProviderIdentity
 */

/**
 * @typedef {object} DevCommandOptions
 * @property {string} [targetPath]
 * @property {number} [port]
 * @property {number} [postgresPort]
 * @property {boolean} prepareOnly
 * @property {boolean} dryRun
 * @property {boolean} json
 * @property {boolean} noColor
 * @property {boolean} help
 */

export {};
