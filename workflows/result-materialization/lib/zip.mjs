import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { fail } from "./common.mjs";

const MAX_ENTRIES = 10000;
const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;

export function extractZip(zipPath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let entries = 0;
      let total = 0;
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", async (entry) => {
        try {
          entries += 1;
          total += entry.uncompressedSize;
          if (entries > MAX_ENTRIES || total > MAX_UNCOMPRESSED_BYTES) {
            fail(
              "bundle_limits_exceeded",
              "ZIP exceeds safe extraction limits",
            );
          }
          const normalized = entry.fileName.replaceAll("\\", "/");
          if (
            normalized.startsWith("/") ||
            normalized.split("/").includes("..") ||
            /^[A-Za-z]:/.test(normalized)
          ) {
            fail("unsafe_bundle_path", `Unsafe ZIP entry: ${entry.fileName}`);
          }
          const target = path.join(destination, normalized);
          if (normalized.endsWith("/")) {
            await mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }
          await mkdir(path.dirname(target), { recursive: true });
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError);
            const output = createWriteStream(target, { flags: "wx" });
            stream.on("error", reject);
            output.on("error", reject);
            output.on("close", () => zip.readEntry());
            stream.pipe(output);
          });
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  });
}
