import type { McpAppMode } from "../types.mjs";

export type LifecycleCheckpoint =
  | { kind: "prepared"; tama: "prepared"; provider: "prepared" }
  | { kind: "provider-restart-required"; tama: "enabled"; provider: "prepared" }
  | { kind: "enabled"; tama: "enabled"; provider: "enabled" }
  | { kind: "configured"; tama: McpAppMode; provider: McpAppMode };

/** Describes configured modes only; callers separately establish live evidence. */
export function lifecycleCheckpoint(tama: McpAppMode, provider: McpAppMode): LifecycleCheckpoint {
  if (tama === "prepared" && provider === "prepared") return { kind: "prepared", tama, provider };
  if (tama === "enabled" && provider === "prepared")
    return { kind: "provider-restart-required", tama, provider };
  if (tama === "enabled" && provider === "enabled") return { kind: "enabled", tama, provider };
  return { kind: "configured", tama, provider };
}

export type ActivationStep =
  | { kind: "observe"; checkpoint: LifecycleCheckpoint }
  | { kind: "enable-tama"; targetMode: "enabled"; providerMode: "prepared" };

/** Called only after the workflow verifies the currently running services. */
export function activationStep(
  requested: boolean,
  tama: McpAppMode,
  provider: McpAppMode,
): ActivationStep {
  const checkpoint = lifecycleCheckpoint(tama, provider);
  if (requested && checkpoint.kind === "prepared") {
    return { kind: "enable-tama", targetMode: "enabled", providerMode: "prepared" };
  }
  return { kind: "observe", checkpoint };
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected activation step: ${JSON.stringify(value)}`);
}
