# Tama Source Development HTTP Port Selection — Implementation Plan

Status: implemented
Branch: `feature/dev-http-port-selection` (from `develop`)
Companion contract: `upmaru/tama/wip/memovee-cli-bootstrap-contract.md`

## 0. Problem and decisions

Tama Kit currently writes `export PORT=4000` into every new source-development
`.envrc`. The Memovee MCP App integration contract reserves loopback port 4000
for Memovee and port 4001 for Tama, but `tama-kit dev setup` cannot select the
Tama HTTP port. Another tool would therefore have to rewrite a Tama Kit-owned
file, or Tama would advertise `http://127.0.0.1:4001/mcp/app` while Phoenix
still listens on port 4000.

This change establishes the following behavior:

- `tama-kit dev setup [path] --port <port>` owns the Tama Phoenix `PORT`
  selection. `--postgres-port` remains independent and continues to control
  only the repository-owned Compose PostgreSQL service.
- New generated development environments default to Tama port 4001, matching
  Tama's checked-in `.envrc.example` and the Memovee integration topology.
- Existing valid `.envrc` files preserve their current `PORT` when `--port` is
  omitted. A default change must not silently move an established checkout.
- Passing `--port` is an explicit, idempotent request to update only the
  existing `export PORT=...` line. Generated secrets and PostgreSQL settings
  remain byte-for-byte unchanged.
- Dry-run and JSON modes report the effective Tama port without exposing the
  setup URL, setup token, database password, vault key, or JWT secret.
- Memovee CLI invokes the public interface; it never edits `.envrc` directly:

  ```text
  tama-kit dev setup <path> --port 4001 --postgres-port 55432 --json
  ```

Container bootstrap remains separate. Its host-port and container-port
contract is not changed by this source-development feature.

## 1. Command parsing: `cli/commands/dev.mjs`

- Add `port?: number` to `DevCommandOptions`.
- Add `--port <port>` to `dev setup` help immediately before
  `--postgres-port` and describe it as the native Phoenix loopback port.
- Generalize the current PostgreSQL-only parser into a named port parser so
  errors identify either `port` or `postgres port`.
- Accept decimal integers in `1..65535`; reject missing values, non-integers,
  zero, and values above 65535 as usage errors.
- Pass `port` to `createDevSetupPlan` as `tamaPort`.
- Add the effective native endpoint to human output:

  ```text
  Tama: native Phoenix at http://127.0.0.1:4001
  ```

  Keep it informational and non-secret. Commands and URLs remain copyable
  single logical lines.

## 2. Environment planning: `cli/dev/environment.mjs`

Replace the positional `planDevEnvironment(root, requestedPort)` interface,
whose port currently means PostgreSQL, with named options:

```text
planDevEnvironment(root, { tamaPort, postgresPort })
```

Implementation rules:

1. Change `DEFAULT_TAMA_PORT` from 4000 to 4001 for newly generated files.
2. Parse and validate the existing `PORT` alongside the two PostgreSQL ports.
   Return both validated effective values from the validation step rather than
   reparsing `PORT` later with a fallback.
3. Add `updateTamaPort(content, port)` that replaces exactly one
   `export PORT=...` line. It must not match `POSTGRES_PORT` or
   `POSTGRES_TEST_PORT`.
4. When `tamaPort` is omitted, preserve the validated existing value. When it
   is supplied, update only `PORT` before the final validation pass.
5. Continue using `operationForContent` with sensitive mode `0600`; do not add
   a direct write path.
6. Reject a Tama HTTP port equal to the effective PostgreSQL host port because
   both services bind on loopback and cannot coexist.
7. Preserve the current managed-environment upgrade behavior and every
   generated secret. Re-running the same requested port must produce only
   `unchanged` operations.

The setup URL reader and child-process environment already consume `PORT`
from the planned `.envrc`; they should require no alternate source of truth.

## 3. Plan and public result: `cli/dev/plan.mjs`, `cli/types.mjs`

