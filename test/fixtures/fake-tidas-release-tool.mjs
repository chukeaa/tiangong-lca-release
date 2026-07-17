#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.TIANGONG_LCA_API_KEY) {
  process.stderr.write("protected release credential reached local tool\n");
  process.exit(10);
}
if (args[0] === "--version") {
  process.stdout.write("tidas-release-tool 0.0.0-fixture\n");
  process.exit(0);
}
const command = args[0];
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

let result;
if (command === "validate-tidas" || command === "validate-ilcd") {
  result = {
    schemaVersion: "fake.validation.v1",
    status: "passed",
    format: command === "validate-tidas" ? "tidas" : "ilcd",
  };
} else if (command === "convert-ilcd") {
  mkdirSync(option("--output-dir"), { recursive: true });
  result = {
    schemaVersion: "fake.conversion.v1",
    status: "passed",
    datasetCount: 3,
  };
} else if (command === "semantic-roundtrip") {
  result = {
    schemaVersion: "fake.roundtrip.v1",
    status: "passed",
    mismatchCount: 0,
  };
} else if (command === "build-packages") {
  const outputDirectory = option("--output-dir");
  mkdirSync(outputDirectory, { recursive: true });
  const profiles = [
    "unit-process-full-closure.v1",
    "standalone-lifecyclemodel-result-full-closure.v1",
  ];
  const packages = [];
  for (const profileId of profiles) {
    for (const format of ["tidas", "ilcd"]) {
      const filePath = path.join(outputDirectory, `${profileId}.${format}.zip`);
      const body = Buffer.from(`${profileId}:${format}\n`, "utf8");
      writeFileSync(filePath, body);
      packages.push({
        profileId,
        format,
        selfContained: true,
        closureHash: sha256(Buffer.from(`${profileId}:closure`)),
        datasetCount: profileId.startsWith("unit-") ? 2 : 4,
        artifact: {
          path: filePath,
          sha256: sha256(body),
          byteSize: statSync(filePath).size,
          mediaType: "application/zip",
          memberCount: 1,
        },
      });
    }
  }
  result = {
    schemaVersion: "fake.packages.v1",
    status: "passed",
    profiles: [],
    packages,
    artifactSetHash: sha256(
      Buffer.from(
        packages.map((item) => item.artifact.sha256).join(":"),
        "utf8",
      ),
    ),
  };
} else {
  result = {
    schemaVersion: "fake.error.v1",
    status: "failed",
    error: { code: "fake_command_unknown", message: String(command) },
  };
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(result)}\n`);
