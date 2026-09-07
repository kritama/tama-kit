import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownershipError } from "../errors.mjs";
import { inspectRegularFile, operationForContent } from "../shared/files.mjs";
import { validateSecretFilesIgnored, validateSecretFilesUntracked } from "../shared/git.mjs";
import type { BootstrapPlan } from "../types.mjs";

/** Only the selected, unshadowed mode assignment is writable. No templates or provider writes. */
export function planTamaModeChange(plan: BootstrapPlan) {
  const source = plan.runtime?.modeSource;
  if (plan.runtime && !source)
    throw ownershipError(
      "TAMA_MCP_APP_MODE has no single safely editable env_file source. Set TAMA_MCP_APP_MODE=enabled in the selected service's effective configuration, restart that service, then rerun tama-kit setup --activate.",
    );
  const path = source?.path ?? join(plan.root, "tama/.tama.env");
  if (!inspectRegularFile(path))
    throw ownershipError("Tama's selected mode file is missing", { path });
  validateSecretFilesUntracked(plan.root, [path]);
  validateSecretFilesIgnored(plan.root, [path]);
  const before = readFileSync(path, "utf8");
  const expression =
    /^([ \t]*(?:export[ \t]+)?TAMA_MCP_APP_MODE[ \t]*=[ \t]*)(["']?)(prepared)\2([ \t]*(?:#[^\r\n]*)?)(\r?)$/gmu;
  const matches = [...before.matchAll(expression)];
  if (matches.length !== 1)
    throw ownershipError(
      "TAMA_MCP_APP_MODE must be one simple prepared assignment; edit its current source manually and resume setup",
      { path },
    );
  const originalLine = matches[0][0];
  const enabledLine = `${matches[0][1]}${matches[0][2]}enabled${matches[0][2]}${matches[0][4]}${matches[0][5]}`;
  const after = before.replace(expression, () => enabledLine);
  const operation = operationForContent(path, after, {
    owner: "user",
    sensitive: true,
    allowUnmanagedUpdate: true,
  });
  const environment = new Map(plan.mcpApp?.tamaEnvironment ?? plan.runtime?.environment);
  environment.set("TAMA_MCP_APP_MODE", "enabled");
  const enabledPlan: BootstrapPlan = {
    ...plan,
    operations: [operation],
    ...(plan.runtime
      ? { runtime: { ...plan.runtime, environment, modeSource: { path, value: "enabled" } } }
      : {}),
    mcpApp: plan.mcpApp
      ? { ...plan.mcpApp, lifecycle: "enabled", tamaEnvironment: environment }
      : null,
  };
  return {
    operation,
    plan: enabledPlan,
    restore() {
      if (!inspectRegularFile(path))
        throw ownershipError(
          "activation mode file was removed; recovery requires manual inspection",
          { path },
        );
      const current = readFileSync(path, "utf8");
      // Preserve unrelated edits, but never overwrite a changed mode assignment.
      const lines = current.split("\n");
      if (
        lines.filter((line) => /^[ \t]*(?:export[ \t]+)?TAMA_MCP_APP_MODE[ \t]*=/u.test(line))
          .length !== 1 ||
        lines.filter((line) => line === enabledLine).length !== 1
      ) {
        throw ownershipError(
          "activation mode was edited during verification; recovery requires manual inspection",
          { path },
        );
      }
      return operationForContent(
        path,
        lines.map((line) => (line === enabledLine ? originalLine : line)).join("\n"),
        { owner: "user", sensitive: true, allowUnmanagedUpdate: true },
      );
    },
  };
}
