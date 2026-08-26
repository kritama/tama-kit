// @ts-check

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** @param {string} composeFile */
export function formatComposeUpCommand(composeFile) {
  return `docker compose -f ${shellQuote(composeFile)} up -d tama`;
}

/** @param {string} composeFile */
export function formatComposePsCommand(composeFile) {
  return `docker compose -f ${shellQuote(composeFile)} ps`;
}
