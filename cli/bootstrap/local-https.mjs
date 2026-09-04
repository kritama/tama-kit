// @ts-check

import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownershipError, prerequisiteError, usageError } from "../errors.mjs";
import { BOOTSTRAP_PATHS, DEFAULTS, MANAGED_MARKER } from "./constants.mjs";
import { operationForContent } from "./files.mjs";

export const LOCAL_HTTPS_DEFAULT_DOMAIN = "app.localhost";
export const LOCAL_HTTPS_DEFAULT_PORT = 443;
export const LOCAL_HTTPS_TAMA_HOST_PREFIX = "tama.";
export const LOCAL_HTTPS_TRUST_MECHANISM = "derived-image-ca-certificates";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** @param {string | undefined} value */
export function normalizeLocalDomain(value = LOCAL_HTTPS_DEFAULT_DOMAIN) {
  if (typeof value !== "string" || value.length === 0) {
    throw usageError("--local-domain must be a non-empty DNS name");
  }
  const domain = value.toLowerCase().replace(/\.$/u, "");
  if (
    domain.length > 253 ||
    isIP(domain) !== 0 ||
    domain.includes("..") ||
    domain.split(".").some((label) => !DOMAIN_LABEL.test(label))
  ) {
    throw usageError(`invalid --local-domain DNS name: ${value}`);
  }
  if (domain === "local" || domain.endsWith(".local")) {
    throw usageError("--local-domain must not use .local; it is reserved for multicast DNS");
  }
  return domain;
}

