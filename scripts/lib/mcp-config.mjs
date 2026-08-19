import { BlockList, isIP } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const NON_PUBLIC_IPV4_PREFIXES = new Set([
  "192.0",
  "192.0.2",
  "192.88.99",
  "198.51.100",
  "203.0.113",
]);
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

export function readObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return value;
}

export function writeObject(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function placeholderNames(template) {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
}

function isPublicIpv4(hostname) {
  const [a, b] = hostname.split(".").map(Number);
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    return false;
  }

  const third = hostname.split(".")[2];
  return (
    !NON_PUBLIC_IPV4_PREFIXES.has(`${a}.${b}`) &&
    !NON_PUBLIC_IPV4_PREFIXES.has(`${a}.${b}.${third}`)
  );
}

function isPublicIpv6(hostname) {
  return !NON_PUBLIC_IPV6.check(hostname, "ipv6");
}

export function validatePublicExampleUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("--example-url must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new TypeError("--example-url must be an absolute HTTPS URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("--example-url must not contain credentials, a query, or a fragment");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example")
  ) {
    throw new TypeError("--example-url must use a public, non-test hostname");
  }

  const ipVersion = isIP(hostname);
  if (
    (ipVersion === 4 && !isPublicIpv4(hostname)) ||
    (ipVersion === 6 && !isPublicIpv6(hostname))
  ) {
    throw new TypeError("--example-url must not use a private or local IP address");
  }
  if (ipVersion === 0 && !hostname.includes(".")) {
    throw new TypeError("--example-url hostname must be publicly qualified");
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function validateTemplateMatch(template, example) {
  const names = placeholderNames(template);
  if (names.length === 0 || names.length !== new Set(names).size) {
    throw new TypeError("Template MCP URL must contain unique {name} placeholders");
  }

  let cursor = 0;
  const parts = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    parts.push(escapeRegExp(template.slice(cursor, match.index)));
    parts.push("[^/?#]+");
    cursor = match.index + match[0].length;
  }
  parts.push(escapeRegExp(template.slice(cursor)));

  if (!new RegExp(`^(?:${parts.join("")})$`, "u").test(example)) {
    throw new TypeError(
      `--example-url does not match Template MCP URL ${JSON.stringify(template)}`,
    );
  }
}
