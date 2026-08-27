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

/** @param {string} value */
export function visibleLength(value) {
  return stripAnsi(value).length;
}

/**
 * @param {string} line
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapLine(line, maxWidth) {
  if (line.length <= maxWidth) {
    return [line];
  }
  const wrapped = [];
  let current = "";
  for (const word of line.trim().split(/\s+/u)) {
    let rest = word;
    while (rest.length > maxWidth) {
      if (current) {
        wrapped.push(current);
        current = "";
      }
      wrapped.push(rest.slice(0, maxWidth));
      rest = rest.slice(maxWidth);
    }
    const candidate = current ? `${current} ${rest}` : rest;
    if (candidate.length <= maxWidth) {
      current = candidate;
    } else {
      wrapped.push(current);
      current = rest;
    }
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
  const content = lines
    .flatMap(wrap)
    .map((line) => (style === undefined ? line : paint(color, style, line)));
  const titleLines =
    title === undefined ? [] : wrap(title).map((line) => paint(color, "bold", line));
  const width = [...titleLines, ...content].reduce(
    (max, line) => Math.max(max, visibleLength(line)),
    0,
  );
  const inner = width + 2;
  /** @param {string} value */
  const dim = (value) => paint(color, "dim", value);
  /** @param {string} line */
  const row = (line) =>
    `${dim("│")} ${line}${" ".repeat(inner - visibleLength(line) - 1)}${dim("│")}`;
  const output = [dim(`┌${"─".repeat(inner)}┐`), ...titleLines.map(row)];
  if (title !== undefined) {
    output.push(dim(`├${"─".repeat(inner)}┤`));
  }
  output.push(...content.map(row), dim(`└${"─".repeat(inner)}┘`));
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
