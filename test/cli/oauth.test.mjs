import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateOAuthPrivateJwk } from "../../cli/bootstrap/oauth-key.mjs";
import { EXIT_CODES } from "../../cli/errors.mjs";
import { run } from "../../cli/index.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JWK_PREFIX = "TAMA_OAUTH_PRIVATE_JWK=";
const ID_PREFIX = "TAMA_OAUTH_PRIVATE_JWK_ID=";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "tama-kit-oauth-"));
}

/** @param {string} cwd */
function capture(cwd) {
  const stdout = [];
  const stderr = [];
  const io = {
    cwd,
    stdout: (message = "") => stdout.push(message),
    stderr: (message = "") => stderr.push(message),
    interactive: false,
    color: false,
  };
  return { io, stdout, stderr };
}

/** @param {string[]} output */
function assertNoKeyMaterial(output) {
  const text = output.join("\n");
  assert.ok(!text.includes("\u001b"), "output must not contain ANSI escapes");
  assert.ok(!text.includes(JWK_PREFIX), "output must not echo the private JWK assignment");
  assert.ok(!text.includes(ID_PREFIX), "output must not echo the key identifier assignment");
  assert.ok(!/"(?:d|p|q|dp|dq|qi)":/u.test(text), "output must not quote private JWK members");
}

test("top-level and oauth help list generate-key and its options", async () => {
  const top = capture(tempCwd());
  assert.equal(await run(["--help"], top.io), EXIT_CODES.SUCCESS);
  assert.ok(top.stdout.join("\n").includes("oauth generate-key"));

  const oauth = capture(tempCwd());
  assert.equal(await run(["oauth"], oauth.io), EXIT_CODES.SUCCESS);
  const help = oauth.stdout.join("\n");
  assert.ok(help.includes("tama-kit oauth generate-key [options]"));
  assert.ok(help.includes("--kid <identifier>"));
  assert.ok(help.includes("--stdout"));
  assert.ok(help.includes("--output <path>"));
  assert.ok(help.includes("-h, --help"));
});

test("generate-key requires exactly one of --stdout or --output", async () => {
  for (const args of [
    ["oauth", "generate-key"],
    ["oauth", "generate-key", "--stdout", "--output", "staging.env"],
  ]) {
    const captured = capture(tempCwd());
    assert.equal(await run(args, captured.io), EXIT_CODES.USAGE);
    assert.equal(captured.stdout.length, 0);
    assert.ok(captured.stderr.join(" ").includes("exactly one of --stdout or --output"));
  }
});

test("unknown oauth subcommands and options use the stable usage exit code", async () => {
  for (const args of [
    ["oauth", "rotate"],
    ["oauth", "generate-key", "--json"],
    ["oauth", "generate-key", "--stdout", "surprise"],
  ]) {
    const captured = capture(tempCwd());
    assert.equal(await run(args, captured.io), EXIT_CODES.USAGE);
    assert.equal(captured.stdout.length, 0);
  }
});

test("--stdout emits exactly two dotenv assignments without decoration", async () => {
  const captured = capture(tempCwd());
  assert.equal(await run(["oauth", "generate-key", "--stdout"], captured.io), EXIT_CODES.SUCCESS);
  assert.equal(captured.stderr.length, 0);
  assert.equal(captured.stdout.length, 2);
  assert.match(captured.stdout[0], /^TAMA_OAUTH_PRIVATE_JWK=\{.*\}$/u);
  assert.match(captured.stdout[1], /^TAMA_OAUTH_PRIVATE_JWK_ID=oauth-[A-Za-z0-9_-]+$/u);
  assert.ok(!captured.stdout.join("\n").includes("\u001b"), "stdout must not contain ANSI escapes");
});

