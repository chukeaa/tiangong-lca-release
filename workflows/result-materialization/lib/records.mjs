import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";

export async function* readNdjson(path) {
  const input = createReadStream(path);
  const stream = path.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line);
  }
}
