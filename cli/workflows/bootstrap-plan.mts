import { createBootstrapPlan, publicPlan } from "../bootstrap/plan.mjs";
import { contentDigest } from "../shared/files.mjs";
import { mcpAppOptions } from "./options.mjs";

type Options = import("../types.mjs").BootstrapCommandOptions;
type Prepared = import("../types.mjs").McpAppPrepared;

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
  const input = {
    cwd,
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
  return createPlan({
    ...input,
    mcpApp: requested,
  });
}

/** Compare only non-materialized plans; their placeholders and digests are stable. */
export function reviewedPlanDigest(plan: import("../types.mjs").BootstrapPlan) {
  return contentDigest(JSON.stringify(publicPlan(plan)));
}
