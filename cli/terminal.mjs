// @ts-check

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

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

/** @typedef {keyof typeof ANSI} PaintStyle */

/** @param {boolean} enabled @param {PaintStyle} style @param {string} value */
export function paint(enabled, style, value) {
  return enabled ? `${ANSI[style]}${value}${ANSI.reset}` : value;
}

/** @param {string} value */
export function visibleLength(value) {
  return stringWidth(value);
}

/** @param {string} value @param {number | undefined} maxWidth */
function wrapLine(value, maxWidth) {
  const columns = maxWidth ?? Math.max(1, value.length * 8);
  return wrapAnsi(value, Math.max(1, columns), {
    hard: false,
    trim: false,
    wordWrap: true,
  }).split("\n");
}

/**
 * Render prose in a padded box. Shell commands and URLs intentionally do not
 * use this helper: hard line breaks would make those values unsafe to copy.
 * @param {{title?: string, lines: string[], color: boolean, style?: PaintStyle, maxWidth?: number}} options
 * @returns {string[]}
 */
export function renderBox({ title, lines, color, style, maxWidth }) {
  const unboxed = () => [
    ...(title === undefined ? [] : [paint(color, "bold", title)]),
    ...lines.map((line) => (style === undefined ? line : paint(color, style, line))),
  ];
  if (maxWidth !== undefined && maxWidth < 1) {
    return unboxed();
  }

  const titleLines = title === undefined ? [] : wrapLine(title, maxWidth);
  const contentLines = lines.flatMap((line) => wrapLine(line, maxWidth));
  const width = [...titleLines, ...contentLines].reduce(
    (widest, line) => Math.max(widest, visibleLength(line)),
    0,
  );
  if (maxWidth !== undefined && width > maxWidth) {
    return unboxed();
  }
  const inner = width + 2;
  /** @param {string} value */
  const dim = (value) => paint(color, "dim", value);
  /** @param {string} plain @param {string} displayed */
  const row = (plain, displayed) => {
    const padding = " ".repeat(width - visibleLength(plain));
    return `${dim("│")} ${displayed}${padding} ${dim("│")}`;
  };
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
