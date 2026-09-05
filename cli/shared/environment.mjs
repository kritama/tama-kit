// @ts-check

import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { ownershipError } from "../errors.mjs";

/** @param {number} [bytes] */
export function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** @param {string} content @param {string} filename @returns {Map<string, string>} */
export function parseEnvironment(content, filename) {
  const values = new Map();
  const duplicates = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match) {
      if (values.has(match[1])) {
        duplicates.add(match[1]);
      }
      let value;
      try {
        value = parseEnv(`${line}\n`)[match[1]];
      } catch {
        throw ownershipError(`${filename} contains invalid dotenv syntax for ${match[1]}`, {
          path: filename,
          variable: match[1],
        });
      }
      values.set(match[1], value ?? "");
    }
  }
  if (duplicates.size > 0) {
    const names = [...duplicates].sort();
    throw ownershipError(
      `${filename} contains duplicate environment variables: ${names.join(", ")}`,
      {
        path: filename,
        variables: names,
      },
    );
  }
  return values;
}

/** @param {string} value */
export function isValidVaultKey(value) {
  if (Buffer.byteLength(value, "utf8") === 32) {
    return true;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

/** @param {Map<string, string>} values */
export function processEnvironment(values) {
  return { ...process.env, ...Object.fromEntries(values) };
}
