# Recover private environment files after cloning

A bootstrapped project usually commits Compose, Terraform, contracts and public
examples while ignoring private environment files. From the application project
root, inspect and preview recovery before writing:

```bash
tama-kit env doctor --json
tama-kit env init --dry-run --json
tama-kit env init --json
tama-kit env doctor --json
```

Use `npx @kritama/tama-kit` in place of `tama-kit` if the CLI is not installed.
Review the preview's blockers before running the write command. Both environment
commands never prompt, including in an interactive terminal.

The Docker CLI and Compose plugin must support native configuration inspection
with `config --format json --no-env-resolution`. Missing files can use the
native literal-path fallback on older Compose releases; unresolved interpolated
destinations need corrected declarations or supported newer tooling. Env doctor
does not need a running daemon. Init probes persistence before issuing secrets;
failed probes leave that state unknown rather than proving the runtime is fresh.

`env doctor` inspects declared environment files without writing or probing
persistence. `env init` creates only missing supported required files, with
owner-only permissions (0600). It preserves existing files, keys, modes and
overlap sets; it does not repair malformed files or rotate surviving keys. A
healthy complete project returns a no-op. Optional absent files are informational
and never auto-created. Restore unsupported application files through the
application's own workflow.

## Select the current configuration

| Option | Meaning |
| --- | --- |
| `[path]` | Application project root; defaults to the working directory |
| `--compose <path>` | Repeatable Compose roots and overrides, in their current order |
| `--service <name>` | Tama service, especially when several services share a core file |
| `--env-file <path>` | Declared Tama environment destination, even if its file is missing |
| `--contract <path>` | Project-owned local MCP App contract |
| `--provider-service <name>` | Compose provider service; omit for a host provider |

Selection paths are relative to the project root. Preserve the target path and
all selected options between diagnosis, preview, recovery and setup. For an
additive integration, include its override after the original Compose roots:

```bash
tama-kit env doctor './my app' \
  --compose compose.yaml --compose tama/compose.mcp-app.yaml \
  --service tama --env-file tama/.tama.env \
  --contract tama/contracts/mcp-app-provider-v1.json \
  --provider-service application --json

tama-kit env init './my app' \
  --compose compose.yaml --compose tama/compose.mcp-app.yaml \
  --service tama --env-file tama/.tama.env \
  --contract tama/contracts/mcp-app-provider-v1.json \
  --provider-service application --dry-run --json
```

Replace the illustrative project and provider service names with your current
configuration. After a successful preview, repeat init without `--dry-run`.
Proxy-service, CA and Terraform-root options belong to `setup`/`doctor`, not
the environment commands.

Recovery reads current native Compose `env_file` layers and inline precedence,
the selected local contract, public examples and surviving private files.
Receipts are history and unfinished-operation progress; they do not describe
desired configuration or authorize recovery. Resume an incomplete generation
with its original options and operation ID before recovering files. Completed
bootstrap or `generate mcp-app` reruns do not recreate deleted output.

## Public inputs and supported files

Standard recovery uses `tama/.tama.env.example` and the effective Compose public
identity. It can recreate missing `.tama.env` and `.tama.postgres.env` files.
A missing PostgreSQL companion is derived from surviving core credentials
without issuing new secrets.

Combined MCP App recovery reads integration settings from the core example.
Additive recovery also uses `.mcp-app.env.example`. The selected local contract
identifies the provider fragment and exact variable bindings; its sibling
`.example` supplies public provider inputs. New generation supplies these public
examples without private signing material. Keep origins, ports, allowed origins,
bindings and Compose declarations consistent as the project evolves. Examples
do not override later effective Compose settings.

Older projects may lack enough public inputs, particularly the browser origin
list after losing an HTTP Tama fragment. Restore public configuration from the
project's intended layout or restore a private backup; the CLI reports blockers
instead of guessing. Invalid or missing required local contracts block MCP App
recovery. Init does not recreate contracts, Compose, Terraform, TLS material,
application files or receipts.

## Persistence and `--fresh`

Before issuing new secrets, init checks the associated Tama database. MCP App
recovery also checks the associated Compose provider database, relevant direct
data mounts and running or stopped provider containers. Detected runtime data
refuses issuance even with `--fresh`. Restore the original private files from a
secure backup when retaining that data; recovery is not a key-rotation or
database-reset workflow.

Existing relevant volumes or provider containers and nonempty data binds count
as persistence evidence. The CLI does not prove that an existing volume is empty.

A host provider, external database, unavailable daemon or unobservable
persistence can require an explicit fresh-runtime assertion. Only if the
selected runtime and provider have no state depending on the missing secrets,
carry your configuration selection into:

```bash
tama-kit env init --fresh --dry-run --json
tama-kit env init --fresh --json
```

`--fresh` asserts an unknown state; it neither deletes data nor bypasses detected
data or ambiguous database associations. Init rechecks persistence and current
sources during its create transaction and rolls back new files when they change
or become unsafe. Derived-only PostgreSQL recovery can succeed with persisted
data because it retains the surviving credentials.

## Complete setup after recovery

New MCP App signing material uses independent provider access-token and Tama
introspection keys in prepared mode. A conflicting surviving or effective peer
mode blocks issuance; enabled peers are not silently reset. Load the provider
fragment through its application-owned workflow and verify both services in
prepared mode before `tama-kit setup ... --activate`. The application owns its
provider mode change and restart. See the [MCP App workflow](mcp-app-provider-bootstrap.md).

For local HTTPS, prepare missing certificates and trust through the project's
mkcert instructions before setup. Keep Caddy's public HTTPS identity distinct
from Tama's upstream port. Recovery does not install trust or create certificates.

Run the printed setup command with the same selection to start and verify the
runtime. Complete private root/provisioner onboarding separately and store
`TAMA_CLIENT_ID` and `TAMA_CLIENT_SECRET` locally. Empty provisioner credentials
are expected until onboarding; never paste them or private setup URLs into chat.
Review native Terraform init, validation and plan before an authorized apply.

Human and JSON results contain filenames, statuses, blockers and next actions,
not secret contents. An environment diagnosis or completed write does not prove
runtime health, OAuth activation or Terraform provisioning. Successful results
exit 0; missing/invalid required files or init blockers exit 4. Other argument,
tooling and execution failures retain their own CLI error category and exit code.
