import assert from "node:assert/strict";
import test from "node:test";
import {
  cellWidth,
  expandTabs,
  graphemeWidth,
  renderBox,
  toGraphemes,
  visibleLength,
  wrapLine,
} from "../../cli/terminal.mjs";

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

test("graphemeWidth measures wide, emoji, combining, and ZWJ characters", () => {
  assert.equal(graphemeWidth("a"), 1);
  assert.equal(graphemeWidth("漢"), 2);
  assert.equal(graphemeWidth("🙂"), 2);
  assert.equal(graphemeWidth("é"), 1);
  assert.equal(graphemeWidth("e\u0301"), 1);
  assert.equal(graphemeWidth("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}"), 2);
  assert.equal(graphemeWidth("\u{1f44d}\u{1f3fd}"), 2);
  assert.equal(graphemeWidth("☀\ufe0f"), 2);
  assert.equal(graphemeWidth("1\ufe0f\u20e3"), 2);
  assert.equal(graphemeWidth("か\u3099"), 2);
  assert.equal(graphemeWidth("か\u309a"), 2);
  assert.equal(graphemeWidth("ש\u05c1"), 1);
  assert.equal(graphemeWidth("ㄱ\u1165"), 2);
  assert.equal(graphemeWidth("☀\ufe0e"), 1);
  assert.equal(graphemeWidth("ℹ"), 1);
  assert.equal(graphemeWidth("ℹ\ufe0f"), 2);
  assert.equal(graphemeWidth("™"), 1);
  assert.equal(graphemeWidth("☀"), 2);
});

test("cellWidth sums display cells across grapheme clusters", () => {
  assert.equal(cellWidth("ab漢"), 4);
  assert.equal(cellWidth("漢字のパス"), 10);
  assert.equal(cellWidth("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}xy"), 4);
  assert.deepEqual(toGraphemes("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}"), [
    "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}",
  ]);
});

test("wrapLine breaks CJK text on cell width without losing characters", () => {
  const wrapped = wrapLine("漢字のテストです", 6);
  assert.deepEqual(wrapped, ["漢字の", "テスト", "です"]);
  assert.equal(wrapped.join(""), "漢字のテストです");
});

test("wrapLine preserves original whitespace runs on unbroken lines", () => {
  assert.deepEqual(wrapLine("a  bbb ccccccccc", 8), ["a  bbb ", "cccccccc", "c"]);
  assert.deepEqual(wrapLine("a  b   c", 30), ["a  b   c"]);
});

test("wrapLine carries a multi-space separator onto the continuation row", () => {
  const wrapped = wrapLine("run -f 'a  b' up", 9);
  assert.deepEqual(wrapped, ["run -f 'a", "  b' up"]);
  assert.equal(wrapped.join(""), "run -f 'a  b' up");
});

test("wrapLine never splits a ZWJ emoji cluster", () => {
  const family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
  const wrapped = wrapLine(`${family} hello world`, 8);
  assert.deepEqual(wrapped, [`${family} hello`, " world"]);
});

test("wrapLine splits whitespace runs wider than the wrap width across rows", () => {
  assert.deepEqual(wrapLine("run -f 'a          b' up", 9), ["run -f 'a", "       b'", " up"]);
});

test("wrapLine keeps short lines intact and breaks long lines at word boundaries", () => {
  assert.deepEqual(wrapLine("short", 20), ["short"]);
  assert.deepEqual(wrapLine("The quick brown fox jumps over the lazy dog", 19), [
    "The quick brown fox",
    " jumps over the",
    " lazy dog",
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
  assert.ok(lines.some((line) => line.startsWith("│  coding agent")));
  assert.ok(lines.some((line) => line.startsWith("│ This is a fairly long prompt")));
});

test("expandTabs expands tabs to terminal tab stops from the content column", () => {
  assert.equal(expandTabs("abc\tdefgh"), "abc   defgh");
  assert.equal(expandTabs("abcdefgh\tij"), "abcdefgh      ij");
  assert.equal(expandTabs("no tabs"), "no tabs");
});

test("renderBox expands tabs at terminal tab stops", () => {
  const lines = renderBox({ lines: ["abc\tdefgh"], color: false, maxWidth: 30 });
  assert.ok(lines.every((line) => !line.includes("\t")));
  assert.ok(lines.some((line) => line.startsWith("│ abc   defgh")));
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
});

test("renderBox appends shell continuations to wrapped value rows", () => {
  const command = "docker compose -f 'compose.yaml' up -d tama";
  const lines = renderBox({
    title: "Next",
    lines: [command],
    color: false,
    maxWidth: 20,
    continuation: true,
  });
  assert.ok(lines.every((line) => line.length <= 24));
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
  const contentRows = lines.slice(3, -1);
  assert.ok(contentRows.length > 1);
  for (const row of contentRows.slice(0, -1)) {
    assert.ok(/ \\\s*│$/.test(row));
  }
  assert.ok(!contentRows.at(-1)?.includes("\\"));
  const logical = contentRows
    .map((row) => row.slice(2, -1))
    .map((row) => row.replace(/ \\\s*$/, ""))
    .join("");
  assert.equal(logical.replace(/\s+/g, " ").trim(), command.replace(/\s+/g, " ").trim());
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

test("renderBox pads wide characters by display cells, not code units", () => {
  const lines = renderBox({
    title: "Next",
    lines: ["docker compose -f '漢字のプロジェクト/compose.yaml' up -d tama"],
    color: false,
    maxWidth: 30,
  });

  for (const line of lines) {
    assert.ok(cellWidth(line) <= 34, `line exceeds maxWidth: ${line}`);
  }
  assert.equal(new Set(lines.map((line) => cellWidth(line))).size, 1);
  assert.ok(lines.some((line) => line.includes("漢字のプロジェクト")));
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