test("the stdout JWK and identifier pass the shared validator and match", async () => {
  const captured = capture(tempCwd());
  assert.equal(await run(["oauth", "generate-key", "--stdout"], captured.io), EXIT_CODES.SUCCESS);
  const jwk = captured.stdout[0].slice(JWK_PREFIX.length);
  const kid = captured.stdout[1].slice(ID_PREFIX.length);
  validateOAuthPrivateJwk(jwk, kid);
  assert.equal(JSON.parse(jwk).kid, kid);
});

test("an explicit kid is embedded in both stdout values", async () => {
  const captured = capture(tempCwd());
  assert.equal(
    await run(["oauth", "generate-key", "--kid", "staging-2026-09-01-1", "--stdout"], captured.io),
    EXIT_CODES.SUCCESS,
  );
  const jwk = captured.stdout[0].slice(JWK_PREFIX.length);
  assert.equal(JSON.parse(jwk).kid, "staging-2026-09-01-1");
  assert.equal(captured.stdout[1], `${ID_PREFIX}staging-2026-09-01-1`);
  validateOAuthPrivateJwk(jwk, "staging-2026-09-01-1");
});

test("invalid, dotenv-unsafe, or oversized kids are rejected without output", async () => {
  for (const kid of ["", "   ", "bad\nkid", "staging # one", "a".repeat(129)]) {
    const captured = capture(tempCwd());
    assert.equal(
      await run(["oauth", "generate-key", "--kid", kid, "--stdout"], captured.io),
      EXIT_CODES.USAGE,
    );
    assert.equal(captured.stdout.length, 0);
    assert.ok(captured.stderr.length > 0);
    assertNoKeyMaterial(captured.stderr);
  }
});

test("--output creates a mode-0600 dotenv file and prints only its path", async () => {
  const cwd = tempCwd();
  const captured = capture(cwd);
  assert.equal(
    await run(
      ["oauth", "generate-key", "--kid", "staging-2026-09-01-1", "--output", "staging.env"],
      captured.io,
    ),
    EXIT_CODES.SUCCESS,
  );
  const expectedPath = join(cwd, "staging.env");
  assert.deepEqual(captured.stdout, [expectedPath]);
  assert.equal(captured.stderr.length, 0);
  assert.equal((statSync(expectedPath).mode & 0o777) === 0o600, true);

  const lines = readFileSync(expectedPath, "utf8").split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith(JWK_PREFIX));
  assert.equal(lines[1], `${ID_PREFIX}staging-2026-09-01-1`);
  assert.equal(lines[2], "");
  const jwkValue = lines[0].slice(JWK_PREFIX.length);
  assert.ok(!captured.stdout.join("\n").includes(jwkValue), "stdout must not echo the JWK");
  assert.ok(!captured.stderr.join("\n").includes(jwkValue), "stderr must not echo the JWK");
});

test("existing files, final symlinks, and symlinked ancestors fail closed", async () => {
  const cwd = tempCwd();
  const target = join(cwd, "secret.env");
  const original = `${JWK_PREFIX}existing\n${ID_PREFIX}existing\n`;
  writeFileSync(target, original);

  let captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "secret.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
  assertNoKeyMaterial(captured.stderr);
  assert.equal(readFileSync(target, "utf8"), original);

  const linkPath = join(cwd, "link.env");
  symlinkSync(target, linkPath);
  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "link.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
  assert.ok(lstatSync(linkPath).isSymbolicLink(), "the symlink must be left in place");
  assert.equal(readFileSync(target, "utf8"), original);

  const outside = mkdtempSync(join(tmpdir(), "tama-kit-oauth-outside-"));
  symlinkSync(outside, join(cwd, "linked"), "dir");
  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "linked/secret.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
  assert.ok(!existsSync(join(outside, "secret.env")), "no file may be created through the link");

  const externalAnchor = mkdtempSync(join(tmpdir(), "tama-kit-oauth-external-anchor-"));
  const externalTarget = mkdtempSync(join(tmpdir(), "tama-kit-oauth-external-target-"));
  mkdirSync(join(externalTarget, "sub"));
  symlinkSync(externalTarget, join(externalAnchor, "linked"), "dir");
  const externalOutput = join(externalAnchor, "linked", "sub", "secret.env");
  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", externalOutput], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
  assertNoKeyMaterial(captured.stderr);
  assert.ok(
    !existsSync(join(externalTarget, "sub", "secret.env")),
    "no file may be created through an external ancestor link",
  );
});

