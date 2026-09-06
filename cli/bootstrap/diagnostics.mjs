// @ts-check
import { stripVTControlCharacters } from "node:util";

/**
 * Compose can repeat application secrets in arbitrary stderr. Project a small
 * allowlist of failure facts instead of attempting to blacklist every secret.
 * @param {string} stderr
 * @returns {{operation: "compose-up", reason: string, port?: number}}
 */
export function composeStartupDiagnostic(stderr) {
  const tail = stripVTControlCharacters(stderr.slice(-16 * 1024));
  let reason = "compose-failed";
  if (/address already in use|port is already allocated|bind.*failed/iu.test(tail)) {
    const match = tail.match(
      /(?:listen (?:tcp|udp)(?:4|6)? |Bind for |exposing port (?:TCP|UDP) )[^\s]*:(\d{1,5})(?=[\s:])/iu,
    );
    const port = match ? Number(match[1]) : null;
    return {
      operation: "compose-up",
      reason: "port-conflict",
      ...(port && port <= 65535 ? { port } : {}),
    };
  }
  if (/unhealthy|healthcheck failed/iu.test(tail)) reason = "unhealthy-service";
  else if (/pull access denied|manifest unknown|failed to resolve reference/iu.test(tail))
    reason = "image-unavailable";
  else if (/dependency failed|depends on undefined service/iu.test(tail))
    reason = "dependency-failed";
  return { operation: "compose-up", reason };
}
