// @ts-check

import { relative } from "node:path";
import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";
import { BOOTSTRAP_PATHS } from "./constants.mjs";

/**
 * @param {import("../types.mjs").BootstrapPlan} plan
 * @param {{setupUrl?: string}} [options]
 */
export function formatAgentSetupPrompt(plan, { setupUrl } = {}) {
  const composeFile = relative(plan.root, plan.composeFile);
  const composeUp = formatComposeUpCommand(composeFile);
  const composePs = formatComposePsCommand(composeFile);
  const mcpAppGuidance = plan.mcpApp
    ? [
        "",
        `This repository also has an MCP App provider integration for ${plan.mcpApp.provider.name}. Treat ${plan.mcpApp.provider.environmentFile} and ${BOOTSTRAP_PATHS.environment} as private; never print their values.`,
        `Use the exact provider issuer ${plan.mcpApp.providerOrigin} and Tama resource ${plan.mcpApp.resource}; do not substitute localhost, 127.0.0.1, or ::1 for one another.`,
        "Do not activate or restart the host-native provider on my behalf. If activation is requested, verify the prepared checkpoint first, enable and restart Tama through bootstrap, then give me the provider-owned mode change and restart step.",
      ]
    : [];

  return [
    "Finish setting up the local Tama runtime and Terraform root in this repository.",
    "",
    "Read tama/AGENTS.md and tama/README.md first. Use the graph-builder skill if it is available; otherwise continue from the repository instructions.",
    "",
    "You are authorized to run the safe local setup and validation commands below without asking first:",
    `1. From the project root, run \`${composeUp}\`.`,
    `2. Run \`${composePs}\` and wait until Tama responds successfully at http://localhost:${plan.port}/. If startup fails, inspect bounded Compose status and logs and explain the failure.`,
    setupUrl
      ? `3. If I explicitly ask you to complete guided setup, open the private onboarding URL ${setupUrl} in the in-app browser, then walk me through creating the root user, signing in, and creating provisioner credentials. This private onboarding URL is supplied in the private setup instruction; do not repeat it or its token elsewhere in chat or logs. If browser control is unavailable, direct me to tama/README.md without reproducing the token.`
      : `3. The private onboarding URL is derived locally from ${BOOTSTRAP_PATHS.environment}. If I explicitly ask you to complete guided setup, open it in the in-app browser without printing its setup token. Walk me through creating the root user, signing in, and creating provisioner credentials. If browser control is unavailable, direct me to tama/README.md without reproducing the token.`,
    `Do not ask me to paste credentials into chat. Have me store TAMA_CLIENT_ID and TAMA_CLIENT_SECRET directly in ${BOOTSTRAP_PATHS.environment}, then wait for me to confirm that step is complete.`,
    `4. After I confirm, load ${BOOTSTRAP_PATHS.environment} without echoing its values, then run \`terraform -chdir=tama init\`, \`terraform -chdir=tama fmt -check -recursive\`, \`terraform -chdir=tama validate\`, and \`terraform -chdir=tama plan\`.`,
    "5. Summarize the Terraform plan, including any create, update, replace, or destroy actions and any unresolved errors.",
    ...mcpAppGuidance,
    "",
    "Do not run terraform apply until I explicitly approve it after seeing the plan. If I approve, apply it, verify the result, and report the local Tama URL plus any remaining setup steps. Stop and ask for my input only when the interactive browser setup or apply approval is required.",
  ].join("\n");
}
