// @ts-check

/** @typedef {"create" | "update"} WriteAction */
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

/** @typedef {WriteOperation | UnchangedOperation} FileOperation */

/**
 * @typedef {object} FileOperationOptions
 * @property {FileOwner} [owner]
 * @property {boolean} [sensitive]
 * @property {number} [mode]
 * @property {boolean} [allowUnmanagedUpdate]
 */

/** @typedef {"rails" | "phoenix" | "node" | "generic"} Framework */
/** @typedef {"local" | "manual"} AgentSkillMode */

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
 */

/**
 * @typedef {object} PublicChange
 * @property {WriteAction | UnchangedAction} action
 * @property {string} path
 * @property {FileOwner} owner
 * @property {boolean} sensitive
 * @property {string | null} beforeDigest
 * @property {string} afterDigest
 * @property {string} reason
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
