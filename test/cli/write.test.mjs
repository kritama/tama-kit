import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { contentDigest, operationForContent } from "../../cli/shared/files.mjs";
import { applyOperations, applyOperationsTransactionally } from "../../cli/shared/write.mjs";
import { temporaryDirectory } from "../helpers/temporary.mjs";

function update(path, content, options = {}) {
  return operationForContent(path, content, { allowUnmanagedUpdate: true, ...options });
}

test("stale creates, updates and deletes fail before any write", async () => {
  for (const kind of ["create", "update", "delete"]) {
    const root = temporaryDirectory("tama-kit-write-");
    const path = join(root, "existing");
    if (kind !== "create") writeFileSync(path, "original");
    const operation =
      kind === "delete"
        ? {
            action: "delete",
            path,
            owner: "user",
            sensitive: false,
            beforeDigest: contentDigest("original"),
            afterDigest: null,
            reason: "selected delete",
          }
        : update(path, "planned");
    const first = update(join(root, "new-directory/new"), "new");
    writeFileSync(path, "concurrent edit");
    await assert.rejects(
      applyOperationsTransactionally([first, operation], () => {}),
      { category: "ownership" },
    );
    assert.equal(existsSync(join(root, "new-directory")), false);
    assert.equal(readFileSync(path, "utf8"), "concurrent edit");
  }
});

test("unchanged files are not chmod'ed or restored during rollback", async () => {
  const root = temporaryDirectory("tama-kit-write-");
  const path = join(root, "unchanged");
  writeFileSync(path, "original");
  const unchanged = update(path, "original");
  unchanged.mode = 0o600;
  const before = statSync(path).mode;
  applyOperations([unchanged]);
  assert.equal(statSync(path).mode, before);
  await assert.rejects(
    applyOperationsTransactionally([unchanged, update(join(root, "created"), "new")], () => {
      writeFileSync(path, "concurrent edit");
      throw new Error("validation failed");
    }),
    /validation failed/u,
  );
  assert.equal(readFileSync(path, "utf8"), "concurrent edit");
  assert.equal(existsSync(join(root, "created")), false);
});

test("rollback preserves concurrent edits to created and updated files while restoring other changes", async () => {
  for (const kind of ["create", "update"]) {
    const root = temporaryDirectory("tama-kit-write-");
    const path = join(root, "edited");
    if (kind === "update") writeFileSync(path, "original");
    const other = join(root, "other");
    writeFileSync(other, "original other", { mode: 0o600 });
    const failure = new Error("original sanitized diagnostic");
    await assert.rejects(
      applyOperationsTransactionally(
        [update(other, "changed other"), update(path, "planned")],
        () => {
          writeFileSync(path, "concurrent edit");
          throw failure;
        },
      ),
      (error) => error instanceof AggregateError && error.errors[0] === failure,
    );
    assert.equal(readFileSync(path, "utf8"), "concurrent edit");
    assert.equal(readFileSync(other, "utf8"), "original other");
    assert.equal(statSync(other).mode & 0o777, 0o600);
  }
});

test("rollback preserves replaced inodes, chmod changes, deleted files and symlink targets", async () => {
  for (const mutation of ["replace", "chmod", "delete", "symlink"]) {
    const root = temporaryDirectory("tama-kit-write-");
    const path = join(root, "file");
    const target = join(root, "target");
    writeFileSync(path, "original");
    writeFileSync(target, "do not touch");
    await assert.rejects(
      applyOperationsTransactionally([update(path, "planned")], () => {
        if (mutation === "replace") {
          writeFileSync(join(root, "replacement"), "planned");
          renameSync(join(root, "replacement"), path);
        } else if (mutation === "chmod") chmodSync(path, 0o400);
        else {
          unlinkSync(path);
          if (mutation === "symlink") symlinkSync(target, path);
        }
        throw new Error("failed");
      }),
      AggregateError,
    );
    assert.equal(readFileSync(target, "utf8"), "do not touch");
    if (mutation === "delete") assert.equal(existsSync(path), false);
    else if (mutation === "chmod") assert.equal(statSync(path).mode & 0o777, 0o400);
    else
      assert.equal(readFileSync(path, "utf8"), mutation === "replace" ? "planned" : "do not touch");
  }
});

test("partial write failure removes only successful writes and owned directories", async () => {
  const root = temporaryDirectory("tama-kit-write-");
  const original = join(root, "original");
  writeFileSync(original, "before", { mode: 0o600 });
  const operations = [
    update(original, "after"),
    update(join(root, "new/first"), "first"),
    update(join(root, "new/fail"), "fail", { mode: -1 }),
  ];
  await assert.rejects(
    applyOperationsTransactionally(operations, () => assert.fail("must not validate")),
  );
  assert.equal(readFileSync(original, "utf8"), "before");
  assert.equal(statSync(original).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, "new")), false);
});

test("rollback cannot replace a new arrival at a deleted destination", async () => {
  const root = temporaryDirectory("tama-kit-write-");
  const path = join(root, "deleted");
  writeFileSync(path, "original");
  const deletion = {
    action: "delete",
    path,
    owner: "user",
    sensitive: false,
    beforeDigest: contentDigest("original"),
    afterDigest: null,
    reason: "selected delete",
  };
  await assert.rejects(
    applyOperationsTransactionally([deletion], () => {
      writeFileSync(path, "new arrival");
      throw new Error("failed");
    }),
    AggregateError,
  );
  assert.equal(readFileSync(path, "utf8"), "new arrival");
});

test("progress receipt writes roll back to their original bytes after validation failure", async () => {
  for (const existing of [false, true]) {
    const root = temporaryDirectory("tama-progress-rollback-");
    const receipt = join(root, "receipt");
    if (existing) writeFileSync(receipt, "original receipt");
    const operations = [
      update(receipt, "pending two"),
      update(join(root, "a"), "a"),
      update(join(root, "b"), "b"),
    ];
    await assert.rejects(
      applyOperationsTransactionally(
        operations,
        () => {
          throw new Error("validation failed");
        },
        (operation, write) => {
          if (operation.path !== receipt)
            write(update(receipt, operation.path.endsWith("a") ? "pending one" : "complete"));
        },
      ),
      /validation failed/,
    );
    if (existing) assert.equal(readFileSync(receipt, "utf8"), "original receipt");
    else assert.equal(existsSync(receipt), false);
    assert.equal(existsSync(join(root, "a")), false);
    assert.equal(existsSync(join(root, "b")), false);
  }
});
