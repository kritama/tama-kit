import assert from "node:assert/strict";
import test from "node:test";
import {
  cellWidth,
  cellWidthAt,
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

test("wrapLine keeps quoted whitespace tokens intact and wraps them as units", () => {
  const wrapped = wrapLine("run -f 'a  b' up", 9);
  assert.deepEqual(wrapped, ["run -f", " 'a  b'", " up"]);
  assert.equal(wrapped.join(""), "run -f 'a  b' up");
});

test("wrapLine never splits a ZWJ emoji cluster", () => {
  const family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
  const wrapped = wrapLine(`${family} hello world`, 8);
  assert.deepEqual(wrapped, [`${family} hello`, " world"]);
});

test("wrapLine keeps the inner whitespace of a quoted token when hard-breaking it", () => {
  const wrapped = wrapLine("run -f 'a          b' up", 9);
  assert.deepEqual(wrapped, ["run -f ", "'a      '", "'    b'", " up"]);
  assert.equal(wrapped.join("").replace(/''/g, ""), "run -f 'a          b' up");
  assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 9));
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

test("wrapLine hard-breaks quoted tokens into adjacent quoted chunks", () => {
  const wrapped = wrapLine("'averyveryverylongdirectory/compose.yaml'", 18);
  assert.deepEqual(wrapped, ["'averyveryverylon'", "'gdirectory/compo'", "'se.yaml'"]);
  assert.equal(wrapped.join("").replace(/''/g, ""), "'averyveryverylongdirectory/compose.yaml'");
  assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 18));
});

test("renderBox puts every continuation backslash at the very end of its row", () => {
  const command = "docker compose -f 'averyveryverylongdirectory/compose.yaml' up -d tama";
  const lines = renderBox({
    title: "Next",
    lines: [command],
    color: false,
    maxWidth: 24,
    continuation: true,
  });
  const rows = lines.slice(3, -1);
  for (const row of rows.slice(0, -1)) {
    assert.ok(/\\│$/.test(row), `backslash must be the final character before the border: ${row}`);
  }
  assert.ok(!rows.at(-1)?.includes("\\"));
});

test("wrapLine terminates for tokens narrower than the wrap width", () => {
  assert.deepEqual(wrapLine("'abcd'", 1), ["'a'", "'b'", "'c'", "'d'"]);
  assert.deepEqual(wrapLine("abcd", 1), ["a", "b", "c", "d"]);
});

test("renderBox continuations rejoin into the original command", () => {
  const command = "docker compose -f 'averyveryverylongdirectory/compose.yaml' up -d tama";
  const lines = renderBox({
    title: "Next",
    lines: [command],
    color: false,
    maxWidth: 24,
    continuation: true,
  });
  const contentOf = (row) => {
    const body = row.endsWith("\\│") ? row.slice(0, -2) : row.slice(0, -1);
    return body.startsWith("│ ") ? body.slice(2) : body.slice(1);
  };
  const joined = lines.slice(3, -1).map(contentOf).join("");
  const stripQuotes = (value) => value.replace(/'/g, "");
  assert.equal(
    stripQuotes(joined).replace(/\s+/g, " ").trim(),
    stripQuotes(command).replace(/\s+/g, " ").trim(),
  );
});

test("renderBox keeps quoted paths with whitespace as one shell word", () => {
  const command = "docker compose -f 'a long directory/compose.yaml' up -d tama";
  const lines = renderBox({
    title: "Next",
    lines: [command],
    color: false,
    maxWidth: 20,
    continuation: true,
  });
  // Hard-wrapped chunk rows are deliberately tight (no padding): whitespace
  // between the chunks would become part of the shell word.
  const contentOf = (row) => {
    const body = row.endsWith("\\│") ? row.slice(0, -2) : row.slice(0, -1);
    return body.startsWith("│ ") ? body.slice(2) : body.slice(1);
  };
  const joined = lines.slice(3, -1).map(contentOf).join("").replace(/'/g, "");
  assert.equal(
    joined.replace(/\s+/g, " ").trim(),
    command.replace(/'/g, "").replace(/\s+/g, " ").trim(),
  );
});

test("wrapLine re-quotes compound apostrophe tokens as single-quoted chunks", () => {
  const value = "/tmp/tama project's/deploy/compose.yaml";
  const token = `'${value.replaceAll("'", "'\\''")}'`;
  const wrapped = wrapLine(token, 18);
  assert.ok(
    wrapped.every((row) => /^('[^']*'|\\')+$/.test(row.trimStart())),
    wrapped.join("\n"),
  );
  const rejoin = (text) => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        out += text.slice(i + 1, end);
        i = end;
      } else if (text[i] === "\\") {
        out += text[i + 1];
        i += 1;
      } else {
        out += text[i];
      }
    }
    return out;
  };
  assert.equal(rejoin(wrapped.map((row) => row.trimStart()).join("")), value);
  assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 18));
});

