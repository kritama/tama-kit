import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readGenerationEvidence } from "../bootstrap/generation-receipt.mjs";
import { localHttpsPaths } from "../bootstrap/local-https.mjs";
import { normalizeGenerationPath, parseGenerationReceipt } from "../domain/generation.mjs";
import { ownershipError } from "../errors.mjs";
import { contentDigest } from "../shared/files.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";
import type { BootstrapPlan } from "../types.mjs";

/** Keep crash progress with the transaction, without any permanent content fingerprints. */
export async function writeScaffold(
  plan: BootstrapPlan,
  validate: () => void | Promise<void>,
  receiptPath = "tama/.tama-kit.json",
) {
  const path = join(plan.root, receiptPath);
  const completeOperation = plan.operations.find((operation) => operation.path === path);
  if (!completeOperation || !("content" in completeOperation))
    throw new Error("generation receipt is missing from the write plan");
  const complete = parseGenerationReceipt(JSON.parse(completeOperation.content));
  const previous = readGenerationEvidence(path);
  const pending = new Set(
    previous.kind === "receipt" && previous.receipt.progress.status === "incomplete"
      ? previous.receipt.progress.pendingDestinations
      : plan.operations
          .filter((operation) => operation.action === "create" && operation.path !== path)
          .map((operation) => normalizeGenerationPath(relative(plan.root, operation.path))),
  );
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
          (operation) =>
            normalizeGenerationPath(relative(plan.root, operation.path)) === destination,
        )
      )
        throw ownershipError("resume requires the original options for every pending destination", {
          path: destination,
        });
  }
  if (!pending.size) return applyOperationsTransactionally(plan.operations, validate);
  const grouped = new Map<string, string[]>();
  if (plan.localHttps) {
    // The generated certificate, private key, and root CA are one recovery
    // unit: retain every member in the receipt until all three are published.
    const paths = localHttpsPaths(plan.root);
    const tls = [paths.certificate, paths.privateKey, paths.rootCertificate].map((destination) =>
      normalizeGenerationPath(relative(plan.root, destination)),
    );
    for (const destination of tls) grouped.set(destination, tls);
  }
  const completed = new Set<string>();
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
      const destination = normalizeGenerationPath(relative(plan.root, operation.path));
      if (operation.path === path || !pending.has(destination)) return;
      completed.add(destination);
      const group = grouped.get(destination)?.filter((member) => pending.has(member)) ?? [
        destination,
      ];
      if (!group.every((member) => completed.has(member))) return;
      for (const member of group) pending.delete(member);
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
