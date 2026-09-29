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

/** Which database, if any, belongs to the selected Tama runtime. */
export type DatabaseAssociation =
  | { kind: "local"; sources: PostgresDataSources }
  | {
      kind: "none";
      detail: string;
    }
  | { kind: "ambiguous"; detail: string };

const DATA_TARGET = /^\/var\/lib\/postgres/;

function volumeNames(model: ComposeModel, source: string): string[] {
  const declared = model.volumes?.[source];
  const externalName =
    typeof declared?.external === "object" && declared.external?.name !== undefined
      ? declared.external.name
      : declared?.name;
  // Compose >= 2.24 uses declared names verbatim; older runtimes
  // project-prefixed them. Probe both so state is never missed.
  const names = new Set<string>();
  if (externalName !== undefined) names.add(externalName);
  names.add(source);
  if (model.name !== undefined) names.add(`${model.name}_${source}`);
  return [...names];
}

/** Data mounts of one service. Null when that service has no PostgreSQL data mount. */
export function postgresDataSources(
  model: ComposeModel,
  serviceName: string,
  service: ComposeServiceModel[string],
): PostgresDataSources | null {
  const volumes: { source: string; names: string[] }[] = [];
  const binds: string[] = [];
  for (const mount of service.volumes ?? []) {
    if (!DATA_TARGET.test(mount.target)) continue;
    if (mount.type === "volume") {
      volumes.push({ source: mount.source, names: volumeNames(model, mount.source) });
    } else if (mount.type === "bind") {
      binds.push(mount.source);
    }
  }
  if (volumes.length === 0 && binds.length === 0) return null;
  return { service: serviceName, volumes, binds };
}

/**
 * Locate PostgreSQL data mounts. Prefer {@link associateTamaDatabase}; this
 * returns the first match and must not authorize issuance by itself.
 */
export function findPostgresDataSources(
  model: ComposeModel,
  services: ComposeServiceModel,
): PostgresDataSources | null {
  for (const [name, service] of Object.entries(services)) {
    const sources = postgresDataSources(model, name, service);
    if (sources) return sources;
  }
  return null;
}

/**
 * Resolve the database that belongs to the selected Tama service.
 * Companion env files, depends_on, and the public DATABASE_URL host are
 * evidence. Unrelated services are never selected by declaration order, and
 * disagreeing evidence is refused instead of guessed.
 */
export function associateTamaDatabase(input: {
  model: ComposeModel;
  tamaService?: string;
  postgresServices: string[];
  databaseHost?: string;
}): DatabaseAssociation {
  const withData = new Map<string, PostgresDataSources>();
  for (const [name, service] of Object.entries(input.model.services)) {
    const sources = postgresDataSources(input.model, name, service);
    if (sources) withData.set(name, sources);
  }
  const evidenced = new Map<string, string[]>();
  const add = (name: string, reason: string) => {
    if (!withData.has(name)) return;
    const reasons = evidenced.get(name) ?? [];
    reasons.push(reason);
    evidenced.set(name, reasons);
  };
  for (const name of input.postgresServices) add(name, "PostgreSQL environment file");
  if (input.tamaService !== undefined) {
    for (const dependency of Object.keys(
      input.model.services[input.tamaService]?.depends_on ?? {},
    )) {
      add(dependency, "Tama service dependency");
    }
  }
  if (input.databaseHost !== undefined) {
    const effective = withData.get(input.databaseHost);
    if (!effective) {
      // An explicit external or non-mounted host is the selected database.
      // Stale companion volumes must not be reported as verified-absent.
      return {
        kind: "none",
        detail: `the effective database host is not a local PostgreSQL data service; local volumes were not treated as its persistence`,
      };
    }
    const disagreeing = [...evidenced.keys()].filter((name) => name !== input.databaseHost);
    if (disagreeing.length > 0) {
      return {
        kind: "ambiguous",
        detail: `the effective database host ${input.databaseHost} disagrees with other associated databases (${disagreeing.join(", ")}); refusing to guess`,
      };
    }
    return { kind: "local", sources: effective };
  }
  const names = [...evidenced.keys()];
  if (names.length === 1) {
    const sources = withData.get(names[0]);
    if (sources) return { kind: "local", sources };
  }
  if (names.length > 1) {
    return {
      kind: "ambiguous",
      detail: `multiple databases could belong to the selected Tama runtime (${names.join(", ")}); refusing to guess`,
    };
  }
  if (withData.size > 0) {
    return {
      kind: "ambiguous",
      detail:
        "local PostgreSQL data mounts exist, but none is associated with the selected Tama service through its environment file, dependency, or DATABASE_URL host",
    };
  }
  return {
    kind: "none",
    detail:
      "the selected configuration has no local PostgreSQL data mount; the database may be external and was not inspected",
  };
}

