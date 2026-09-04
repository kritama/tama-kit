// @ts-check

/** @param {string} value */
function shellQuote(value) {
  const characters = Array.from(value);
  const hasControlCharacter = characters.some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasControlCharacter) {
    // ANSI-C quoting keeps control characters visible and copyable instead of
    // letting them create physical terminal lines inside the displayed command.
    const escaped = characters
      .map((character) => {
        if (character === "\\" || character === "'") {
          return `\\${character}`;
        }
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint > 0x1f && codePoint !== 0x7f) {
          return character;
        }
        switch (character) {
          case "\u0007":
            return "\\a";
          case "\b":
            return "\\b";
          case "\u001b":
            return "\\e";
          case "\f":
            return "\\f";
          case "\n":
            return "\\n";
          case "\r":
            return "\\r";
          case "\t":
            return "\\t";
          case "\v":
            return "\\v";
          default:
            return `\\x${codePoint.toString(16).padStart(2, "0")}`;
        }
      })
      .join("");
    return `$'${escaped}'`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** @param {string} composeFile @param {string} [service] @param {boolean} [build] */
export function formatComposeUpCommand(composeFile, service = "tama", build = false) {
  return `docker compose -f ${shellQuote(composeFile)} up -d${build ? " --build" : ""} ${shellQuote(service).slice(1, -1)}`;
}

/** @param {string} composeFile */
export function formatComposePsCommand(composeFile) {
  return `docker compose -f ${shellQuote(composeFile)} ps`;
}
