import assert from "node:assert/strict";
import test from "node:test";
import { renderBox, visibleLength } from "../../cli/terminal.mjs";

test("visibleLength delegates terminal cell measurement to string-width", () => {
  assert.equal(visibleLength("\u001b[36mhello\u001b[0m"), 5);
  assert.equal(visibleLength("漢"), 2);
  assert.equal(visibleLength("🙂"), 2);
  assert.equal(visibleLength("©\ufe0f"), 2);
  assert.equal(visibleLength("\u200b"), 0);
});

test("renderBox pads every row to one display width", () => {
  const lines = renderBox({
    title: "Next",
    lines: ["short", "a much longer command line"],
    color: false,
  });

  assert.equal(lines.length, 6);
  assert.equal(new Set(lines.map(visibleLength)).size, 1);
  assert.ok(lines[0].startsWith("┌") && lines[0].endsWith("┐"));
  assert.ok(lines[1].startsWith("│ Next ") && lines[1].endsWith("│"));
  assert.ok(lines[2].startsWith("├") && lines[2].endsWith("┤"));
  assert.ok(lines[3].startsWith("│ short ") && lines[3].endsWith("│"));
  assert.ok(lines[4].startsWith("│ a much longer command line "));
  assert.ok(lines[5].startsWith("└") && lines[5].endsWith("┘"));
});

test("renderBox wraps prose with wrap-ansi and remains rectangular", () => {
  const lines = renderBox({
    title: "Copy this prompt into your coding agent",
    lines: ["This is a fairly long prompt line that should wrap across several rows."],
    color: false,
    maxWidth: 30,
  });

  assert.equal(new Set(lines.map(visibleLength)).size, 1);
  assert.ok(lines.every((line) => visibleLength(line) <= 34));
  assert.ok(lines.some((line) => line.includes("coding agent")));
  assert.ok(lines.some((line) => line.includes("several rows.")));
});

test("renderBox handles wide and zero-width Unicode through string-width", () => {
  const lines = renderBox({
    lines: ["漢字🙂\u200b", "plain"],
    color: false,
    maxWidth: 10,
  });

  assert.equal(new Set(lines.map(visibleLength)).size, 1);
  assert.ok(lines.every((line) => visibleLength(line) <= 14));
});

test("renderBox preserves normalization-sensitive Unicode payloads", () => {
  const command = "docker compose -f 'cafe\u0301/compose.yaml' up -d tama";
  const lines = renderBox({ lines: [command], color: false, maxWidth: 80 });

  assert.ok(lines.some((line) => line.includes(command)));
  assert.ok(lines.every((line) => !line.includes(command.normalize())));
});

test("renderBox expands prose tabs before measuring rows", () => {
  const lines = renderBox({ lines: ["abc\tdefgh"], color: false, maxWidth: 30 });

  assert.equal(new Set(lines.map(visibleLength)).size, 1);
  assert.ok(lines[1].includes("abc     defgh"));
  assert.ok(!lines[1].includes("\t"));
});

test("renderBox preserves rectangular output with color enabled", () => {
  const lines = renderBox({
    lines: ["word ".repeat(10).trim()],
    color: true,
    style: "magenta",
    maxWidth: 10,
  });

  assert.equal(new Set(lines.map(visibleLength)).size, 1);
  assert.ok(lines.slice(1, -1).every((line) => line.includes("\u001b[35m")));
});

test("renderBox falls back to unboxed prose when decoration cannot fit", () => {
  assert.deepEqual(renderBox({ title: "Title", lines: ["value"], color: false, maxWidth: 0 }), [
    "Title",
    "value",
  ]);
});

test("renderBox falls back rather than hard-breaking an uncopyable token", () => {
  const url = `http://localhost:4000/setup/root?token=${"a".repeat(32)}`;

  assert.deepEqual(
    renderBox({ title: "Private setup URL", lines: [url], color: false, maxWidth: 40 }),
    ["Private setup URL", url],
  );
});
