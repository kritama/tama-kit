import { resolve } from "node:path";
import {
  type GenerationEvidence,
  type GenerationResult,
  isGenerationPath,
  parseGenerationReceipt,
} from "../domain/generation.mjs";
import { ownershipError } from "../errors.mjs";
import { generationOperationForContent, inspectRegularFile } from "../shared/files.mjs";
import { applyOperationsTransactionally } from "../shared/write.mjs";

/** The caller must establish fresh-generation intent; absent metadata alone is not permission. */
export function planGeneration({
  root,
  evidence,
  destinations,
  resumeOperationId,
}: {
  root: string;
  evidence: GenerationEvidence;
  destinations: { path: string; content: string; sensitive?: boolean; mode?: number }[];
  resumeOperationId?: string;
}): GenerationResult {
  const receipt = evidence.kind === "receipt" ? parseGenerationReceipt(evidence.receipt) : null;
  if (evidence.kind === "legacy" || receipt?.progress.status === "complete") {
    return { status: "existing", operations: [] };
  }
  if (resumeOperationId !== undefined && (!receipt || resumeOperationId !== receipt.operation.id)) {
    throw ownershipError("resume requires the original unfinished generation receipt");
  }
  if (receipt && resumeOperationId === undefined)
    return { status: "resume-required", operations: [] };
  const paths = destinations.map(({ path }) => path);
  if (paths.some((path) => !isGenerationPath(path)) || new Set(paths).size !== paths.length) {
    throw ownershipError("generation destinations must be unique project-relative paths");
  }
  const pending =
    receipt?.progress.status === "incomplete" ? receipt.progress.pendingDestinations : null;
  if (pending?.some((path) => !paths.includes(path))) {
    throw ownershipError("resume plan is missing destinations from the unfinished receipt");
  }
  const operations = destinations
    .filter(({ path }) => !pending || pending.includes(path))
    .map(({ path, content, sensitive, mode }) => {
      const filename = resolve(root, path);
      // A developer may edit files written before interruption; resume never replaces them.
      if (pending && inspectRegularFile(filename) !== null) {
        return {
          action: "preserve" as const,
          path: filename,
          sensitive: sensitive ?? false,
          reason: "resume preserves existing project-owned content",
        };
      }
      return generationOperationForContent(filename, content, { sensitive, mode });
    });
  return {
    status: operations.some(({ action }) => action === "conflict") ? "conflict" : "planned",
    operations,
  };
}

/** Fail the entire plan before writes; preserved files are never chmod'ed or rolled back. */
export async function applyGenerationPlan(
  plan: GenerationResult,
  validate: () => void | Promise<void>,
) {
  if (plan.status === "conflict" || plan.operations.some(({ action }) => action === "conflict")) {
    throw ownershipError("generation destination conflicts; no files were written", {
      paths: plan.operations.filter(({ action }) => action === "conflict").map(({ path }) => path),
    });
  }
  if (plan.status !== "planned") return;
  await applyOperationsTransactionally(
    plan.operations.filter((operation) => operation.action === "create"),
    validate,
  );
}
