import { fileURLToPath } from "node:url";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export const MATERIALIZATION_CLI_PATH = fileURLToPath(
  new URL("../cli.mjs", import.meta.url),
);

export const MATERIALIZATION_COMMAND = `node ${shellQuote(MATERIALIZATION_CLI_PATH)}`;

export const RELEASE_CLI_PATH = fileURLToPath(
  new URL("../../release/cli.mjs", import.meta.url),
);

export const RELEASE_COMMAND = `node ${shellQuote(RELEASE_CLI_PATH)}`;
