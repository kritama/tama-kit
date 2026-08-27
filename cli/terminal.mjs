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
