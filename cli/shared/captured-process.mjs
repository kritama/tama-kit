// @ts-check
import { spawn } from "node:child_process";

export class CapturedProcessError extends Error {
  /** @param {string} message @param {string} stderr */
  constructor(message, stderr) {
    super(message);
    this.stderr = stderr;
  }
}

/**
 * Retain only a bounded stderr tail. Callers must project safe diagnostics;
 * captured bytes are never suitable for logs or public error envelopes.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {Promise<void>}
 */
export function runCapturedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
    let tail = Buffer.alloc(0);
    child.stderr?.on("data", (chunk) => {
      tail = Buffer.concat([tail, Buffer.from(chunk)]).subarray(-16 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new CapturedProcessError(
            `${command} exited with ${code ?? signal}`,
            tail.toString("utf8"),
          ),
        );
    });
  });
}
