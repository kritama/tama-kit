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
 * @property {string} [providerOrigin]
 * @property {string} [tamaOrigin]
 * @property {string[]} [allowedOrigins]
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
 * @property {string} providerOrigin
 * @property {string} tamaOrigin
 * @property {string} resource
 * @property {string[]} allowedOrigins
 * @property {string} introspectionClientId
 * @property {string} providerSigningKeyId
 * @property {string} introspectionSigningKeyId
 * @property {FileOperation[]} operations
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
 * @property {PublicMcpApp | null} mcpApp
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

export {};
