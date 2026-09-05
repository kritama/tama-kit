import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function tests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? tests(path) : entry.name.endsWith(".test.mjs") ? [path] : [];
    })
    .sort();
}
const child = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...tests(join(root, "test"))],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
