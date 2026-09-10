// @ts-check

/**
 * Reports whether a URL hostname names a loopback address. WHATWG URLs retain
 * brackets around IPv6 hostnames and canonicalize IPv4-mapped IPv6 addresses
 * to hexadecimal groups, so normalize both forms before classification.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare === "localhost") {
    return true;
  }
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map((part) => Number(part));
    return octets.every((octet) => octet <= 255) && octets[0] === 127;
  }
  const ipv6 = bare.toLowerCase();
  if (ipv6 === "::1") {
    return true;
  }
  const dottedMapped = ipv6.match(/^::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u);
  if (dottedMapped !== null) {
    return Number(dottedMapped[1]) === 127;
  }
  const hexMapped = ipv6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hexMapped !== null) {
    const mappedAddress =
      (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
    return mappedAddress >>> 24 === 127;
  }
  return false;
}
