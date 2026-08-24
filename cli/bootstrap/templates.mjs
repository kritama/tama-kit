import { readFileSync } from "node:fs";

const TEMPLATE_ROOT = new URL("../templates/bootstrap/", import.meta.url);

export function renderTemplate(name, replacements = {}) {
  let content = readFileSync(new URL(name, TEMPLATE_ROOT), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, String(value));
  }
  const unresolved = content.match(/\{\{[A-Z0-9_]+\}\}/gu);
  if (unresolved) {
    throw new Error(`template ${name} has unresolved values: ${unresolved.join(", ")}`);
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}
