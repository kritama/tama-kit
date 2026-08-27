// @ts-check

/** @typedef {import("./types.mjs").CommandIO} CommandIO */

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
});

/** @param {boolean} enabled @param {keyof typeof ANSI} style @param {string} value */
export function paint(enabled, style, value) {
  return enabled ? `${ANSI[style]}${value}${ANSI.reset}` : value;
}

const ESC = String.fromCharCode(0x1b);
const ANSI_ESCAPE = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");

/** @param {string} value */
function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE, "");
}

/** @typedef {keyof typeof ANSI} PaintStyle */

const SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });

/** @param {string} value @returns {string[]} */
export function toGraphemes(value) {
  return [...SEGMENTER.segment(value)].map((segment) => segment.segment);
}

/** @param {string} value */
export function visibleLength(value) {
  return stripAnsi(value).length;
}

/** @param {number} codePoint @returns {number} */
function codePointWidth(codePoint) {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x00ad ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** @param {string} value @returns {number[]} */
function codePointsOf(value) {
  const codePoints = [];
  for (let index = 0; index < value.length; index += 1) {
    const high = value.charCodeAt(index);
    if (high >= 0xd800 && high <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoints.push(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
        index += 1;
        continue;
      }
    }
    codePoints.push(high);
  }
  return codePoints;
}

/** @param {number} codePoint @returns {boolean} */
function isEmojiCodePoint(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b00 && codePoint <= 0x2bff) ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x2122 ||
    codePoint === 0x2139 ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

/** @param {string} grapheme @returns {number} */
export function graphemeWidth(grapheme) {
  let emoji = false;
  let width = 0;
  for (const codePoint of codePointsOf(grapheme)) {
    if (codePoint === 0x200d) {
      continue;
    }
    if (isEmojiCodePoint(codePoint) || codePoint === 0xfe0f || codePoint === 0x20e3) {
      emoji = true;
    }
    width += codePointWidth(codePoint);
  }
  return emoji ? 2 : width;
}

/** @param {string} value @returns {number} */
export function cellWidth(value) {
  let width = 0;
  for (const grapheme of toGraphemes(value)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

/** @param {string} value @param {number} maxWidth @returns {[string, string]} */
function breakAtWidth(value, maxWidth) {
  const graphemes = toGraphemes(value);
  let index = 0;
  let used = 0;
  for (const grapheme of graphemes) {
    const width = graphemeWidth(grapheme);
    if (used + width > maxWidth) {
      break;
    }
    used += width;
    index += 1;
  }
  if (index === 0) {
    index = 1;
  }
  return [graphemes.slice(0, index).join(""), graphemes.slice(index).join("")];
}

/**
 * @param {string} line
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapLine(line, maxWidth) {
  if (cellWidth(line) <= maxWidth) {
    return [line];
  }
  const tokens = line.trim().match(/\S+|\s+/gu) ?? [];
  const wrapped = [];
  let current = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim() === "") {
      continue;
    }
    const separator = index > 0 ? tokens[index - 1] : "";
    /** @type {string[]} */
    const pieces = [];
    let rest = token;
    while (cellWidth(rest) > maxWidth) {
      const [head, tail] = breakAtWidth(rest, maxWidth);
      pieces.push(head);
      rest = tail;
    }
    pieces.push(rest);
    pieces.forEach((piece, pieceIndex) => {
      const prefix = pieceIndex === 0 ? separator : "";
      const candidate = current ? `${current}${prefix}${piece}` : piece;
      if (cellWidth(candidate) <= maxWidth) {
        current = candidate;
      } else {
        if (current) {
          wrapped.push(current);
        }
        const next = `${prefix}${piece}`;
        current = cellWidth(next) <= maxWidth ? next : piece;
      }
    });
  }
  if (current) {
    wrapped.push(current);
  }
  return wrapped;
}

/**
 * @param {{title?: string, lines: string[], color: boolean, style?: PaintStyle, maxWidth?: number}} options
 * @returns {string[]}
 */
export function renderBox({ title, lines, color, style, maxWidth }) {
  /** @param {string} line */
  const wrap = (line) => (maxWidth === undefined ? [line] : wrapLine(line, maxWidth));
  const contentLines = lines.flatMap(wrap);
  const titleLines = title === undefined ? [] : wrap(title);
  /** @param {string} line */
  const measure = (line) => cellWidth(stripAnsi(line));
  const width = [...titleLines, ...contentLines].reduce(
    (max, line) => Math.max(max, measure(line)),
    0,
  );
  const inner = width + 2;
  /** @param {string} value */
  const dim = (value) => paint(color, "dim", value);
  /** @param {string} plain @param {string} displayed */
  const row = (plain, displayed) =>
    `${dim("│")} ${displayed}${" ".repeat(inner - measure(plain) - 1)}${dim("│")}`;
  const output = [
    dim(`┌${"─".repeat(inner)}┐`),
    ...titleLines.map((line) => row(line, paint(color, "bold", line))),
  ];
  if (title !== undefined) {
    output.push(dim(`├${"─".repeat(inner)}┤`));
  }
  output.push(
    ...contentLines.map((line) =>
      row(line, style === undefined ? line : paint(color, style, line)),
    ),
    dim(`└${"─".repeat(inner)}┘`),
  );
  return output;
}

/**
 * @param {CommandIO} io
 * @param {{enabled: boolean, color: boolean, total: number}} options
 */
export function createProgressBar(io, { enabled, color, total }) {
  const width = 24;
  let finished = false;

  /** @param {number} completed @param {string} label */
  function update(completed, label) {
    if (!enabled || finished) {
      return;
    }
    const bounded = Math.max(0, Math.min(completed, total));
    const filledWidth = Math.round((bounded / total) * width);
    const filled = paint(color, "cyan", "█".repeat(filledWidth));
    const empty = paint(color, "dim", "░".repeat(width - filledWidth));
    const percent = String(Math.round((bounded / total) * 100)).padStart(3);
    const line = `${filled}${empty} ${paint(color, "bold", `${percent}%`)} ${label}`;
    if (io.interactive && io.write) {
      io.write(`\r\u001b[2K${line}`);
    } else {
      io.stdout(line);
    }
  }

  /** @param {string} label */
  function finish(label) {
    update(total, label);
    if (enabled && io.interactive && io.write) {
      io.write("\n");
    }
    finished = true;
  }

  function stop() {
    if (enabled && !finished && io.interactive && io.write) {
      io.write("\n");
    }
    finished = true;
  }

  return { update, finish, stop };
}
