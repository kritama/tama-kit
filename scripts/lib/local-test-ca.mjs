import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Generate a fixture CA without installing it into the host trust store.
// Probes use the copied CA explicitly; Tama trusts it in its derived test image.
export function prepareLocalTestCa(directory) {
  const caRoot = join(directory, "test-ca");
  execFileSync(
    "mkcert",
    [
      "-cert-file",
      join(directory, "fixture.pem"),
      "-key-file",
      join(directory, "fixture-key.pem"),
      "app.localhost",
      "tama.app.localhost",
    ],
    {
      env: { ...process.env, CAROOT: caRoot },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return caRoot;
}