test("wrapLine re-quotes single-quoted tokens with $ or backticks as single-quoted chunks", () => {
  const dollar = "/tmp/$money budget/compose.yaml";
  const tick = "/tmp/`tick` dir/compose.yaml";
  for (const value of [dollar, tick]) {
    const wrapped = wrapLine(`'${value}'`, 18);
    assert.ok(wrapped.every((row) => row.startsWith("'") && row.endsWith("'")));
    assert.equal(wrapped.map((row) => row.slice(1, -1)).join(""), value);
    assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 18));
  }
});

test("wrapLine breaks words that mix apostrophes and $ only outside quoted spans", () => {
  assert.deepEqual(wrapLine("run 'a'\\''b$c'", 6), ["run", " 'a'\\'", "'b$c'"]);
});

test("wrapLine keeps history-expansion ! literal inside single-quoted chunks", () => {
  const value = "a project's/!important/compose.yaml";
  const token = `'${value.replaceAll("'", "'\\''")}'`;
  const wrapped = wrapLine(token, 20);
  assert.ok(
    wrapped.every((row) => /^('[^']*'|\\')+$/.test(row.trimStart())),
    wrapped.join("\n"),
  );
  assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 20));
});

test("wrapLine fits apostrophe-and-$ paths inside maxWidth", () => {
  const value = "this project's/$money/very-long-directory-name/compose.yaml";
  const token = `'${value.replaceAll("'", "'\\''")}'`;
  const wrapped = wrapLine(token, 36);
  assert.ok(wrapped.length > 1);
  assert.ok(
    wrapped.every((row) => cellWidthAt(row, 2) <= 36),
    wrapped.join("\n"),
  );
});

test("wrapLine treats prose apostrophes as ordinary characters in display mode", () => {
  assert.deepEqual(wrapLine("Guide Tama's user", 5, false), ["Guide", "Tama'", "s", " user"]);
});

test("renderBox display boxes wrap prose apostrophes instead of swallowing the line", () => {
  const line =
    "3. Guide me through Tama's interactive first-run setup at http://localhost:4000 now.";
  const lines = renderBox({ title: "Prompt", lines: [line], color: false, maxWidth: 30 });
  assert.ok(
    lines.every((row) => visibleLength(row) <= 34),
    lines.join("\n"),
  );
  assert.equal(new Set(lines.map((row) => visibleLength(row))).size, 1);
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

test("renderBox preserves literal tabs and keeps borders aligned", () => {
  const lines = renderBox({ lines: ["abc\tdefgh"], color: false, maxWidth: 30 });
  assert.ok(lines.some((line) => line.includes("abc\tdefgh")));
  // Measured from column 1: where the left border really sits at the left
  // edge of the terminal, so tab widths land on the same stops the box
  // renders at.
  assert.equal(new Set(lines.map((line) => cellWidthAt(line, 1))).size, 1);
  assert.ok(lines.every((line) => cellWidthAt(line, 1) <= 34));
});

test("renderBox keeps tabs in gutter rows inside the border", () => {
  const command = "cmd 'abc\tdefghijklmnopqrstuvwxyz'";
  for (const maxWidth of [14, 16, 18, 20]) {
    const lines = renderBox({
      title: "Next",
      lines: [command],
      color: false,
      maxWidth,
      continuation: true,
    });
    const widths = lines.map((line) => cellWidthAt(line, 1));
    const border = widths[0];
    assert.ok(
      widths.every((width) => width <= border),
      `maxWidth=${maxWidth}: a row is ${widths.filter((w) => w > border).length} cell(s) wider than the border`,
    );
  }
});

test("renderBox keeps mixed-quote tabs on tab stops inside the border", () => {
  const value = "/.`0.'Y.漢$a$$ \\`0\\\t.Y-`🙂-`b'";
  const lines = renderBox({
    title: "Next",
    lines: [`docker compose -f ${value} up -d tama`],
    color: false,
    maxWidth: 20,
    continuation: true,
  });
  const widths = lines.map((line) => cellWidthAt(line, 1));
  const border = widths[0];
  assert.ok(widths.every((width) => width <= border));
});

test("wrapLine preserves tabs inside quoted tokens when hard-breaking them", () => {
  const value = "docker compose -f 'nested/a\tb/compose.yaml' up -d tama";
  const wrapped = wrapLine(value, 18);
  assert.deepEqual(wrapped, [
    "docker compose -f",
    " 'nested/a\tb/c'",
    "'ompose.yaml' up",
    " -d tama",
  ]);
  assert.equal(wrapped.join("").replace(/''/g, ""), value);
  assert.ok(wrapped.every((row) => cellWidthAt(row, 2) <= 18));
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
    assert.ok(/ \\│$/.test(row), `backslash must be the final character before the border: ${row}`);
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
