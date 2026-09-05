// @ts-check

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, isIP } from "node:net";
import { prerequisiteError, startupError } from "../errors.mjs";
import { runProcess } from "../shared/process.mjs";
import { localHttpsPaths } from "./local-https.mjs";
import { createLocalHttpsFetch } from "./mcp-app-verify.mjs";

/** @typedef {import("../types.mjs").BootstrapPlan} BootstrapPlan */

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} host @param {number} port @returns {Promise<boolean>} */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    /** @param {boolean} connected */
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Fails before Compose startup when an unrelated local listener owns the
 * canonical HTTPS port. The bootstrap never stops or reconfigures that
 * listener.
 * @param {number} port
 */
export async function assertLocalHttpsPortAvailable(port) {
  const [ipv4, ipv6] = await Promise.all([canConnect("127.0.0.1", port), canConnect("::1", port)]);
  if (ipv4 || ipv6) {
    throw startupError(
      `local HTTPS port ${port} is already in use; stop or reconfigure the unrelated listener before starting Caddy`,
    );
  }
}

/**
 * Reports whether this exact Compose plan has a running service container.
 * A running managed Caddy is allowed to retain port 443 across idempotent
 * starts; a stopped container does not mask an unrelated listener.
 * @param {{root: string, composeFile: string}} plan
 * @param {string} service
 * @param {typeof execFileSync} [execute]
 */
