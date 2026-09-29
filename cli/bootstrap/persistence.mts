import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { prerequisiteError } from "../errors.mjs";
import type { ComposeModel, ComposeServiceModel } from "./compose-inspection.mjs";

/**
 * Read-only local persistence observations for secret-issuance safety.
 *
 * The inspection is restricted to relevant Tama database state: the
 * PostgreSQL service's named and bind-mounted data volumes under the
 * selected current project identity. Named volumes are checked under their
 * normalized names (explicit and external names respected through the native
 * model), running and stopped containers are treated as potentially used
 * writable layers, and every other application or TLS mount is ignored.
 */

export type PersistenceStatus = "absent" | "detected" | "unknown";

export type PersistenceObservation = {
  status: PersistenceStatus;
  /** Sanitized, human-readable fact; never container or volume contents. */
  detail: string;
  /** Volume names and bind paths that were inspected. */
  checked: string[];
};

export type PostgresDataSources = {
  service: string;
  /** Named volume sources with every Docker name that could hold their data. */
  volumes: { source: string; names: string[] }[];
  /** Absolute bind-mount data paths. */
  binds: string[];
};

const DATA_TARGET = /^\/var\/lib\/postgres/;

/**
 * Locate the PostgreSQL data sources in the native model. Returns null when
 * the selected configuration has no local PostgreSQL data mount (for
 * example an external database), which callers report as unknown.
 */
export function findPostgresDataSources(
  model: ComposeModel,
  services: ComposeServiceModel,
): PostgresDataSources | null {
  for (const [name, service] of Object.entries(services)) {
    const volumes: { source: string; names: string[] }[] = [];
    const binds: string[] = [];
    for (const mount of service.volumes ?? []) {
      if (!DATA_TARGET.test(mount.target)) continue;
      if (mount.type === "volume") {
        const declared = model.volumes?.[mount.source];
        const externalName =
          typeof declared?.external === "object" && declared.external?.name !== undefined
            ? declared.external.name
            : declared?.name;
        // Compose >= 2.24 uses declared names verbatim; older runtimes
        // project-prefixed them. Probe both so state is never missed.
        const names = new Set<string>();
        if (externalName !== undefined) names.add(externalName);
        names.add(mount.source);
        if (model.name !== undefined) names.add(`${model.name}_${mount.source}`);
        volumes.push({ source: mount.source, names: [...names] });
      } else if (mount.type === "bind") {
        binds.push(mount.source);
      }
    }
    if (volumes.length > 0 || binds.length > 0) {
      return { service: name, volumes, binds };
    }
  }
  return null;
}

type DockerExecute = (command: string, args: string[], options: ExecFileSyncOptions) => string;

/** @param {string} path @returns {boolean} whether the bind path holds data */
function bindHasData(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {{root: string, sources: PostgresDataSources, execute?: DockerExecute}} options
 * @returns {PersistenceObservation}
 */
export function inspectPersistence(options: {
  root: string;
  /** Compose project name from the native model; restricts container identity. */
  project?: string;
  sources: PostgresDataSources;
  execute?: DockerExecute;
}): PersistenceObservation {
  const execute: DockerExecute =
    options.execute ??
    ((command, args, opts) => execFileSync(command, args, { ...opts, encoding: "utf8" }));
  const checked: string[] = [];
  for (const volume of options.sources.volumes) checked.push(...volume.names);
  const run = (args: string[]): string | null => {
    try {
      return execute("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        throw prerequisiteError(
          "Docker is required to inspect local persistence before issuing new secrets",
        );
      }
      return null;
    }
  };
  if (run(["version"]) === null) {
    return {
      status: "unknown",
      detail: "the Docker daemon is unavailable, so local persistence was not verified",
      checked,
    };
  }
  for (const volume of options.sources.volumes) {
    // Missing volumes report nonzero status; existing ones inspect cleanly.
    // Existing volumes are conservatively treated as potentially used.
    for (const name of volume.names) {
      if (run(["volume", "inspect", name]) !== null) {
        return {
          status: "detected",
          detail: `local volume ${name} exists; it may hold database state`,
          checked,
        };
      }
    }
  }
  const containers = run([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${options.project ?? ""}`,
    "--filter",
    `label=com.docker.compose.service=${options.sources.service}`,
    "--format",
    "{{.Names}}",
  ]);
  if (
    containers
      ?.trim()
      .split(/\r?\n/u)
      .some((line) => line.trim())
  ) {
    return {
      status: "detected",
      detail: `a container for the ${options.sources.service} service exists (running or stopped); its writable layer may hold database state`,
      checked,
    };
  }
  for (const bind of options.sources.binds) {
    const path = isAbsolute(bind) ? bind : resolve(options.root, bind);
    checked.push(path);
    if (bindHasData(path)) {
      return {
        status: "detected",
        detail: `bind-mounted database directory ${path} contains data`,
        checked,
      };
    }
  }
  return {
    status: "absent",
    detail: "no local PostgreSQL volume, container, or bind data was found",
    checked,
  };
}
