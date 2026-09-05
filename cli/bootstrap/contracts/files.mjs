// @ts-check
import { existsSync, lstatSync, readFileSync } from "node:fs";
export const MAX_CONTRACT_BYTES = 256 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} path @param {number} [maxBytes] @returns {string | null} */
export function safeRead(path, maxBytes = MAX_CONTRACT_BYTES) {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
