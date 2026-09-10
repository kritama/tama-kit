// @ts-check

/** All operations share the exact selected root and override order.
 * @param {{composeFile: string, runtime?: {composeFiles: string[]}}} plan
 */
export function composeArguments(plan) {
  return [
    "compose",
    ...(plan.runtime?.composeFiles ?? [plan.composeFile]).flatMap((path) => ["-f", path]),
  ];
}
