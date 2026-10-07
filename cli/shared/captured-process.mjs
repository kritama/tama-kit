// @ts-check
import { spawn } from "node:child_process";

/** Bounded retained bytes per stream; only the tail is kept. */
export const CAPTURED_STREAM_LIMIT = 16 * 1024;

export class CapturedProcessError extends Error {
  /** @param {string} message @param {string} stdout @param {string} stderr */
  constructor(message, stdout, stderr) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Retain only bounded stdout and stderr tails so phase indicators that
 * appear on either stream remain recognizable after failure. Callers must
 * project safe diagnostics; captured bytes are never suitable for logs or
 * public error envelopes. Spawn failures and signal exits reject, and the
 * promise settles only after all child streams have closed.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {Promise<void>}
 */
export function runCapturedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    /** @type {Buffer} */
    let stdout = Buffer.alloc(0);
    /** @type {Buffer} */
    let stderr = Buffer.alloc(0);
    child.stdout?.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]).subarray(-CAPTURED_STREAM_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-CAPTURED_STREAM_LIMIT);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new CapturedProcessError(
            `${command} exited with ${code ?? signal}`,
            stdout.toString("utf8"),
            stderr.toString("utf8"),
          ),
        );
    });
  });
}
