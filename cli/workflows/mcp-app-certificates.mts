import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureMkcertLocalCa, planLocalHttpsCertificates } from "../bootstrap/local-https.mjs";
import { createOwnedFilePlanner } from "../bootstrap/owned-files.mjs";
import { ownershipError } from "../errors.mjs";
import { inspectRegularFile } from "../shared/files.mjs";
import type { FileOperation, LocalHttpsTopology } from "../types.mjs";

export const ADDITION_TLS = {
  root: "tama/mcp-app-tls/rootCA.pem",
  bundle: "tama/mcp-app-tls/local.pem",
};

/** Validate an already-published certificate/key bundle before a resume adopts it. */
export function validateAdditionCertificateBundle(
  topology: LocalHttpsTopology,
  bundle: string,
  installLocalCa = false,
) {
  const ca = ensureMkcertLocalCa(installLocalCa);
  const rootContent = readFileSync(ca.rootCertificate, "utf8");
  try {
    const cert = new X509Certificate(bundle);
    const issuer = new X509Certificate(rootContent);
    if (
      !cert.checkPrivateKey(createPrivateKey(bundle)) ||
      !cert.verify(issuer.publicKey) ||
      topology.certificateNames.some((name) => !cert.checkHost(name)) ||
      Date.parse(cert.validTo) <= Date.now() ||
      Date.parse(cert.validFrom) > Date.now()
    )
      throw new Error();
  } catch {
    throw ownershipError(
      "existing MCP App TLS bundle does not match its key, CA, names or validity period",
    );
  }
}

/** One atomic PEM bundle keeps certificate and key together across process interruption. */
export function additionCertificates(
  root: string,
  topology: LocalHttpsTopology,
  installLocalCa = false,
): FileOperation[] {
  const rootPath = join(root, ADDITION_TLS.root);
  const bundlePath = join(root, ADDITION_TLS.bundle);
  const ca = ensureMkcertLocalCa(installLocalCa);
  const rootContent = readFileSync(ca.rootCertificate, "utf8");
  const existingRoot = inspectRegularFile(rootPath);
  const existingBundle = inspectRegularFile(bundlePath);
  if (existingRoot && readFileSync(rootPath, "utf8") !== rootContent)
    throw ownershipError(
      "the MCP App certificate root differs from the selected local CA; inspect your TLS files",
    );
  let bundle: string;
  if (existingBundle) {
    if (existingBundle.mode & 0o077)
      throw ownershipError("MCP App TLS bundle must have owner-only permissions");
    bundle = readFileSync(bundlePath, "utf8");
    validateAdditionCertificateBundle(topology, bundle, installLocalCa);
  } else {
    const temporary = mkdtempSync(join(resolve(tmpdir()), "tama-addition-tls-"));
    try {
      const generated = planLocalHttpsCertificates(temporary, topology);
      const content = (name: string) => {
        const operation = generated.operations.find(({ path }) => path.endsWith(name));
        if (!operation || !("content" in operation))
          throw new Error("certificate generation failed");
        return operation.content;
      };
      bundle = `${content("/local.pem").trim()}\n${content("/local-key.pem").trim()}\n`;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const owned = createOwnedFilePlanner(root, "mcp-app-tls");
  return [
    owned.plan(rootPath, rootContent),
    owned.plan(bundlePath, bundle, { sensitive: true, mode: 0o600 }),
  ];
}
