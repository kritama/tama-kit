// @ts-check

import { resolve } from "node:path";
import { BOOTSTRAP_PATHS } from "./constants.mjs";
import { readEnvironmentValues } from "./environment.mjs";

/** @param {import("../types.mjs").BootstrapPlan} plan @param {{dryRun: boolean, started: boolean, terraformRoot?: string}} status */
export function setupProgress(plan, { dryRun, started, terraformRoot = "tama" }) {
  const environment =
    plan.runtime?.environment ?? readEnvironmentValues(plan.root, BOOTSTRAP_PATHS.environment);
  const mcp = plan.mcpApp;
  const provider = mcp?.provider;
  const tamaMode = mcp?.lifecycle ?? (provider ? environment.get("TAMA_MCP_APP_MODE") : null);
  const providerMode = mcp?.providerLifecycle ?? null;
  const verified = !dryRun && plan.mcpAppVerification?.verified === true;
  const restartRequired = tamaMode === "enabled" && providerMode === "prepared";
  const phase = dryRun
    ? "planned"
    : verified && tamaMode === "enabled" && providerMode === "enabled"
      ? "enabled"
      : restartRequired
        ? "provider-restart-required"
        : tamaMode === "enabled" && providerMode === "enabled"
          ? "verification-required"
          : started
            ? "running"
            : "configured";
  /** @type {Array<{id: string, workingDirectory: string, description: string}>} */
  const nextActions = [];
  const add = (
    /** @type {string} */ id,
    /** @type {string} */ description,
    workingDirectory = plan.root,
  ) => nextActions.push({ id, workingDirectory, description });
  if (dryRun)
    add("review-and-prepare", "Review the proposed changes, then prepare the configuration.");
  if (!dryRun) {
    if (!started)
      add(
        "start-runtime",
        "Run tama-kit setup to start the selected services; verify Docker and Compose first.",
      );
    if (!environment.get("TAMA_CLIENT_ID") || !environment.get("TAMA_CLIENT_SECRET")) {
      add(
        "complete-root-setup",
        plan.runtime?.environmentFile
          ? `Follow the project README to create the root user and provisioner credentials through the private browser setup. Store credentials directly in ${plan.runtime.environmentFile}.`
          : "Follow the project README to create the root user and provisioner credentials through the private browser setup. Rerun tama-kit setup with --env-file selecting the loaded private environment before storing credentials.",
      );
    }
    add(
      "review-foundation",
      "Load the current private provisioner environment; run terraform init, fmt -check, validate, and plan. Review and explicitly authorize apply, then provision an active root recipient. Provisioner credentials are not MCP-client credentials.",
      resolve(plan.root, terraformRoot),
    );
    if (provider && phase !== "enabled") {
      if (mcp?.environmentLoading !== "verified")
        add(
          "configure-provider-loader",
          `Have the application load ${provider.environmentFile} and run the OAuth provider in its configured mode.`,
        );
      if (restartRequired)
        add(
          "restart-provider-enabled",
          `Set the provider's ${mcp?.bindings.roles.mode} to enabled and restart it using the application-owned workflow; rerun tama-kit setup to continue verification.`,
        );
      else
        add(
          "activate-mcp-app",
          "When the provider and foundation are ready, rerun tama-kit setup and select staged activation. Prepared /mcp/app returns 404 intentionally. Follow the provider mode-change/restart handoff, then rerun to verify both services.",
        );
    }
    if (provider)
      add(
        "connect-mcp-client",
        "After live enabled verification, connect an OAuth MCP client using authorization code with PKCE. Never give it the Terraform provisioner secret.",
      );
  }
  return {
    phase,
    tamaMode: tamaMode ?? null,
    providerMode: providerMode ?? null,
    runtimeVerified: verified,
    runtimeHealth: !dryRun && started ? "checked-this-run" : "not-checked",
    foundation: "not-verified",
    nextActions,
  };
}

export const SETUP_CHECKLIST = `## Ordered setup checklist

1. From the application root, run \`tama-kit doctor\` to inspect configuration,
   then \`tama-kit setup\` to start and verify current services.
   For local HTTPS, install mkcert if needed and authorize local CA trust only
   when requested. The CLI does not install Docker or start its daemon.
2. Configure the provider's application-owned environment loader when using
   MCP App mode. Choose to start the runtime; check service health through the
   generated public URL. For HTTPS probes from the application root, use
   \`--cacert tama/tls/rootCA.pem\`.
3. Complete the private browser root-user setup described below, sign in, and
   create provisioner credentials. Store them directly in \`tama/.tama.env\`.
4. From \`tama/\`, load \`.tama.env\` privately, then run \`terraform init\`,
   \`terraform fmt -check -recursive\`, \`terraform validate\`, and \`terraform plan\`.
   Review the plan before explicitly authorizing apply. Provision the global
   foundation and an active root recipient before connecting an MCP client.
   CLI configuration and existing Terraform files do not prove provisioning.
5. For MCP App mode, run the provider in prepared mode and rerun
   \`tama-kit setup --activate\` from the application root. Choose staged activation
   only when the provider is ready. A prepared \`/mcp/app\` returning 404 is
   expected. The first activation verifies prepared services and enables Tama.
6. Set the reported provider mode to enabled and restart the provider through
   its application-owned workflow. Rerun tama-kit setup and choose verification;
   only live verification of both enabled services completes activation.
7. Connect an OAuth MCP client with authorization code and PKCE. Its OAuth
   identity is separate from Terraform's \`TAMA_CLIENT_ID\`/\`TAMA_CLIENT_SECRET\`
   and Tama's private-key introspection identity. Never share those private
   credentials or the setup URL with an MCP client.

At a handoff, rerun \`tama-kit setup\` to continue from current configuration.
Generated files are project-owned; edit them directly without changing receipts. The CLI does not run Terraform apply or implement provider OAuth.
`;
