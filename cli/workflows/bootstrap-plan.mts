import { BOOTSTRAP_PATHS } from "../bootstrap/constants.mjs";
import { readEnvironmentValues } from "../bootstrap/environment.mjs";
import { createBootstrapPlan, publicPlan } from "../bootstrap/plan.mjs";
import { ownershipError } from "../errors.mjs";
import { contentDigest } from "../shared/files.mjs";
import { mcpAppOptions } from "./options.mjs";

type Options = import("../types.mjs").BootstrapCommandOptions;
type Prepared = import("../types.mjs").McpAppPrepared;
type Mode = import("../types.mjs").McpAppMode;

export function planBootstrap(
  {
    options,
    cwd,
    skillMode,
    mcpAppPrepared,
    materializeSecrets,
  }: {
    options: Options;
    cwd: string;
    skillMode: import("../types.mjs").AgentSkillMode;
    mcpAppPrepared: Prepared | null;
    materializeSecrets: boolean;
  },
  createPlan = createBootstrapPlan,
) {
  const requested = mcpAppPrepared ? mcpAppOptions(options) : undefined;
  let modes: { targetMode?: Mode; providerMode?: Mode } = {};
  if (requested && options.preserveLifecycle && !options.activate && mcpAppPrepared?.persisted) {
    const root = options.targetPath ?? cwd;
    const tama = readEnvironmentValues(root, BOOTSTRAP_PATHS.environment).get("TAMA_MCP_APP_MODE");
    const provider = readEnvironmentValues(root, mcpAppPrepared.identity.environmentFile).get(
      mcpAppPrepared.persisted.bindings.mode,
    );
    if (
      !["disabled", "prepared", "enabled"].includes(tama ?? "") ||
      !["disabled", "prepared", "enabled"].includes(provider ?? "")
    ) {
      throw ownershipError("cannot resume an integration with missing or invalid lifecycle modes");
    }
    modes = { targetMode: tama as Mode, providerMode: provider as Mode };
  }
  const input = {
    cwd,
    developerOwned: options.developerOwned,
    resumePending: options.resumePending,
    generationId: materializeSecrets ? options.generationId : "pending-bootstrap-operation",
    targetPath: options.targetPath,
    composePath: options.composePath,
    port: options.port,
    image: options.image,
    skillMode,
    mcpAppPrepared,
    materializeSecrets,
  };
  let plan = createPlan({
    ...input,
    mcpApp:
      requested && options.activate
        ? { ...requested, activate: false, targetMode: "prepared", preserveEnabledProvider: true }
        : requested
          ? { ...requested, ...modes }
          : undefined,
  });
  if (options.activate && requested && plan.mcpApp?.providerLifecycle === "enabled") {
    plan = createPlan({
      ...input,
      mcpApp: { ...requested, activate: true, targetMode: "enabled", providerMode: "enabled" },
    });
  }
  return plan;
}

/** Compare only non-materialized plans; their placeholders and digests are stable. */
export function reviewedPlanDigest(plan: import("../types.mjs").BootstrapPlan) {
  return contentDigest(JSON.stringify(publicPlan(plan)));
}
