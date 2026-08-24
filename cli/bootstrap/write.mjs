import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

function atomicWrite(operation) {
  const directory = dirname(operation.path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(operation.path)}.tama-kit-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    writeFileSync(temporary, operation.content, {
      encoding: "utf8",
      mode: operation.mode ?? 0o644,
    });
    if (operation.mode !== undefined) {
      chmodSync(temporary, operation.mode);
    }
    renameSync(temporary, operation.path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

export function applyOperations(operations) {
  for (const operation of operations) {
    if (operation.action === "unchanged") {
      if (operation.mode !== undefined) {
        chmodSync(operation.path, operation.mode);
      }
      continue;
    }
    atomicWrite(operation);
  }
}
