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
  constructor(message, { category = "execution", exitCode = EXIT_CODES.EXECUTION, details } = {}) {
    super(message);
    this.name = "CLIError";
    this.category = category;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(message) {
  return new CLIError(message, { category: "usage", exitCode: EXIT_CODES.USAGE });
}

export function ambiguityError(message, details) {
  return new CLIError(message, {
    category: "ambiguity",
    exitCode: EXIT_CODES.AMBIGUITY,
    details,
  });
}

export function ownershipError(message, details) {
  return new CLIError(message, {
    category: "ownership",
    exitCode: EXIT_CODES.OWNERSHIP,
    details,
  });
}

export function prerequisiteError(message, details) {
  return new CLIError(message, {
    category: "prerequisite",
    exitCode: EXIT_CODES.PREREQUISITE,
    details,
  });
}

export function startupError(message, details) {
  return new CLIError(message, {
    category: "startup",
    exitCode: EXIT_CODES.STARTUP,
    details,
  });
}
