// @ts-check
import { createInterface } from "node:readline/promises";

export class CancelledInput extends Error {}
export class PreviousQuestion extends Error {}

/** @param {string} question */
export async function terminalQuestion(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve, reject) => {
      readline.once("close", () => reject(new CancelledInput()));
      readline.once("SIGINT", () => reject(new CancelledInput()));
      readline.question(question).then(resolve, reject);
    });
  } finally {
    readline.close();
  }
}

/** @param {import("../types.mjs").CommandIO} io */
export function questions(io) {
  /** @param {string} title @param {string} [suggested] @param {(value: string) => string} [validate] */
  async function text(title, suggested = "", validate = (value) => value) {
    while (true) {
      const raw = await io.prompt?.(`${title}${suggested ? ` [${suggested}]` : ""}: `);
      if (typeof raw !== "string") throw new CancelledInput();
      const answer = raw.trim();
      if (answer.toLowerCase() === ":cancel") throw new CancelledInput();
      if (answer.toLowerCase() === ":back") throw new PreviousQuestion();
      try {
        return validate(answer || suggested);
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : "Invalid answer");
      }
    }
  }
  /** @param {string} title @param {string[]} choices @param {number} [suggested] */
  async function choice(title, choices, suggested = 0) {
    io.stdout(title);
    choices.forEach((label, index) => {
      io.stdout(`  ${index + 1}. ${label}`);
    });
    const value = await text("Choose", String(suggested + 1), (answer) => {
      const exact = choices.findIndex((label) => label.toLowerCase() === answer.toLowerCase());
      const index = exact >= 0 ? exact : /^\d+$/u.test(answer) ? Number(answer) - 1 : -1;
      if (index < 0 || index >= choices.length)
        throw new Error("Choose one of the listed numbers.");
      return String(index);
    });
    return Number(value);
  }
  /** @param {string} title @param {boolean} [suggested] */
  async function confirm(title, suggested = false) {
    return (
      (await text(`${title} (yes/no)`, suggested ? "yes" : "no", (value) => {
        if (["y", "yes"].includes(value.toLowerCase())) return "yes";
        if (["n", "no"].includes(value.toLowerCase())) return "no";
        throw new Error("Please answer yes or no.");
      })) === "yes"
    );
  }
  return { text, choice, confirm };
}
