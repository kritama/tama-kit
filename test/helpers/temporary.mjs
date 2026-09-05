import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const directories = new Set();

// macOS exposes /var through a symlink; fixtures should use its canonical path.
// Tests for unsafe symlinks still create and assert those links explicitly.
export function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  directories.add(directory);
  return directory;
}

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
