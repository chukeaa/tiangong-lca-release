import { fileURLToPath } from "node:url";

export const CALCULATION_CLI_PATH = fileURLToPath(
  new URL("../cli.mjs", import.meta.url),
);

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export const CALCULATION_COMMAND = `node ${shellQuote(CALCULATION_CLI_PATH)}`;