test("a failed write leaves no private file behind", async (context) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    context.skip("root bypasses directory write permissions");
    return;
  }
  const cwd = tempCwd();
  const parent = join(cwd, "locked");
  mkdirSync(parent);
  chmodSync(parent, 0o555);
  try {
    const captured = capture(cwd);
    assert.equal(
      await run(["oauth", "generate-key", "--output", "locked/secret.env"], captured.io),
      EXIT_CODES.OWNERSHIP,
    );
    assert.equal(captured.stdout.length, 0);
    assertNoKeyMaterial(captured.stderr);
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    chmodSync(parent, 0o755);
  }
});

test("a directory target and a missing parent are refused", async () => {
  const cwd = tempCwd();
  writeFileSync(join(cwd, "dir.env"), "");
  let captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "dir.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);

  rmSync(join(cwd, "dir.env"));
  mkdirSync(join(cwd, "dir.env"));
  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "dir.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);

  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "missing/secret.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
});

test("--output inside a Git worktree requires an ignored, untracked destination", async () => {
  const cwd = tempCwd();
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });

  let captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "plain.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.equal(captured.stdout.length, 0);
  assert.ok(captured.stderr.join(" ").includes("not ignored by Git"));
  assert.ok(!existsSync(join(cwd, "plain.env")));

  writeFileSync(join(cwd, "staged.env"), "placeholder\n");
  execFileSync("git", ["add", "staged.env"], { cwd, stdio: "ignore" });
  writeFileSync(
    join(cwd, ".gitignore"),
    "ignored.env\nstaged.env\nnested/ignored.env\nnested/nested/decoy.env\n",
  );
  rmSync(join(cwd, "staged.env"));

  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "staged.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.ok(captured.stderr.join(" ").includes("Git index"));
  assert.ok(!existsSync(join(cwd, "staged.env")));

  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "ignored.env"], captured.io),
    EXIT_CODES.SUCCESS,
  );
  assert.ok(existsSync(join(cwd, "ignored.env")));

  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "..oauth.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.ok(!existsSync(join(cwd, "..oauth.env")));

  mkdirSync(join(cwd, "nested"));
  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "nested/ignored.env"], captured.io),
    EXIT_CODES.SUCCESS,
  );
  assert.ok(existsSync(join(cwd, "nested", "ignored.env")));

  captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "nested/decoy.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assert.ok(!existsSync(join(cwd, "nested", "decoy.env")));
});

test("errors never contain private key material", async () => {
  const cwd = tempCwd();
  const target = join(cwd, "secret.env");
  writeFileSync(target, `${JWK_PREFIX}existing\n${ID_PREFIX}existing\n`);

  const captured = capture(cwd);
  assert.equal(
    await run(["oauth", "generate-key", "--output", "secret.env"], captured.io),
    EXIT_CODES.OWNERSHIP,
  );
  assertNoKeyMaterial(captured.stderr);
  assert.equal(readFileSync(target, "utf8"), `${JWK_PREFIX}existing\n${ID_PREFIX}existing\n`);
});

test("the packaged entry point runs generate-key without a Tama checkout", () => {
  const cwd = tempCwd();
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, "bin", "tama-kit.mjs"), "oauth", "generate-key", "--stdout"],
    { cwd, encoding: "utf8" },
  );
  const lines = output.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^TAMA_OAUTH_PRIVATE_JWK=\{.*\}$/u);
  assert.match(lines[1], /^TAMA_OAUTH_PRIVATE_JWK_ID=oauth-[A-Za-z0-9_-]+$/u);
  assert.equal(lines[2], "");
});
