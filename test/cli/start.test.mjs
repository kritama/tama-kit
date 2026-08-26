import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

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
