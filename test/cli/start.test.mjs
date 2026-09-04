import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  managedComposeServiceExists,
  probeComposeProviderEndpoint,
} from "../../cli/bootstrap/start.mjs";

test("managed Compose service detection distinguishes reruns from unrelated listeners", () => {
  const plan = { root: "/tmp/example", composeFile: "/tmp/example/tama/compose.yaml" };
  const calls = [];
  const exists = managedComposeServiceExists(plan, "caddy", (command, args, options) => {
    calls.push({ command, args, options });
    return "managed-container-id\n";
  });

  assert.equal(exists, true);
  assert.deepEqual(calls[0].args, ["compose", "-f", plan.composeFile, "ps", "-q", "caddy"]);
  assert.equal(
    managedComposeServiceExists(plan, "caddy", () => {
      throw new Error("Docker unavailable");
    }),
    false,
  );
});

test("fetch timeout keeps a top-level await alive until the request is aborted", () => {
  const moduleUrl = new URL("../../cli/bootstrap/start.mjs", import.meta.url).href;
  const script = `
    import { fetchWithTimeout } from ${JSON.stringify(moduleUrl)};

    const stalledFetch = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    try {
      await fetchWithTimeout("http://localhost/", 25, stalledFetch);
    } catch {
      console.log("timed out");
    }
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });

  assert.equal(output.trim(), "timed out");
});

test("local HTTPS provider probes preserve authority while connecting through Caddy", () => {
  const calls = [];
  const plan = {
    root: "/tmp/example",
    composeFile: "/tmp/example/compose.yaml",
    localHttps: {
      providerHost: "app.localhost",
      httpsPort: 443,
    },
  };
  const reachable = probeComposeProviderEndpoint(
    plan,
    "https://app.localhost/.well-known/oauth-authorization-server",
    (command, args, options) => {
      calls.push({ command, args, options });
      return "200";
    },
  );

  assert.equal(reachable, true);
  assert.deepEqual(calls[0].args.slice(0, 10), [
    "compose",
    "-f",
    plan.composeFile,
    "exec",
    "-T",
    "tama",
    "curl",
    "--connect-to",
    "app.localhost:443:caddy:443",
    "--fail",
  ]);
  assert.equal(
    calls[0].args.at(-1),
    "https://app.localhost/.well-known/oauth-authorization-server",
  );
});