- Extend `createDevSetupPlan` options with `tamaPort?: number` and pass named
  port options into `planDevEnvironment`.
- Keep `DevSetupPlan.tamaPort` as the single effective Tama HTTP port.
- Preserve the current JSON field `tamaPort`; it must reflect the requested,
  preserved, or new default value exactly.
- Do not include the private setup URL or any environment values in
  `publicDevSetupPlan`.
- Update JSDoc types so Tama and PostgreSQL ports cannot be accidentally
  interchanged.

## 4. Documentation and cross-repository contract

Update Tama Kit's README development section to document:

- new checkouts default to `http://127.0.0.1:4001`;
- `--port` changes only the native Phoenix port;
- `--postgres-port` changes only the Compose PostgreSQL port;
- existing checkouts retain their current `PORT` unless `--port` is supplied;
- the canonical paired command for Memovee integration.

The matching Tama repository work is:

- `.envrc.example` uses `PORT=4001`;
- Phoenix development listener and all Tama-owned local public URLs use 4001;
- Memovee authorization, JWKS, and introspection URLs use 4000;
- production and container-internal port defaults remain unchanged.

Memovee remains the only writer of `.tama.memovee.integration.env`. Tama Kit
may load that root-ignored fragment in the companion bootstrap work, but port
selection stays in `.envrc` and is performed through `--port`.

## 5. Tests

Add focused cases to `test/cli/dev.test.mjs`:

1. A new environment defaults to `PORT=4001` and reports `tamaPort: 4001`.
2. `--port 4567` writes `PORT=4567` without changing either PostgreSQL port.
3. An existing generated `PORT=4000` is preserved when `--port` is omitted.
4. Explicitly moving that environment to 4001 changes only `PORT`; vault,
   JWT, setup-token, and database secrets are unchanged.
5. Repeating the same port selection is idempotent.
6. Invalid Tama ports fail with usage errors that name `port`; invalid
   PostgreSQL ports continue to name `postgres port`.
7. Equal Tama and PostgreSQL loopback ports fail before any write or process
   starts.
8. Dry-run JSON reports `tamaPort` and remains secret-free and non-writing.
9. Human output reports the effective loopback URL without wrapping or
   exposing the private setup URL in JSON/non-interactive output.
10. Existing tracked-file, ignore-order, symlink-ancestor, and mode-0600
    protections continue to pass for `.envrc`.

Tests should exercise both the pure plan functions and the command-level
argument/result contract.

## 6. Verification checkpoints

Run after implementation:

```text
npm test -- test/cli/dev.test.mjs
npm run check
npm run typecheck
npm test
npm pack --dry-run
```

Then verify against a Tama source checkout without enabling `/mcp/app`:

```text
tama-kit dev setup <tama-path> --port 4001 --prepare-only --json
direnv exec <tama-path> sh -c 'test "$PORT" = 4001'
```

Before release, run the full Tama development setup and prove Phoenix listens
on `127.0.0.1:4001`, while the committed MCP App contract continues to name
Memovee at `127.0.0.1:4000`.

## 7. Delivery order and risks

1. Land and release Tama Kit port selection.
2. Update/re-run existing Tama source environments with `--port 4001`.
3. Land the remaining Tama listener, local OAuth/resource URL, setup-script,
   and README changes together.
4. Let Memovee CLI depend on the released Tama Kit interface.
5. Enable `/mcp/app` only after both processes pass the paired-topology
   verification.

Primary risks:

- Changing the generated default does not migrate existing `.envrc` files;
  documentation and bootstrap orchestration must pass `--port 4001`.
- A broad `PORT` replacement could corrupt PostgreSQL exports; use an anchored
  exact-line replacement and tests.
- Port selection could leak private setup URLs through JSON; retain the current
  public-result allowlist.
- Landing Tama's 4001 resource defaults before the listener/setup chain is
  updated recreates the review failure this plan is intended to close.
