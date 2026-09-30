import {
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ownershipError, prerequisiteError, usageError } from "../errors.mjs";
import { composeArguments } from "../shared/compose.mjs";
import { contentDigest, inspectRegularFile } from "../shared/files.mjs";
import type { Framework } from "../types.mjs";
import { inspectProject } from "./detect-project.mjs";
import { validateComposePrerequisite } from "./start.mjs";

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

export type ComposeDeclarationVolume = {
  type: string;
  source: string;
  target: string;
};

export type ComposeDeclarationEnvFile = {
  path: string;
  required?: boolean;
  format?: string;
};

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

export type ComposeVolumeDeclaration = {
  name?: string;
  driver?: string;
  external?: { name?: string } | boolean;
  labels?: Record<string, string>;
};

/** Full native Compose model: project name, services and top-level volumes. */
export type ComposeModel = {
  name?: string;
  services: ComposeServiceModel;
  volumes?: Record<string, ComposeVolumeDeclaration>;
};

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
  /**
   * The declaration contained interpolation. Its effective path depends on
   * host environment state, so it is reported as unresolved and never
   * treated as a project-owned destination.
   */
  interpolated: boolean;
  /** The literal declaration exactly as written in Compose. */
  declaredPath: string;
};

export type ComposeDeclarationInspection = {
  root: string;
  composeFiles: string[];
  framework: Framework;
  frameworkEvidence: string[];
  /** Declaration-stage service model; effective values require the resolved configuration. */
  services: ComposeServiceModel;
  envReferences: ComposeEnvReference[];
  /** The fallback was required and a required env_file path remains interpolated. */
  interpolationLoss: boolean;
  /** Literal env_file declarations containing interpolation; reported, never resolved. */
  unresolvedInterpolation: string[];
};

export type ComposeLoadOptions = {
  noEnvResolution?: boolean;
  noInterpolation?: boolean;
};

