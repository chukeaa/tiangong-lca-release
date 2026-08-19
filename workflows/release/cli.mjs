#!/usr/bin/env node
import path from "node:path";
import {
  buildPackageCandidate,
  PACKAGE_PROFILE,
} from "./lib/package-build.mjs";

const HELP = `release-package <command> [options]

Commands:
  package build       Build one local, unapproved Release Candidate from a frozen LifecycleModel materialization

package build options:
  --materialization <path>  Completed Result Materialization directory
  --intake <path>           Verified local intake containing source_closure
  --profile <id>            ${PACKAGE_PROFILE}
  --out-dir <path>          New immutable Release Candidate directory
  --tidas-bin <path>        tidas executable; defaults to TIDAS_BIN or PATH lookup

Common:
  --json                    Emit one bounded JSON result on stdout
  --help                    Show this help

The command performs no upload or publication and does not authorize either action. It delegates closure validation,
TIDAS/eILCD validation, semantic round-trip, and deterministic ZIP creation to tidas-tools.
`;

async function main() {
  const [command, action, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command !== "package" || action !== "build") {
    throw Object.assign(
      new Error(
        `Unknown command: ${[command, action].filter(Boolean).join(" ")}`,
      ),
      {
        code: "unknown_command",
      },
    );
  }
  const options = parseArgs(tokens);
  requireOptions(options, ["materialization", "intake", "profile", "out-dir"]);
  if (options.profile !== PACKAGE_PROFILE) {
    throw Object.assign(
      new Error(
        `Unsupported profile: ${options.profile}; expected ${PACKAGE_PROFILE}`,
      ),
      { code: "unsupported_package_profile" },
    );
  }
  const result = await buildPackageCandidate({
    materializationDir: path.resolve(options.materialization),
    intakeDir: path.resolve(options.intake),
    outDir: path.resolve(options["out-dir"]),
    tidasBin: options["tidas-bin"],
  });
  respond(options, {
    ok: true,
    command: "package build",
    outcome: "candidate_built",
    completeness: "full-closure-validated",
    profile: result.candidate.profile,
    candidate: result.path,
    packageCount: result.candidate.packages.length,
    packageSetHash: result.candidate.packageSetHash,
    publicationAuthorized: false,
    nextAction: {
      description:
        "Review release-candidate.json and package artifacts; building a candidate does not authorize upload or publication.",
    },
  });
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw Object.assign(new Error(`Unexpected argument: ${token}`), {
        code: "invalid_arguments",
      });
    const key = token.slice(2);
    if (key === "json") result[key] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--"))
        throw Object.assign(new Error(`Missing value for --${key}`), {
          code: "invalid_arguments",
        });
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw Object.assign(
      new Error(
        `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
      ),
      { code: "invalid_arguments" },
    );
}

function respond(options, value) {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`Release Candidate built\n\nSummary:\n`);
    process.stdout.write(`- Candidate: ${value.candidate}\n`);
    process.stdout.write(`- Profile: ${value.profile}\n`);
    process.stdout.write(`- Packages: ${value.packageCount}\n`);
    process.stdout.write(`- Publication authorized: no\n\nNext:\n`);
    process.stdout.write(`- ${value.nextAction.description}\n`);
  }
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
