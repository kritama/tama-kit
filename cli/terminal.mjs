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

const COMBINING_MARK = /\p{M}/u;

/** @param {number} codePoint @returns {number} */
function codePointWidth(codePoint) {
  if (
    COMBINING_MARK.test(String.fromCodePoint(codePoint)) ||
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
function isDefaultEmoji(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x231a && codePoint <= 0x231b) ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf ||
    (codePoint >= 0x23e9 && codePoint <= 0x23f3) ||
    (codePoint >= 0x23f8 && codePoint <= 0x23fa) ||
    codePoint === 0x24c2 ||
    (codePoint >= 0x25aa && codePoint <= 0x25ab) ||
    codePoint === 0x25b6 ||
    codePoint === 0x25c0 ||
    (codePoint >= 0x25fb && codePoint <= 0x25fe) ||
    (codePoint >= 0x2600 && codePoint <= 0x2604) ||
    codePoint === 0x260e ||
    codePoint === 0x2611 ||
    (codePoint >= 0x2614 && codePoint <= 0x2615) ||
    codePoint === 0x2618 ||
    codePoint === 0x261d ||
    codePoint === 0x2620 ||
    (codePoint >= 0x2622 && codePoint <= 0x2624) ||
    codePoint === 0x2626 ||
    codePoint === 0x262a ||
    codePoint === 0x262e ||
    codePoint === 0x262f ||
    (codePoint >= 0x2638 && codePoint <= 0x263a) ||
    codePoint === 0x2640 ||
    codePoint === 0x2642 ||
    codePoint === 0x265f ||
    (codePoint >= 0x2660 && codePoint <= 0x2661) ||
    (codePoint >= 0x2663 && codePoint <= 0x2668) ||
    codePoint === 0x267b ||
    codePoint === 0x267e ||
    codePoint === 0x267f ||
    (codePoint >= 0x2692 && codePoint <= 0x2697) ||
    codePoint === 0x2699 ||
    (codePoint >= 0x269b && codePoint <= 0x269c) ||
    codePoint === 0x26a0 ||
    codePoint === 0x26a1 ||
    codePoint === 0x26aa ||
    codePoint === 0x26ab ||
    (codePoint >= 0x26b0 && codePoint <= 0x26b2) ||
    codePoint === 0x26bd ||
    codePoint === 0x26be ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    codePoint === 0x26c8 ||
    (codePoint >= 0x26ce && codePoint <= 0x26d1) ||
    codePoint === 0x26d3 ||
    codePoint === 0x26d4 ||
    codePoint === 0x26e9 ||
    codePoint === 0x26ea ||
    (codePoint >= 0x26f0 && codePoint <= 0x26f5) ||
    (codePoint >= 0x26f7 && codePoint <= 0x26fa) ||
    codePoint === 0x26fd ||
    codePoint === 0x2702 ||
    codePoint === 0x2705 ||
    (codePoint >= 0x2708 && codePoint <= 0x270d) ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    codePoint === 0x274f ||
    (codePoint >= 0x2756 && codePoint <= 0x275e) ||
    codePoint === 0x2761 ||
    codePoint === 0x2763 ||
    codePoint === 0x2764 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27a1 ||
    (codePoint >= 0x27a3 && codePoint <= 0x27a4) ||
    (codePoint >= 0x2b05 && codePoint <= 0x2b07) ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) ||
    codePoint === 0x2b50 ||
    codePoint === 0x2b55 ||
    codePoint === 0x2b56 ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

/** @param {number} codePoint @returns {boolean} */
function isEmojiCapable(codePoint) {
  return (
    isDefaultEmoji(codePoint) ||
    (codePoint >= 0x2100 && codePoint <= 0x21ff) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2460 && codePoint <= 0x24ff) ||
    (codePoint >= 0x25a0 && codePoint <= 0x25ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b00 && codePoint <= 0x2bff) ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

/** @param {string} grapheme @returns {number} */
export function graphemeWidth(grapheme) {
  let emoji = false;
  let variationEmoji = false;
  let textPresentation = false;
  let hangul = false;
  let capable = false;
  let width = 0;
  for (const codePoint of codePointsOf(grapheme)) {
    if (codePoint === 0x200d) {
      continue;
    }
    if (codePoint === 0xfe0f) {
      variationEmoji = true;
      continue;
    }
    if (codePoint === 0xfe0e) {
      textPresentation = true;
      continue;
    }
    if (codePoint >= 0x1100 && codePoint <= 0x11ff) {
      hangul = true;
      continue;
    }
    if (isDefaultEmoji(codePoint) || codePoint === 0x20e3) {
      emoji = true;
    }
    if (isEmojiCapable(codePoint)) {
      capable = true;
    }
    width += codePointWidth(codePoint);
  }
  if (hangul) {
    return 2;
  }
  if (textPresentation) {
    return width;
  }
  return emoji || (variationEmoji && capable) ? 2 : width;
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
      } else if (prefix && /^ +$/.test(prefix) && cellWidth(`${prefix}${piece}`) > maxWidth) {
        const head = prefix.slice(0, Math.max(0, maxWidth - cellWidth(current)));
        const tail = prefix.slice(head.length);
        const lead = tail.slice(0, Math.max(0, maxWidth - cellWidth(piece)));
        wrapped.push(`${current}${head}`);
        current = `${lead}${piece}`;
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

/** @param {string} value @param {number} [startColumn] @returns {string} */
export function expandTabs(value, startColumn = 2) {
  let column = startColumn;
  let expanded = "";
  for (const grapheme of toGraphemes(value)) {
    if (grapheme === "\t") {
      const stop = (Math.floor(column / 8) + 1) * 8;
      expanded += " ".repeat(stop - column);
      column = stop;
    } else {
      expanded += grapheme;
      column += graphemeWidth(grapheme);
    }
  }
  return expanded;
}

/**
 * @param {{title?: string, lines: string[], color: boolean, style?: PaintStyle, maxWidth?: number, continuation?: boolean}} options
 * @returns {string[]}
 */
export function renderBox({ title, lines, color, style, maxWidth, continuation = false }) {
  const wrapWidth = continuation && maxWidth !== undefined ? Math.max(1, maxWidth - 2) : maxWidth;
  /** @param {string} line */
  const wrap = (line) => {
    const expanded = expandTabs(line);
    return wrapWidth === undefined ? [expanded] : wrapLine(expanded, wrapWidth);
  };
  /** @param {string[]} wrapped */
  const continued = (wrapped) =>
    continuation && wrapped.length > 1
      ? wrapped.map((line, index) => (index < wrapped.length - 1 ? `${line} \\` : line))
      : wrapped;
  const contentLines = lines.flatMap((line) => continued(wrap(line)));
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
