import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { parseGenerationReceipt } from "../domain/generation.mjs";
import { ownershipError } from "../errors.mjs";
import { contentDigest } from "../shared/files.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import type { BootstrapPlan } from "../types.mjs";

/** Keep crash progress with the transaction, without any permanent content fingerprints. */
export async function writeScaffold(plan: BootstrapPlan, validate: () => void | Promise<void>) {
  const path = join(plan.root, "tama/.tama-kit.json");
  const completeOperation = plan.operations.find((operation) => operation.path === path);
  if (!completeOperation || !("content" in completeOperation))
    throw new Error("generation receipt is missing from the write plan");
  const complete = parseGenerationReceipt(JSON.parse(completeOperation.content));
  const pending = new Set(
    plan.operations
      .filter((operation) => operation.action === "create" && operation.path !== path)
      .map((operation) => relative(plan.root, operation.path).split("\\").join("/")),
  );
  const previous = readGenerationEvidence(path);
  if (previous.kind === "receipt" && previous.receipt.progress.status === "incomplete") {
    const selected = new Set(previous.receipt.progress.pendingDestinations);
    if (
      previous.receipt.operation.id !== complete.operation.id ||
      [...pending].some((destination) => !selected.has(destination))
    )
      throw ownershipError(
        "resume cannot create destinations outside its selected unfinished operation",
      );
    for (const destination of selected)
      if (
        !plan.operations.some(
          (operation) => relative(plan.root, operation.path).split("\\").join("/") === destination,
        )
      )
        throw ownershipError("resume requires the original options for every pending destination", {
          path: destination,
        });
  }
  if (!pending.size) return applyOperationsTransactionally(plan.operations, validate);
  const receipt = () =>
    `${JSON.stringify({ ...complete, progress: pending.size ? { status: "incomplete", pendingDestinations: [...pending] } : { status: "complete" } }, null, 2)}\n`;
  let lastReceipt = receipt();
  // Retain the reviewed receipt precondition; never adopt metadata that arrived
  // after planning merely because progress journaling needs an initial write.
  const begin = {
    ...completeOperation,
    content: lastReceipt,
    afterDigest: contentDigest(lastReceipt),
  };
  await applyOperationsTransactionally(
    [begin, ...plan.operations.filter((operation) => operation.path !== path)],
    validate,
    (operation, write) => {
      if (operation.path === path || operation.action !== "create") return;
      pending.delete(relative(plan.root, operation.path).split("\\").join("/"));
      const current = readFileSync(path, "utf8");
      if (current !== lastReceipt)
        throw ownershipError(
          "generation receipt changed during writing; preserving current metadata",
        );
      const updated = receipt();
      if (current !== updated) {
        write({
          action: "update",
          path,
          content: updated,
          owner: "user",
          sensitive: false,
          beforeDigest: contentDigest(lastReceipt),
          afterDigest: contentDigest(updated),
          reason: "record this generation's remaining destinations",
        });
        lastReceipt = updated;
      }
    },
  );
}
