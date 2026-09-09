// @ts-check
import { ownershipError, usageError } from "../errors.mjs";
import { validateComposeDocument } from "./compose.mjs";
import { isPlainObject, safeRead } from "./contracts/files.mjs";
import { resolveLocalHttpsTopology } from "./local-https.mjs";

/** @param {unknown} value @param {string} name */
function rejectUnresolvedMerges(value, name) {
  const pending = [value];
  const visited = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    visited.add(item);
    if (Object.hasOwn(item, "<<")) {
      throw usageError(
        `provider service ${name} uses unresolved YAML merges; expand the inherited configuration in the selected root Compose file`,
      );
    }
    pending.push(...Object.values(item));
  }
}

/** @param {Record<string, unknown>} base @param {Record<string, unknown>} update */
function mergeComposeMapping(base, update) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(update)) {
    const current = merged[key];
    if (
      isPlainObject(current) &&
      isPlainObject(value) &&
      !Object.hasOwn(value, "<<") &&
      !Object.hasOwn(current, "<<")
    ) {
      merged[key] = mergeComposeMapping(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** @param {string | string[]} composeFiles @param {string} name */
function selectedServices(composeFiles, name) {
  const files = Array.isArray(composeFiles) ? composeFiles : [composeFiles];
  /** @type {Record<string, Record<string, unknown>>} */
  const services = {};
  for (const composeFile of files) {
    const content = safeRead(composeFile, 1024 * 1024);
    if (content === null)
      throw ownershipError(
        "provider Compose file must be a readable regular file of at most 1 MiB",
        { path: composeFile },
      );
    const document = validateComposeDocument(content, composeFile);
    const declared = isPlainObject(document.services) ? document.services : {};
    if (Object.hasOwn(declared, "<<")) rejectUnresolvedMerges(declared, name);
    for (const [serviceName, service] of Object.entries(declared)) {
      if (!isPlainObject(service)) continue;
      rejectUnresolvedMerges(service, serviceName);
      services[serviceName] = services[serviceName]
        ? mergeComposeMapping(services[serviceName], service)
        : service;
    }
  }
  return services;
}

/**
 * Resolve an application-owned service from the selected root Compose file.
 * Do not run Compose or interpolate application environments during planning.
 * @param {string | string[]} composeFiles
 * @param {string} name
 * @returns {"service_started" | "service_healthy"}
 */
export function providerServiceDependency(composeFiles, name) {
  const services = selectedServices(composeFiles, name);
  const service = services[name];
  if (!isPlainObject(service)) {
    throw usageError(`provider service ${name} must be declared in the selected root Compose file`);
  }
  rejectUnresolvedMerges(service, name);
  if (
    service.extends ||
    service.network_mode ||
    (Array.isArray(service.profiles) && service.profiles.length)
  ) {
    throw usageError(
      `provider service ${name} must be directly declared, unprofiled, and use the shared default network`,
    );
  }
  if (
    service.networks !== undefined &&
    !(Array.isArray(service.networks)
      ? service.networks.includes("default")
      : isPlainObject(service.networks) && "default" in service.networks)
  ) {
    throw usageError(`provider service ${name} must join the shared default Compose network`);
  }
  // Caddy depends on the provider; a transitive dependency back to Caddy
  // would make the generated project impossible to start.
  const pending = [name];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === "caddy") throw usageError(`provider service ${name} must not depend on Caddy`);
    if (visited.has(current)) continue;
    visited.add(current);
    const item = services[current ?? ""];
    if (!isPlainObject(item)) continue;
    rejectUnresolvedMerges(item, current ?? name);
    const dependencies = item.depends_on;
    pending.push(
      ...(Array.isArray(dependencies)
        ? dependencies.filter((value) => typeof value === "string")
        : isPlainObject(dependencies)
          ? Object.keys(dependencies)
          : []),
    );
  }
  const health = service.healthcheck;
  return isPlainObject(health) &&
    health.disable !== true &&
    ((typeof health.test === "string" && health.test.trim() !== "") ||
      (Array.isArray(health.test) && health.test.length > 0 && health.test[0] !== "NONE"))
    ? "service_healthy"
    : "service_started";
}

/**
 * Validate the explicitly selected application-owned provider before generation.
 * @param {import("../types.mjs").McpAppBootstrapOptions | undefined} options
 * @param {string | string[]} composeFiles
 */
export function resolveProviderTopology(options, composeFiles) {
  const runtime = options?.providerRuntime ?? (options?.providerService ? "compose" : "host");
  if (runtime !== "host" && runtime !== "compose")
    throw usageError("--provider-runtime must be host or compose");
  if (runtime === "host" && options?.providerService !== undefined) {
    throw usageError("--provider-service cannot be combined with --provider-runtime host");
  }
  const providerService = runtime === "compose" ? options?.providerService : undefined;
  if (runtime === "compose" && !providerService)
    throw usageError("Compose provider runtime requires --provider-service");
  // Validate the name before using it in any lookup or generated text.
  resolveLocalHttpsTopology({ providerService });
  const providerDependency = providerService
    ? providerServiceDependency(composeFiles, providerService)
    : undefined;
  return { providerService, providerDependency };
}