/** @param {string} value @returns {boolean} */
function isLoopbackAddress(value) {
  if (value === "::1" || value.toLowerCase() === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every((part) => part >= 0 && part <= 255);
}

/**
 * Resolves the single canonical local HTTPS topology. Public origins are kept
 * separate from the private upstreams so Docker transport names cannot leak
 * into OAuth identities.
 *
 * @param {{localDomain?: string, providerPort?: number, httpsPort?: number, allowedOrigins?: string[]}} [input]
 */
export function resolveLocalHttpsTopology(input = {}) {
  const domain = normalizeLocalDomain(input.localDomain);
  const httpsPort = input.httpsPort ?? LOCAL_HTTPS_DEFAULT_PORT;
  const providerPort = input.providerPort ?? DEFAULTS.port;
  if (!Number.isInteger(providerPort) || providerPort < 1 || providerPort > 65_535) {
    throw usageError(`--provider-port must be between 1 and 65535: ${providerPort}`);
  }
  if (httpsPort !== LOCAL_HTTPS_DEFAULT_PORT) {
    throw usageError("local HTTPS currently supports only port 443");
  }
  const providerHost = domain;
  const tamaHost = `${LOCAL_HTTPS_TAMA_HOST_PREFIX}${domain}`;
  const providerOrigin = `https://${providerHost}`;
  const tamaOrigin = `https://${tamaHost}`;
  const allowedOrigins = [...new Set(input.allowedOrigins ?? [providerOrigin])];
  return Object.freeze({
    profile: "mcp-app-local-https",
    localDomain: domain,
    providerHost,
    tamaHost,
    providerOrigin,
    tamaOrigin,
    resource: `${tamaOrigin}/mcp/app`,
    introspectionClientId: `${tamaOrigin}/mcp/app/introspection`,
    providerJwksUri: `${providerOrigin}/.well-known/jwks.json`,
    providerIntrospectionEndpoint: `${providerOrigin}/auth/introspections`,
    tamaJwksUri: `${tamaOrigin}/.well-known/jwks.json`,
    healthUrl: `${tamaOrigin}/`,
    providerUpstream: `http://host.docker.internal:${providerPort}`,
    tamaUpstream: `http://tama:${DEFAULTS.containerPort}`,
    providerPort,
    tamaPort: DEFAULTS.containerPort,
    httpsPort,
    certificateNames: [providerHost, tamaHost],
    caddyImage: DEFAULTS.caddyImage,
    trustMechanism: LOCAL_HTTPS_TRUST_MECHANISM,
    allowedOrigins,
  });
}

/**
 * Fresh MCP App runs use local HTTPS unless an explicit old topology input is
 * supplied. This keeps 0.4.3 projects migratable without making the legacy
 * transport the default again.
 */
/** @param {import("../types.mjs").McpAppBootstrapOptions | null | undefined} options @param {import("../types.mjs").PersistedMcpAppProvider | null} [persisted] @param {Record<string, unknown> | null} [contractDocument] */
export function usesLocalHttpsTopology(options, persisted = null, contractDocument = null) {
  const explicitlyLegacyClient = [
    ...(options?.allowedOrigins ?? []),
    options?.providerOrigin,
    options?.tamaOrigin,
  ].some((origin) => typeof origin === "string" && origin.startsWith("http://"));
  const localDevelopment = contractDocument?.local_development;
  const contractOrigins =
    localDevelopment && typeof localDevelopment === "object" && !Array.isArray(localDevelopment)
      ? Object.values(/** @type {Record<string, unknown>} */ (localDevelopment)).filter(
          (value) => typeof value === "string",
        )
      : [];
  const explicitlyLegacyContract = contractOrigins.some((origin) =>
    /** @type {string} */ (origin).startsWith("http://"),
  );
  if (persisted?.localHttps) return true;
  if (options?.migrateLocalHttps) return true;
  if (persisted?.providerOrigin) return false;
  return !explicitlyLegacyClient && !explicitlyLegacyContract;
}

/** @param {{localDomain: string, certificateNames: string[]}} topology */
export async function resolveLocalHttpsNames(topology, lookupImpl = lookup) {
  /** @type {Record<string, string[]>} */
  const addresses = {};
  for (const hostname of topology.certificateNames) {
    let records;
    try {
      records = await lookupImpl(hostname, { all: true });
    } catch (error) {
      throw prerequisiteError(
        `${hostname} does not resolve locally; configure local DNS for the selected HTTPS names`,
        { hostname, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const values = records.map((record) => record.address);
    if (values.length === 0 || values.some((address) => !isLoopbackAddress(address))) {
      throw prerequisiteError(
        `${hostname} resolves outside loopback; refusing to create a local HTTPS topology`,
        { hostname, addresses: values },
      );
    }
    addresses[hostname] = values;
  }
  return addresses;
}

/** @param {string} root */
export function localHttpsPaths(root) {
  const directory = join(root, BOOTSTRAP_PATHS.tamaDirectory, "tls");
  return {
    directory,
    certificate: join(directory, "local.pem"),
    privateKey: join(directory, "local-key.pem"),
    rootCertificate: join(directory, "rootCA.pem"),
    dockerfile: join(root, BOOTSTRAP_PATHS.tamaDirectory, "tama-local-ca.Dockerfile"),
    caddyfile: join(root, BOOTSTRAP_PATHS.tamaDirectory, "Caddyfile"),
  };
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024,
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw prerequisiteError("mkcert is required for the MCP App local HTTPS topology");
    }
    throw prerequisiteError(`mkcert ${args[0] ?? "command"} failed: ${message}`);
  }
}

/** @returns {{path: string, caRoot: string, rootCertificate: string}} */
export function discoverMkcert() {
  const caRoot = run("mkcert", ["-CAROOT"]);
  const rootCertificate = join(caRoot, "rootCA.pem");
  if (!existsSync(rootCertificate) || !lstatSync(rootCertificate).isFile()) {
    throw prerequisiteError(
      "mkcert has no local CA certificate; explicitly authorize --install-local-ca",
      { caRoot, prerequisite: "mkcert-local-ca" },
    );
  }
  return { path: "mkcert", caRoot, rootCertificate };
}

/**
 * @param {boolean} authorized
 * @param {{discover?: typeof discoverMkcert, install?: () => void}} [implementation]
 */
export function ensureMkcertLocalCa(
  authorized,
  { discover = discoverMkcert, install = () => run("mkcert", ["-install"]) } = {},
) {
  if (authorized) {
    install();
  }
  return discover();
}

/** @param {string} certificate @param {string[]} names */
export function certificateHasNames(certificate, names) {
  try {
    const text = execFileSync(
      "openssl",
      ["x509", "-in", certificate, "-noout", "-ext", "subjectAltName"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return names.every((name) =>
      new RegExp(`(?:DNS:)?${name.replace(/\./gu, "\\.")}(?:,|\\s|$)`, "u").test(text),
    );
  } catch {
    return false;
  }
}

/** @param {string} path @param {number | null} expectedMode */
function assertRegularTlsFile(path, expectedMode) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw ownershipError(`local HTTPS TLS material cannot be inspected: ${path}`, { path });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw ownershipError(`local HTTPS TLS material must be a regular file: ${path}`, { path });
  }
  if (expectedMode !== null && (metadata.mode & 0o777) !== expectedMode) {
    throw ownershipError(`local HTTPS private key must have mode 0600: ${path}`, {
      path,
      mode: (metadata.mode & 0o777).toString(8),
    });
  }
}

/** @param {ReturnType<typeof localHttpsPaths>} paths @param {string[]} names */
function assertReusableTlsMaterial(paths, names) {
  assertRegularTlsFile(paths.certificate, null);
  assertRegularTlsFile(paths.privateKey, 0o600);
  assertRegularTlsFile(paths.rootCertificate, null);
  try {
    const leaf = new X509Certificate(readFileSync(paths.certificate));
    const root = new X509Certificate(readFileSync(paths.rootCertificate));
    const privateKey = createPrivateKey(readFileSync(paths.privateKey));
    const now = Date.now();
    if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) <= now) {
      throw new Error("leaf certificate is not currently valid");
    }
    if (Date.parse(root.validFrom) > now || Date.parse(root.validTo) <= now) {
      throw new Error("root certificate is not currently valid");
    }
    if (!names.every((name) => leaf.checkHost(name) !== undefined)) {
      throw new Error("leaf certificate SANs do not match the requested names");
    }
    if (!leaf.checkPrivateKey(privateKey)) {
      throw new Error("leaf certificate does not match the private key");
    }
    if (!root.verify(root.publicKey)) {
      throw new Error("stored root certificate is not self-signed");
    }
    if (!leaf.verify(root.publicKey)) {
      throw new Error("leaf certificate was not issued by the stored root");
    }
  } catch (error) {
    throw ownershipError(
      `local HTTPS certificate paths exist but are not a valid reusable chain: ${error instanceof Error ? error.message : String(error)}`,
      { paths: [paths.certificate, paths.privateKey, paths.rootCertificate] },
    );
  }
}

