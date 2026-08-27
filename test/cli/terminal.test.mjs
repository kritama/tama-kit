import assert from "node:assert/strict";
import test from "node:test";
import { renderBox, visibleLength, wrapLine } from "../../cli/terminal.mjs";

test("visibleLength ignores ANSI escape sequences", () => {
  assert.equal(visibleLength("\u001b[36mhello\u001b[0m"), 5);
  assert.equal(visibleLength("plain"), 5);
});

test("renderBox pads every row to a single uniform width", () => {
  const lines = renderBox({
    title: "Next",
    lines: ["short", "a much longer command line"],
    color: false,
  });

  assert.equal(lines.length, 6);
  const widths = new Set(lines.map(visibleLength));
  assert.equal(widths.size, 1);
  assert.ok(lines[0].startsWith("┌") && lines[0].endsWith("┐"));
  assert.ok(lines[1].startsWith("│ Next ") && lines[1].endsWith("│"));
  assert.ok(lines[2].startsWith("├") && lines[2].endsWith("┤"));
  assert.ok(lines[3].startsWith("│ short ") && lines[3].endsWith("│"));
  assert.ok(lines[4].startsWith("│ a much longer command line ") && lines[4].endsWith("│"));
  assert.ok(lines[5].startsWith("└") && lines[5].endsWith("┘"));
});

test("renderBox without a title omits the separator row", () => {
  const lines = renderBox({ lines: ["value"], color: false });

  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("┌"));
  assert.ok(lines[1].startsWith("│ value ") && lines[1].endsWith("│"));
  assert.ok(lines[2].startsWith("└"));
});

test("wrapLine keeps short lines intact and breaks long lines at word boundaries", () => {
  assert.deepEqual(wrapLine("short", 20), ["short"]);
  assert.deepEqual(wrapLine("The quick brown fox jumps over the lazy dog", 19), [
    "The quick brown fox",
    "jumps over the lazy",
    "dog",
  ]);
});

test("wrapLine hard-breaks words longer than the max width", () => {
  assert.deepEqual(wrapLine("http://localhost:4000/setup/root?token=abcd1234", 20), [
    "http://localhost:400",
    "0/setup/root?token=a",
    "bcd1234",
  ]);
  assert.deepEqual(wrapLine("", 10), [""]);
});

test("renderBox wraps content to maxWidth and stays rectangular", () => {
  const lines = renderBox({
    title: "Copy this prompt into your coding agent",
    lines: ["This is a fairly long prompt line that should wrap across several rows."],
    color: false,
    maxWidth: 30,
  });

  for (const line of lines) {
    assert.ok(line.length <= 34, `line exceeds maxWidth: ${line}`);
  }
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
  assert.ok(lines[1].startsWith("│ Copy this prompt i"));
  assert.ok(lines.some((line) => line.startsWith("│ coding agent")));
  assert.ok(lines.some((line) => line.startsWith("│ This is a fairly long prompt")));
});

test("renderBox applies the content style to every wrapped row", () => {
  const dim = "\u001b[2m";
  const magenta = "\u001b[35m";
  const reset = "\u001b[0m";
  const lines = renderBox({
    lines: ["word ".repeat(20).trim()],
    color: true,
    style: "magenta",
    maxWidth: 10,
  });

  const contentRows = lines.slice(1, -1);
  assert.ok(contentRows.length > 1);
  for (const row of contentRows) {
    assert.ok(row.startsWith(`${dim}│${reset} ${magenta}`));
    assert.ok(row.endsWith(`│${reset}`));
  }
  assert.equal(new Set(lines.map(visibleLength)).size, 1);
});

test("renderBox keeps painted content aligned with the dimmed borders", () => {
  const cyan = "\u001b[36m";
  const dim = "\u001b[2m";
  const reset = "\u001b[0m";
  const lines = renderBox({
    title: "Next",
    lines: [`${cyan}docker compose up${reset}`],
    color: true,
  });

  const widths = new Set(lines.map(visibleLength));
  assert.equal(widths.size, 1);
  assert.ok(lines[0].startsWith(`${dim}┌`) && lines[0].endsWith(`┐${reset}`));
  assert.ok(lines[1].startsWith(`${dim}│${reset} `));
  assert.ok(lines[2].startsWith(`${dim}├`) && lines[2].endsWith(`┤${reset}`));
  assert.ok(lines[3].includes(`${cyan}docker compose up${reset}`));
  assert.ok(lines.at(-1)?.startsWith(`${dim}└`) && lines.at(-1)?.endsWith(`┘${reset}`));
});
