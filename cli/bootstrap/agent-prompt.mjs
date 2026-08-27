// @ts-check

import { relative } from "node:path";

import { formatComposePsCommand, formatComposeUpCommand } from "./compose-command.mjs";

/**
 * @param {import("../types.mjs").BootstrapPlan} plan
 * @param {{setupUrl?: string}} [options]
 */
export function formatAgentSetupPrompt(plan, { setupUrl } = {}) {
  const composeFile = relative(plan.root, plan.composeFile);
  const composeUp = formatComposeUpCommand(composeFile);
  const composePs = formatComposePsCommand(composeFile);

  return [
    "Finish setting up the local Tama runtime and Terraform root in this repository.",
    "",
    "Read tama/AGENTS.md and tama/README.md first. Use the graph-builder skill if it is available; otherwise continue from the repository instructions.",
    "",
    "You are authorized to run the safe local setup and validation commands below without asking first:",
    `1. From the project root, run \`${composeUp}\`.`,
    `2. Run \`${composePs}\` and wait until Tama responds successfully at http://localhost:${plan.port}/. If startup fails, inspect bounded Compose status and logs and explain the failure.`,
    setupUrl
      ? `3. Guide me through Tama's interactive first-run setup. The private onboarding URL is ${setupUrl}. Tell me to open that URL, create the root user, sign in, and create provisioner credentials. The URL contains a setup token; do not repeat it after this prompt or include it in logs.`
      : "3. Guide me through Tama's interactive first-run setup described in tama/README.md. Have me derive the private onboarding URL locally from .tama.env without printing its setup token into chat, then create the root user, sign in, and create provisioner credentials.",
    "Do not ask me to paste credentials into chat. Have me store TAMA_CLIENT_ID and TAMA_CLIENT_SECRET directly in .tama.env, then wait for me to confirm that step is complete.",
    "4. After I confirm, load .tama.env without echoing its values, then run `terraform -chdir=tama init`, `terraform -chdir=tama fmt -check -recursive`, `terraform -chdir=tama validate`, and `terraform -chdir=tama plan`.",
    "5. Summarize the Terraform plan, including any create, update, replace, or destroy actions and any unresolved errors.",
    "",
    "Do not run terraform apply until I explicitly approve it after seeing the plan. If I approve, apply it, verify the result, and report the local Tama URL plus any remaining setup steps. Stop and ask for my input only when the interactive browser setup or apply approval is required.",
  ].join("\n");
}