/**
 * Returns certificate operations for a write. Existing matching material is
 * reused; a mismatched existing destination is rejected instead of silently
 * replacing an operator-owned key.
 * @param {string} root
 * @param {import("../types.mjs").LocalHttpsTopology} topology
 * @param {{allowGeneration?: boolean, installLocalCa?: boolean, discoverLocalCa?: typeof discoverMkcert, ensureLocalCa?: typeof ensureMkcertLocalCa}} [options]
 */
export function planLocalHttpsCertificates(
  root,
  topology,
  {
    allowGeneration = true,
    installLocalCa = false,
    discoverLocalCa = discoverMkcert,
    ensureLocalCa = ensureMkcertLocalCa,
  } = {},
) {
  const paths = localHttpsPaths(root);
  if (!allowGeneration) {
    return { paths, operations: [] };
  }
  const existing = [paths.certificate, paths.privateKey, paths.rootCertificate].every(existsSync);
  if (existing) {
    const mkcert = ensureLocalCa(installLocalCa, { discover: discoverLocalCa });
    assertReusableTlsMaterial(paths, topology.certificateNames);
    if (
      readFileSync(paths.rootCertificate, "utf8") !== readFileSync(mkcert.rootCertificate, "utf8")
    ) {
      throw ownershipError(
        "the stored local HTTPS root is not the currently trusted mkcert root; move the TLS files aside and regenerate them",
        { path: paths.rootCertificate },
      );
    }
    return { paths, operations: [] };
  }
  if ([paths.certificate, paths.privateKey, paths.rootCertificate].some(existsSync)) {
    throw ownershipError(
      `local HTTPS certificate paths already exist but do not match ${topology.certificateNames.join(", ")}; move them aside before bootstrap`,
      { paths: [paths.certificate, paths.privateKey, paths.rootCertificate] },
    );
  }
  const mkcert = ensureLocalCa(installLocalCa, { discover: discoverLocalCa });
  const temporary = mkdtempSync(join(tmpdir(), "tama-kit-mkcert-"));
  const cert = join(temporary, "local.pem");
  const key = join(temporary, "local-key.pem");
  try {
    run(mkcert.path, ["-cert-file", cert, "-key-file", key, ...topology.certificateNames]);
    if (!certificateHasNames(cert, topology.certificateNames)) {
      throw prerequisiteError("mkcert generated a certificate without the requested SANs");
    }
    const rootCertificate = readFileSync(mkcert.rootCertificate, "utf8");
    return {
      paths,
      operations: [
        operationForContent(paths.certificate, readFileSync(cert, "utf8"), {
          sensitive: false,
          mode: 0o644,
          allowUnmanagedUpdate: true,
        }),
        operationForContent(paths.privateKey, readFileSync(key, "utf8"), {
          sensitive: true,
          mode: 0o600,
          allowUnmanagedUpdate: true,
        }),
        operationForContent(paths.rootCertificate, rootCertificate, {
          sensitive: false,
          mode: 0o644,
          allowUnmanagedUpdate: true,
        }),
      ],
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {ReturnType<typeof resolveLocalHttpsTopology>} topology */
export function renderLocalHttpsCaddyfile(topology) {
  return [
    `# ${MANAGED_MARKER}. Exact local HTTPS MCP App proxy; no catch-all route.`,
    `${topology.providerHost} {`,
    "  tls /etc/tama-kit/tls/local.pem /etc/tama-kit/tls/local-key.pem",
    `  reverse_proxy ${topology.providerUpstream} {`,
    "    header_up Host {host}",
    "    header_up X-Forwarded-Proto {scheme}",
    "    header_up X-Forwarded-Host {host}",
    "  }",
    "}",
    "",
    `${topology.tamaHost} {`,
    "  tls /etc/tama-kit/tls/local.pem /etc/tama-kit/tls/local-key.pem",
    `  reverse_proxy ${topology.tamaUpstream} {`,
    "    header_up Host {host}",
    "    header_up X-Forwarded-Proto {scheme}",
    "    header_up X-Forwarded-Host {host}",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** @param {string} tamaImage */
export function renderLocalCaDockerfile(tamaImage) {
  return [
    `# ${MANAGED_MARKER}. Installs only the public local CA into the derived Tama image.`,
    `FROM ${tamaImage}`,
    "USER root",
    "COPY tls/rootCA.pem /usr/local/share/ca-certificates/tama-kit-local.crt",
    "RUN if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates && update-ca-certificates; else echo 'unsupported Tama image CA trust mechanism' >&2; exit 1; fi",
    "USER tama",
    "",
  ].join("\n");
}
