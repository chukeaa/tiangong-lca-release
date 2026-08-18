import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function targetFingerprint(target) {
  return createHash("sha256")
    .update(`${target.commandUrl}\0${target.publishableKey}`)
    .digest("hex");
}

export function createResultSetContextStore({
  root = ".release",
  now = () => new Date(),
} = {}) {
  return {
    async save(resultSet, target) {
      const directory = path.resolve(root, "calculation", "result-sets");
      const outputPath = path.join(directory, `${resultSet.id}.json`);
      const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
      const document = {
        schemaVersion: "tiangong.calculation-result-set-reference.v1",
        resultSet,
        targetFingerprint: targetFingerprint(target),
        observedAt: now().toISOString(),
      };

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, outputPath);
      return outputPath;
    },
  };
}