export function managedComposeServiceExists(plan, service, execute = execFileSync) {
  try {
    return (
      execute("docker", ["compose", "-f", plan.composeFile, "ps", "-q", service], {
        cwd: plan.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== ""
    );
  } catch {
    return false;
  }
}

export function validateComposePrerequisite() {
  /** @type {string} */
  let output;
  try {
    output = execFileSync("docker", ["compose", "version", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw prerequisiteError("Docker Compose 2.20.0 or newer is required");
    }
    throw prerequisiteError("Docker Compose 2.20.0 or newer is required and could not be detected");
  }
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    throw prerequisiteError(`cannot parse Docker Compose version: ${output}`);
  }
  const [, major, minor] = match.map(Number);
  if (major < 2 || (major === 2 && minor < 20)) {
    throw prerequisiteError(`Docker Compose 2.20.0 or newer is required; found ${output}`);
  }
}

/**
 * Reads the address Docker placed beside host.docker.internal in a running
 * container's hosts file. The value is the container's actual view of the
 * host gateway, including daemon-level host-gateway overrides.
 *
 * @param {string} content
 * @returns {string | null}
 */
export function parseComposeHostGatewayAddress(content) {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (line === "") {
      continue;
    }
    const [address, ...names] = line.split(/\s+/u);
    if (names.includes("host.docker.internal") && isIP(address) !== 0) {
      return address;
    }
  }
  return null;
}

/** @param {string} address @returns {boolean} */
function isContainerLocalAddress(address) {
  if (address === "0.0.0.0" || address.startsWith("127.")) {
    return true;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  const dottedMapped = normalized.match(/^::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u);
  if (dottedMapped !== null) {
    return Number(dottedMapped[1]) === 0 || Number(dottedMapped[1]) === 127;
  }
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hexMapped === null) {
    return false;
  }
  const mappedAddress =
    (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
  const firstOctet = mappedAddress >>> 24;
  return firstOctet === 0 || firstOctet === 127;
}

/**
 * Resolves the exact host-gateway address installed in Tama's running
 * container. Host-side verification uses this address so providers bound
 * only to the Docker bridge remain reachable without weakening the public
 * issuer comparison.
 *
 * @param {{root: string, composeFile: string}} plan
 * @returns {string}
 */
export function resolveComposeHostGatewayAddress(plan) {
  let output;
  try {
    output = execFileSync(
      "docker",
      ["compose", "-f", plan.composeFile, "exec", "-T", "tama", "cat", "/etc/hosts"],
      {
        cwd: plan.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    throw startupError(
      `could not inspect Tama's host.docker.internal mapping: ${errorMessage(error)}`,
    );
  }
  const address = parseComposeHostGatewayAddress(output);
  if (address === null || isContainerLocalAddress(address)) {
    throw startupError(
      "Tama's host.docker.internal mapping is missing or not a usable host gateway",
    );
  }
  return address;
}

/**
 * Probes the provider from the running Tama container. This is the only
 * reliable way to include Docker namespace routing and host firewall policy
 * in the activation decision; a successful host-side request or a wide host
 * socket bind cannot establish container reachability.
 *
 * The managed Tama image already uses curl for its health check. Curl does
 * not follow redirects unless explicitly requested, so success belongs to the
 * configured provider endpoint itself.
 *
 * @param {{root: string, composeFile: string, localHttps?: {providerHost: string, httpsPort: number} | null}} plan
 * @param {string} endpoint
 * @param {typeof execFileSync} [execute]
 * @returns {boolean}
 */
export function probeComposeProviderEndpoint(plan, endpoint, execute = execFileSync) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const endpointPort = url.port || (url.protocol === "https:" ? "443" : "80");
  const localHttps = plan.localHttps;
  const connectThroughCaddy =
    localHttps && url.hostname === localHttps.providerHost
      ? ["--connect-to", `${url.hostname}:${endpointPort}:caddy:${localHttps.httpsPort}`]
      : [];
  try {
    const status = execute(
      "docker",
      [
        "compose",
        "-f",
        plan.composeFile,
        "exec",
        "-T",
        "tama",
        "curl",
        ...connectThroughCaddy,
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "10",
        "--write-out",
        "%{http_code}",
        "--output",
        "/dev/null",
        url.href,
      ],
      {
        cwd: plan.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024,
      },
    );
    return status.trim() === "200";
  } catch {
    return false;
  }
}

/**
 * @param {{root: string, composeFile: string}} plan
 * @param {{quiet?: boolean, checkPrerequisite?: boolean, env?: NodeJS.ProcessEnv}} [options]
 */
export async function validateCompose(plan, { quiet = true, checkPrerequisite = true, env } = {}) {
  if (checkPrerequisite) {
    validateComposePrerequisite();
  }
  try {
    await runProcess("docker", ["compose", "-f", plan.composeFile, "config", "--quiet"], {
      cwd: plan.root,
      env,
      stdio: quiet ? "ignore" : "inherit",
    });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw prerequisiteError("Docker Compose is required to validate the generated integration");
    }
    throw prerequisiteError(`Docker Compose validation failed: ${errorMessage(error)}`);
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @param {(input: URL, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.ref();
  try {
    return await fetchImpl(new URL(url), { redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** @param {BootstrapPlan} plan @param {number} [timeoutMs] @returns {Promise<string>} */
async function waitForHealth(plan, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const url = plan.localHttps?.healthUrl ?? `http://localhost:${plan.port}/`;
  const fetchImpl = plan.localHttps
    ? createLocalHttpsFetch(readFileSync(localHttpsPaths(plan.root).rootCertificate))
    : fetch;
  /** @type {Error | undefined} */
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, 2_000, fetchImpl);
      if (response.ok) {
        return url;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw startupError(
    `Tama did not become healthy at ${url} within ${Math.round(timeoutMs / 1000)} seconds: ${lastError?.message ?? "unknown error"}`,
  );
}

/**
 * @param {{composeFile: string, localHttps?: unknown}} plan
 */
export function composeUpArguments(plan) {
  return [
    "compose",
    "-f",
    plan.composeFile,
    "up",
    "-d",
    ...(plan.localHttps ? ["--build", "caddy"] : ["tama"]),
  ];
}

/**
 * @param {BootstrapPlan} plan
 * @param {{quiet?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function startCompose(plan, { quiet = false } = {}) {
  const managedCaddyExists = plan.localHttps ? managedComposeServiceExists(plan, "caddy") : false;
  if (plan.localHttps && !managedCaddyExists) {
    await assertLocalHttpsPortAvailable(plan.localHttps.httpsPort);
  }
  try {
    await runProcess("docker", composeUpArguments(plan), {
      cwd: plan.root,
      stdio: quiet ? "ignore" : "inherit",
    });
  } catch (error) {
    throw startupError(`Docker Compose startup failed: ${errorMessage(error)}`);
  }
  return waitForHealth(plan);
}
