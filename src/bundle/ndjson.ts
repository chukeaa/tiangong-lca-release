import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

export async function* readNdjsonFile<T>(
  filePath: string,
  compression: "gzip" | "none" = "none",
): AsyncGenerator<T> {
  const source = createReadStream(filePath);
  const input = compression === "gzip" ? source.pipe(createGunzip()) : source;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) {
      throw new Error(`ndjson_empty_line:${filePath}:${lineNumber}`);
    }
    try {
      yield JSON.parse(line) as T;
    } catch (error) {
      throw new Error(
        `ndjson_invalid_json:${filePath}:${lineNumber}:${String(error)}`,
      );
    }
  }
}
