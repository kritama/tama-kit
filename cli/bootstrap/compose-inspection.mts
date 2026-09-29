import {
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { relative, resolve } from "node:path";
import { ownershipError, prerequisiteError, usageError } from "../errors.mjs";
import { composeArguments } from "../shared/compose.mjs";
import { inspectRegularFile } from "../shared/files.mjs";
import { inspectProject } from "./detect-project.mjs";
import { validateComposePrerequisite } from "./start.mjs";
import type { Framework } from "../types.mjs";

/**
 * Reusable native Compose declaration inspection.
 *
 * Everything here is read-only, daemon-independent and never emits environment
 * values. Declarations come from `docker compose config --format json
 * --no-env-resolution` with a `--no-interpolate` fallback for Compose versions
 * that discard declarations; this module preserves native includes, override
 * order, path semantics and Compose tags and does not implement an
 * independent Compose merger.
 */

export type ComposeDeclarationPort = {
  target: number;
  published?: string;
  host_ip?: string;
  protocol?: string;
};

export type ComposeDeclarationVolume = { type: string; source: string; target: string };

export type ComposeDeclarationEnvFile = { path: string; required?: boolean };

export type ComposeDeclarationService = {
  image?: string;
  depends_on?: Record<string, unknown>;
  build?: { context?: string };
  environment?: Record<string, string | null>;
  env_file?: ComposeDeclarationEnvFile[];
  ports?: ComposeDeclarationPort[];
  volumes?: ComposeDeclarationVolume[];
};

export type ComposeServiceModel = Record<string, ComposeDeclarationService>;

/** A normalized, deduplicated private environment destination. */
export type ComposeEnvReference = {
  /** Resolved absolute destination. */
  path: string;
  /** Display path relative to the project root. */
  relative: string;
  /** Services declaring the destination, in composition order. */
  services: string[];
  /** Required unless every declaration is `required: false`. */
  required: boolean;
};

export type ComposeDeclarationInspection = {
  root: string;
  composeFiles: string[];
  framework: Framework;
  frameworkEvidence: string[];
  /** Declaration-stage service model; effective values require the resolved configuration. */
  services: ComposeServiceModel;
  envReferences: ComposeEnvReference[];
  /** The fallback was required and Compose still lost interpolated env_file paths. */
  interpolationLoss: boolean;
  /** env_file destinations still containing interpolation; reported, never resolved. */
  unresolvedInterpolation: string[];
};

export type ComposeLoadOptions = {
  noEnvResolution?: boolean;
  noInterpolation?: boolean;
};

export type ComposeExecute = (command: string, args: string[], options: ExecFileSyncOptions) => string;

export function composeExecuter(): ComposeExecute {
  return (command, args, options) =>
    execFileSync(command, args, options as ExecFileSyncOptionsWithStringEncoding);
}

/** Resolve the selected root and ordered Compose files without invoking Compose. */
export function resolveComposeSelection(options: {
  cwd: string;
  targetPath?: string;
  composeFiles?: string[];
}) {
  const inspection = inspectProject({
    cwd: options.cwd,
    targetPath: options.targetPath,
    composePath: options.composeFiles?.[0],
  });
  const root = inspection.root;
  const composeFiles = (options.composeFiles ?? [inspection.selectedCompose]).map((path) =>
    resolve(root, path),
  );
  for (const path of composeFiles)
    if (!inspectRegularFile(path)) throw usageError("selected Compose file is missing");
  return {
    root,
    composeFiles,
    framework: inspection.framework,
    frameworkEvidence: inspection.frameworkEvidence,
  };
}

/** One native `docker compose config` render; stderr and output never escape. */
export function loadComposeConfig(
  root: string,
  composeFiles: string[],
  options: ComposeLoadOptions = {},
  execute: ComposeExecute = composeExecuter(),
): ComposeServiceModel {
  try {
    const output = execute(
      "docker",
      [
        ...composeArguments({ composeFile: composeFiles[0], runtime: { composeFiles } }),
        "config",
        "--format",
        "json",
        ...(options.noEnvResolution ? ["--no-env-resolution"] : []),
        ...(options.noInterpolation ? ["--no-interpolate"] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const model = JSON.parse(output) as { services?: unknown };
    if (!model.services || typeof model.services !== "object" || Array.isArray(model.services))
      throw new Error();
    return model.services as ComposeServiceModel;
  } catch {
    throw ownershipError(
      "Docker Compose configuration could not be resolved; check selected files, required variables and env_file paths. Raw output is suppressed because it may contain secrets.",
    );
  }
}

/**
 * Declaration-stage inspection: normalized services plus deduplicated
 * environment references with their declaring services and required state.
 */
export function inspectComposeDeclarations(
  options: { cwd: string; targetPath?: string; composeFiles?: string[] },
  dependencies: { execute?: ComposeExecute; validatePrerequisite?: () => void } = {},
): ComposeDeclarationInspection {
  const execute = dependencies.execute ?? composeExecuter();
  (dependencies.validatePrerequisite ?? validateComposePrerequisite)();
  const selection = resolveComposeSelection(options);
  let services = loadComposeConfig(
    selection.root,
    selection.composeFiles,
    { noEnvResolution: true },
    execute,
  );
  let interpolationLoss = false;
  if (!Object.values(services).some((service) => service.env_file?.length)) {
    // Compose 2.x can discard env_file even with --no-env-resolution. Its
    // model-rendering path preserves declarations; effective values still come
    // from the separate, fully resolved native configuration.
    services = loadComposeConfig(
      selection.root,
      selection.composeFiles,
      { noEnvResolution: true, noInterpolation: true },
      execute,
    );
    for (const service of Object.values(services)) {
      if (service.env_file?.some(({ path }) => path.includes("$"))) {
        interpolationLoss = true;
      }
    }
  }
  const references = new Map<string, ComposeEnvReference>();
  for (const [name, service] of Object.entries(services)) {
    for (const declaration of service.env_file ?? []) {
      const path = resolve(selection.root, declaration.path);
      const reference = references.get(path);
      if (reference) {
        if (!reference.services.includes(name)) reference.services.push(name);
        reference.required ||= declaration.required !== false;
      } else {
        references.set(path, {
          path,
          relative: relative(selection.root, path),
          services: [name],
          required: declaration.required !== false,
        });
      }
    }
  }
  return {
    root: selection.root,
    composeFiles: selection.composeFiles,
    framework: selection.framework,
    frameworkEvidence: selection.frameworkEvidence,
    services,
    envReferences: [...references.values()],
    interpolationLoss,
    unresolvedInterpolation: [...references.values()]
      .filter((reference) => reference.path.includes("$"))
      .map((reference) => reference.relative),
  };
}

/**
 * The preflight guard shared with the fully resolved inspection: a Compose
 * version that cannot preserve interpolated env_file paths is a prerequisite
 * failure, never an incomplete configuration.
 */
export function requireInspectableDeclarations(inspection: ComposeDeclarationInspection) {
  if (inspection.interpolationLoss) {
    throw prerequisiteError(
      "this Docker Compose version cannot preserve interpolated env_file paths during inspection; upgrade Compose to a version that supports --no-env-resolution without discarding declarations",
    );
  }
}