export type ComposeExecute = (
  command: string,
  args: string[],
  options: ExecFileSyncOptions,
) => string;

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
export function loadComposeModel(
  root: string,
  composeFiles: string[],
  options: ComposeLoadOptions = {},
  execute: ComposeExecute = composeExecuter(),
): ComposeModel {
  try {
    let output: string;
    try {
      output = execute(
        "docker",
        [
          ...composeArguments({
            composeFile: composeFiles[0],
            runtime: { composeFiles },
          }),
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
    } catch (error) {
      // Compose 2.38 checks required env_file paths even with
      // --no-env-resolution. Its --no-interpolate render preserves the same
      // native merged declarations without requiring those private files.
      // Only fall back for that exact missing-file failure; other native
      // configuration errors must remain fatal and secret-free.
      const stderr =
        error !== null && typeof error === "object" && "stderr" in error ? error.stderr : null;
      if (
        !options.noEnvResolution ||
        options.noInterpolation ||
        typeof stderr !== "string" ||
        !/^env file [^\r\n]+ not found:/mu.test(stderr)
      ) {
        throw error;
      }
      const literal = loadComposeModel(
        root,
        composeFiles,
        { ...options, noInterpolation: true },
        execute,
      );
      const hasMissingRequired = Object.values(literal.services).some((service) =>
        service.env_file?.some(
          (reference) =>
            reference.required !== false &&
            inspectRegularFile(resolve(root, reference.path)) === null,
        ),
      );
      if (!hasMissingRequired) throw error;
      // The literal render also leaves other Compose variables unresolved.
      // Ports, volume sources and service settings must not be mistaken for
      // concrete declarations when deciding whether recovery is safe.
      const unresolvedOutsideEnvFiles = [
        literal.name,
        literal.volumes,
        ...Object.values(literal.services).flatMap((service) =>
          Object.entries(service)
            .filter(([key]) => key !== "env_file")
            .map(([, value]) => value),
        ),
      ].some((value) => /(?<!\$)\$(?:\{|[A-Za-z_])/u.test(JSON.stringify(value) ?? ""));
      if (unresolvedOutsideEnvFiles) throw error;
      return literal;
    }
    const model = JSON.parse(output) as {
      name?: unknown;
      services?: unknown;
      volumes?: unknown;
    };
    if (!model.services || typeof model.services !== "object" || Array.isArray(model.services))
      throw new Error();
    return {
      name: typeof model.name === "string" ? model.name : undefined,
      services: model.services as ComposeServiceModel,
      volumes:
        model.volumes && typeof model.volumes === "object" && !Array.isArray(model.volumes)
          ? (model.volumes as Record<string, ComposeVolumeDeclaration>)
          : undefined,
    };
  } catch {
    throw ownershipError(
      "Docker Compose configuration could not be resolved; check selected files, required variables and env_file paths. Raw output is suppressed because it may contain secrets.",
    );
  }
}

/** Service projection of one native Compose render. */
export function loadComposeConfig(
  root: string,
  composeFiles: string[],
  options: ComposeLoadOptions = {},
  execute: ComposeExecute = composeExecuter(),
): ComposeServiceModel {
  return loadComposeModel(root, composeFiles, options, execute).services;
}

/**
 * Resolve one service's environment with Compose's native env-file parser.
 * Missing core files are represented by non-secret markers for the variables
 * recovery will supply. This preserves layer order (including duplicates) and
 * detects overrides that depend on still-unknown generated values. Missing
 * unrelated files remain the caller's diagnosis; no runtime is started.
 */
export function loadComposeServiceEnvironment(
  inspection: ComposeDeclarationInspection,
  serviceName: string,
  recovery: { missingPaths: string[]; suppliedVariables: readonly string[] },
  execute: ComposeExecute = composeExecuter(),
): {
  values: Map<string, string>;
  unresolved: string[];
  sourceDigests: [string, string][];
} {
  let temporary: string | undefined;
  try {
    const service = inspection.services[serviceName];
    if (!service) throw new Error();
    const prefix = `tama_kit_unknown_${randomUUID()}_`;
    const markers = new Map(recovery.suppliedVariables.map((name) => [name, `${prefix}${name}`]));
    let replacement: string | undefined;
    if (recovery.missingPaths.length > 0) {
      temporary = mkdtempSync(join(tmpdir(), "tama-env-inspection-"));
      replacement = join(temporary, "missing.env");
      writeFileSync(
        replacement,
        [...markers].map(([name, value]) => `${name}=${value}`).join("\n"),
        { mode: 0o600 },
      );
    }
    const sources = new Set([...inspection.composeFiles, join(inspection.root, ".env")]);
    const envFiles: ComposeDeclarationEnvFile[] = [];
    for (const declaration of service.env_file ?? []) {
      const path = resolve(inspection.root, declaration.path);
      if (recovery.missingPaths.includes(path) && replacement) {
        envFiles.push({ path: replacement });
      } else if (inspectRegularFile(path)) {
        sources.add(path);
        envFiles.push({ ...declaration, path });
      }
    }
    const sourceDigests: [string, string][] = [...sources]
      .filter((path) => inspectRegularFile(path) !== null)
      .map((path) => [path, contentDigest(readFileSync(path, "utf8"))]);
    // Inline strings have already been interpolated by declaration inspection.
    // Escape dollars to prevent a second interpolation in this projection.
    const environment = Object.fromEntries(
      Object.entries(service.environment ?? {}).map(([name, value]) => [
        name,
        typeof value === "string" ? value.replaceAll("$", () => "$$") : value,
      ]),
    );
    const output = execute(
      "docker",
      ["compose", "--project-directory", inspection.root, "-f", "-", "config", "--format", "json"],
      {
        cwd: inspection.root,
        input: JSON.stringify({
          services: {
            runtime: { image: "scratch", env_file: envFiles, environment },
          },
        }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const resolved = (JSON.parse(output) as ComposeModel).services?.runtime;
    if (!resolved || resolved.env_file?.length) throw new Error();
    const values = new Map<string, string>();
    const unresolved: string[] = [];
    for (const [name, value] of Object.entries(resolved.environment ?? {})) {
      if (value === markers.get(name)) continue;
      if (typeof value === "string" && value.includes(prefix)) unresolved.push(name);
      // `compose config` doubles every dollar in its rendered output so the
      // configuration can be loaded again. Undo that transport escaping once;
      // native Compose has already parsed/interpolated the source env files.
      else values.set(name, value?.replaceAll("$$", () => "$") ?? "");
    }
    for (const [path, digest] of sourceDigests) {
      if (!inspectRegularFile(path) || contentDigest(readFileSync(path, "utf8")) !== digest)
        throw new Error();
    }
    return { values, unresolved, sourceDigests };
  } catch {
    throw ownershipError(
      "the selected Compose service environment could not be resolved safely; check its env_file declarations and inputs. Raw output is suppressed because it may contain secrets.",
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Declaration-stage inspection: normalized services plus deduplicated
 * environment references with their declaring services and required state.
 */
export function inspectComposeDeclarations(
  options: { cwd: string; targetPath?: string; composeFiles?: string[] },
  dependencies: {
    execute?: ComposeExecute;
    validatePrerequisite?: () => void;
  } = {},
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
  // The literal model preserves declarations exactly as written. It is the
  // authoritative source for interpolation detection: --no-env-resolution
  // still interpolates env_file paths from host environment state (an unset
  // variable becomes empty), so the primary model alone cannot distinguish
  // project destinations from host-dependent guesses.
  let declared = services;
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
    declared = services;
    for (const service of Object.values(services)) {
      if (
        service.env_file?.some(({ path, required }) => required !== false && path.includes("$"))
      ) {
        interpolationLoss = true;
      }
    }
  } else {
    try {
      declared = loadComposeConfig(
        selection.root,
        selection.composeFiles,
        { noEnvResolution: true, noInterpolation: true },
        execute,
      );
    } catch {
      declared = services;
    }
  }
  const references = new Map<string, ComposeEnvReference>();
  for (const [name, service] of Object.entries(services)) {
    const literal = declared[name]?.env_file ?? [];
    (service.env_file ?? []).forEach((declaration, index) => {
      const declaredPath = literal[index]?.path ?? declaration.path;
      const path = resolve(selection.root, declaration.path);
      const reference = references.get(path);
      if (reference) {
        if (!reference.services.includes(name)) reference.services.push(name);
        reference.required ||= declaration.required !== false;
        reference.interpolated ||= declaredPath.includes("$");
      } else {
        references.set(path, {
          path,
          relative: relative(selection.root, path),
          services: [name],
          required: declaration.required !== false,
          interpolated: declaredPath.includes("$"),
          declaredPath,
        });
      }
    });
  }
  return {
    root: selection.root,
    composeFiles: selection.composeFiles,
    framework: selection.framework,
    frameworkEvidence: selection.frameworkEvidence,
    services,
    envReferences: [...references.values()],
    interpolationLoss,
    unresolvedInterpolation: [
      ...new Set(
        [...references.values()]
          .filter((reference) => reference.interpolated)
          .map((reference) => reference.declaredPath),
      ),
    ],
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