type DockerExecute = (command: string, args: string[], options: ExecFileSyncOptions) => string;

/** Confirmed empty, confirmed data, or an unreadable path. ENOENT is empty. */
function bindState(path: string): "data" | "empty" | "unreadable" {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.size > 0 ? "data" : "empty";
    return readdirSync(path).length > 0 ? "data" : "empty";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? "empty" : "unreadable";
  }
}

type ProbeResult =
  | { status: "ok"; output: string }
  | { status: "missing" }
  | { status: "unavailable"; detail: string };

function probeText(error: unknown): string {
  if (!(error instanceof Error)) return "inspection failed";
  const stderr = "stderr" in error && error.stderr != null ? String(error.stderr) : "";
  return `${error.message}\n${stderr}`;
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
  const probe = (args: string[]): ProbeResult => {
    try {
      return {
        status: "ok",
        output: execute("docker", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        throw prerequisiteError(
          "Docker is required to inspect local persistence before issuing new secrets",
        );
      }
      const text = probeText(error);
      // A nonzero `volume inspect` that names the missing object is the only
      // confirmed-absence signal. Permission and connection failures are not.
      if (/no such volume/iu.test(text)) return { status: "missing" };
      return { status: "unavailable", detail: "a Docker persistence probe failed" };
    }
  };
  // Filesystem binds are independent of the daemon. Collect every
  // observation before choosing a status so one failed probe cannot hide
  // data that was successfully observed elsewhere.
  const observations: { status: "detected" | "unknown"; detail: string }[] = [];
  for (const bind of options.sources.binds) {
    const path = isAbsolute(bind) ? bind : resolve(options.root, bind);
    checked.push(path);
    const state = bindState(path);
    if (state === "data") {
      observations.push({
        status: "detected",
        detail: `bind-mounted database directory ${path} contains data`,
      });
    } else if (state === "unreadable") {
      observations.push({
        status: "unknown",
        detail: `bind-mounted database directory ${path} could not be read`,
      });
    }
  }
  if (probe(["version"]).status !== "ok") {
    observations.push({
      status: "unknown",
      detail: "the Docker daemon is unavailable, so named volumes and containers were not verified",
    });
  } else {
    for (const volume of options.sources.volumes) {
      for (const name of volume.names) {
        const result = probe(["volume", "inspect", name]);
        if (result.status === "ok") {
          observations.push({
            status: "detected",
            detail: `local volume ${name} exists; it may hold database state`,
          });
        } else if (result.status === "unavailable") {
          observations.push({
            status: "unknown",
            detail: `a volume probe failed for ${name}, so its absence was not verified`,
          });
        }
      }
    }
    const containers = probe([
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${options.project ?? ""}`,
      "--filter",
      `label=com.docker.compose.service=${options.sources.service}`,
      "--format",
      "{{.Names}}",
    ]);
    if (containers.status === "unavailable") {
      observations.push({
        status: "unknown",
        detail: "a container probe failed, so absence of local database state was not verified",
      });
    } else if (
      containers.status === "ok" &&
      containers.output
        .trim()
        .split(/\r?\n/u)
        .some((line) => line.trim())
    ) {
      observations.push({
        status: "detected",
        detail: `a container for the ${options.sources.service} service exists (running or stopped); its writable layer may hold database state`,
      });
    }
  }
  const detected = observations.find((observation) => observation.status === "detected");
  if (detected) return { status: "detected", detail: detected.detail, checked };
  const unknown = observations.find((observation) => observation.status === "unknown");
  if (unknown) return { status: "unknown", detail: unknown.detail, checked };
  return {
    status: "absent",
    detail: "no local PostgreSQL volume, container, or bind data was found",
    checked,
  };
}
