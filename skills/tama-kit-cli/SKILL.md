---
name: tama-kit-cli
description: Bootstrap application repositories with a local Tama runtime, prepare and activate MCP App provider integrations, set up Tama source checkouts, and generate standalone Tama OAuth keys with the Tama Kit CLI. Use when a user asks to bootstrap or integrate an app with Tama, choose Tama Kit flags, continue a staged MCP App setup, or troubleshoot a Tama Kit command.
---

# Tama Kit CLI

Use Tama Kit to turn the user's requested integration into a safe, repeatable
repository change. Inspect the target repository and preserve its instructions,
existing Compose configuration, managed Tama files, and unrelated work.

## Route the request first

When the user asks generally to “bootstrap my app to work with Tama” or gives
equivalent ambiguous instructions, ask this before choosing a command:

> Is this application an MCP App provider that needs OAuth-protected access to
> Tama's `/mcp/app` endpoint, or a standard app that only needs a local Tama
> runtime and Terraform root?

Do not ask when the user has already identified the path. Do not infer MCP App
mode merely because the application uses MCP somewhere else.

Choose among these workflows:

- Standard application repository: `tama-kit bootstrap` without `--mcp-app`.
- MCP App provider repository: `tama-kit bootstrap --mcp-app`.
- A checkout of Tama itself for native Phoenix development: `tama-kit dev setup`.
- A deployment that only needs a System OAuth signing key: `tama-kit oauth generate-key`.

Read [the CLI reference](references/cli-reference.md) after selecting a workflow
or when explaining flags, diagnosing a rejection, rerunning bootstrap, changing
ports, migrating provider identity, or activating an MCP App integration.

## Inspect before running

1. Read the target repository's `AGENTS.md` and inspect its Git status, framework,
   Compose files, existing `tama/` directory, `.tama.env*` files, and
   `tama/.tama-kit.json` when present.
2. Confirm Node.js 20.12 or newer. Prefer an already installed `tama-kit`
   executable; otherwise use `npx @kritama/tama-kit` without installing it
   globally.
3. Read the installed command's `--help` before relying on remembered flags.
4. Ask only for values that cannot be established from repository evidence.
   Never ask the user to paste private JWKs, tokens, passwords, or the private
   Tama setup URL into chat.

## Plan, then write

Use `--dry-run --json` first. Since JSON mode cannot prompt, always make the
agent-skill choice explicit with `--skills local` or `--skills manual`.
Recommend `local` when the user wants future agents in this repository to have
Tama Kit's skills; respect an existing recorded choice.

Review the JSON plan for the selected root, Compose file, host port, image,
managed-file operations, sensitive-file markers, and Terraform foundation
ownership. A dry run does not generate reusable secret material and must not be
treated as proof that the runtime is ready.

If the plan matches the user's request, rerun the same command without
`--dry-run`. Keep `--json` so output is deterministic and token-redacted. Add
`--start` only when the user wants the local services started and the required
Docker Compose runtime is available.

Stop and explain managed-file drift, ambiguous foundation ownership, tracked
secret files, unsafe paths, unsupported images, or conflicting topology. Do not
overwrite files, delete state, rotate keys, or reset the manifest to bypass a
safety refusal. Never run `terraform apply` without explicit authorization.

## Standard application bootstrap

Run from the application root or pass its path. Let Tama Kit detect the
framework and Compose file unless discovery is ambiguous; use `--compose` to
select the intended existing file. Use `--port` or `--image` only for an actual
project requirement.

After the write, verify the reported managed files are untracked as intended
and that the working tree contains only expected changes. If the runtime was
started, verify the reported health result. Hand off the generated
`tama/README.md` and `tama/AGENTS.md` instructions for onboarding and Terraform
planning, while keeping the private setup URL out of the response.

## MCP App provider bootstrap

Run this workflow from the provider application's repository. First inspect
whether the application already provides the exact OAuth 2.1 capabilities
required by the bundled `app-integration` skill. Classify it as ready, partial,
or absent; generic OAuth for another resource is not sufficient.

If it is ready, reuse the implementation and verify the exact contract before
provisioning. If it is partial, explain the missing capabilities. If it has no
OAuth provider, explicitly tell the user that an application-side OAuth
provider integration is a prerequisite for usable `/mcp/app` access. Tama Kit
only provisions configuration and trust material. Unless provider
implementation was already authorized, ask whether the user wants that larger
prerequisite implemented and do not activate or describe the app as ready.
Route authorized provider work through `app-integration` when available.

Before planning the CLI command, also establish:

- the explicit provider identity when a committed provider contract does not
  supply it;
- one provider origin reachable from both the host and Tama container;
- the exact loopback Tama origin and matching Tama host port;
- every browser or MCP client origin that should be allowed; and
- a pinned Tama image accepted by the installed bootstrap contract.

Allow Tama Kit to discover
`priv/contracts/tama-mcp-app-bootstrap-v1.json`, or use `--mcp-app-contract` for
an intentional non-default contract. The application owns that file; do not
generate or rewrite it. Tama Kit owns the generated non-secret local projection
at `tama/contracts/mcp-app-provider-v1.json` and the managed environment
fragments. Contract presence is not proof that the provider loads its fragment
or implements the live OAuth endpoints.

The CLI does not implement the application's authorization, consent,
persistence, token, revocation, or introspection behavior. An explicitly
requested configuration-only write may stage an incomplete provider in
`prepared`, but report it as unverified and never follow it with activation.

Prepare first without `--activate`. Provider and Tama modes remain staged while
the application is configured to load the reported provider fragment. Use
`--start --activate` only when the user explicitly wants activation and the
provider can be run in prepared mode. Follow the command's two-step handoff:
Tama Kit may enable and verify Tama, but the user or provider-owned workflow
must set the reported provider mode to `enabled` and restart the provider before
the same activation command is rerun. Report prepared, activation-required,
enabled, and verification states distinctly.

Treat provider identity and public scheme/host as stable topology. Use
`--migrate-provider-identity` only for a deliberate migration that the user
requested and only after the new provider loader is ready; do not combine it
with activation.

## Finish with evidence

Report the command mode, expected file changes, runtime start/health state,
MCP App lifecycle and verification state when applicable, and any external
steps still owned by the user. Distinguish generated configuration from live
runtime verification. Never reproduce secret values or private setup URLs.
