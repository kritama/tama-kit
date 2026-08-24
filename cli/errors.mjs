// @ts-check

/** @typedef {import("./types.mjs").CLIErrorDetails} CLIErrorDetails */
/** @typedef {import("./types.mjs").ExitCode} ExitCode */

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  EXECUTION: 1,
  USAGE: 2,
  AMBIGUITY: 3,
  OWNERSHIP: 4,
  PREREQUISITE: 5,
  STARTUP: 6,
});

export class CLIError extends Error {
  /**
   * @param {string} message
   * @param {{category?: string, exitCode?: ExitCode, details?: CLIErrorDetails}} [options]
   */
  constructor(message, { category = "execution", exitCode = EXIT_CODES.EXECUTION, details } = {}) {
    super(message);
    this.name = "CLIError";
    this.category = category;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** @param {string} message */
export function usageError(message) {
  return new CLIError(message, { category: "usage", exitCode: EXIT_CODES.USAGE });
}

/** @param {string} message @param {CLIErrorDetails} [details] */
export function ambiguityError(message, details) {
  return new CLIError(message, {
    category: "ambiguity",
    exitCode: EXIT_CODES.AMBIGUITY,
    details,
  });
}

/** @param {string} message @param {CLIErrorDetails} [details] */
export function ownershipError(message, details) {
  return new CLIError(message, {
    category: "ownership",
    exitCode: EXIT_CODES.OWNERSHIP,
    details,
  });
}

/** @param {string} message @param {CLIErrorDetails} [details] */
export function prerequisiteError(message, details) {
  return new CLIError(message, {
    category: "prerequisite",
    exitCode: EXIT_CODES.PREREQUISITE,
    details,
  });
}

/** @param {string} message @param {CLIErrorDetails} [details] */
export function startupError(message, details) {
  return new CLIError(message, {
    category: "startup",
    exitCode: EXIT_CODES.STARTUP,
    details,
  });
}
