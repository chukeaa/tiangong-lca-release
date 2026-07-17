import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveConfiguredReleaseTarget,
  targetPlanReference,
  type ReleaseTargetBinding,
} from "../target/profile.js";
import {
  ExternalCommandError,
  localToolEnvironment,
  runJsonCommand,
  runTextCommand,
  tiangongCliExecutable,
  tidasToolsExecutable,
} from "../tools/external.js";

type DoctorCheck = {
  id: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
};

export type DoctorReport = {
  schemaVersion: "tiangong.release-doctor-report.v1";
  status: "ready" | "blocked";
  complete: true;
  truncated: false;
  target: { targetId: string; targetFingerprint: string } | null;
  checks: DoctorCheck[];
  warnings: Array<{ code: string; message: string }>;
  artifactPaths: string[];
  nextCommands: string[];
};

async function toolCheck(input: {
  id: string;
  executable: string;
  cwd: string;
}): Promise<DoctorCheck> {
  let lastError: unknown;
  for (const args of [["--version"], ["--help"]]) {
    try {
      const result = await runTextCommand({
        executable: input.executable,
        args,
        cwd: input.cwd,
        env: localToolEnvironment(),
      });
      const firstLine = (result.stdout || result.stderr)
        .split(/\r?\n/u)[0]
        ?.trim();
      return {
        id: input.id,
        status: "passed",
        summary: firstLine
          ? `Executable available (${firstLine.slice(0, 160)}).`
          : "Executable available.",
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    id: input.id,
    status: "failed",
    summary:
      lastError instanceof ExternalCommandError
        ? `${lastError.code}: executable check failed.`
        : "Executable check failed.",
  };
}

async function managerProbe(): Promise<DoctorCheck> {
  const directory = mkdtempSync(
    path.join(tmpdir(), "tiangong-release-doctor-"),
  );
  const outputPath = path.join(directory, "projection.json");
  try {
    await runJsonCommand({
      executable: tiangongCliExecutable(),
      args: [
        "release",
        "calculation-bundle",
        "--package-id",
        randomUUID(),
        "--output",
        outputPath,
        "--force",
        "--json",
      ],
      cwd: directory,
      env: {
        ...process.env,
        TIANGONG_LCA_DISABLE_SESSION_CACHE: "true",
      },
    });
    return {
      id: "manager-read-probe",
      status: "passed",
      summary: existsSync(outputPath)
        ? "Actor-scoped manager read succeeded."
        : "Actor-scoped manager authorization succeeded.",
    };
  } catch (error) {
    if (
      error instanceof ExternalCommandError &&
      (error.code === "package_not_found" ||
        error.code.endsWith("_package_not_found"))
    ) {
      return {
        id: "manager-read-probe",
        status: "passed",
        summary:
          "Actor-scoped manager authorization passed; the random package was absent as expected.",
      };
    }
    return {
      id: "manager-read-probe",
      status: "failed",
      summary:
        error instanceof ExternalCommandError
          ? `${error.code}: actor-scoped manager read failed.`
          : "Actor-scoped manager read failed.",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function releaseDoctor(input: {
  targetId: string;
  cwd?: string;
}): Promise<DoctorReport> {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node-runtime",
    status: nodeMajor === 24 ? "passed" : "failed",
    summary:
      nodeMajor === 24
        ? `Node.js ${process.versions.node} satisfies >=24 <25.`
        : `Node.js ${process.versions.node} does not satisfy >=24 <25.`,
  });

  let target: ReleaseTargetBinding | null = null;
  try {
    target = resolveConfiguredReleaseTarget({
      targetId: input.targetId,
      requireCredential: false,
    });
    checks.push({
      id: "target-environment",
      status: "passed",
      summary: `Environment matches the versioned ${input.targetId} target profile.`,
    });
  } catch (error) {
    checks.push({
      id: "target-environment",
      status: "failed",
      summary: `${error instanceof Error ? error.message.split(":", 1)[0] : "release_target_environment_invalid"}.`,
    });
  }

  const credentialPresent = Boolean(process.env.TIANGONG_LCA_API_KEY?.trim());
  checks.push({
    id: "actor-credential",
    status: credentialPresent ? "passed" : "failed",
    summary: credentialPresent
      ? "Protected actor credential is present and its value was not reported or persisted."
      : "Protected actor credential is missing.",
  });

  const cliCheck = await toolCheck({
    id: "tiangong-lca-cli",
    executable: tiangongCliExecutable(),
    cwd,
  });
  checks.push(cliCheck);
  checks.push(
    await toolCheck({
      id: "tidas-tools",
      executable: tidasToolsExecutable(),
      cwd,
    }),
  );

  if (target && credentialPresent && cliCheck.status === "passed") {
    checks.push(await managerProbe());
  } else {
    checks.push({
      id: "manager-read-probe",
      status: "skipped",
      summary:
        "Manager read probe requires a matching target, actor credential, and available CLI.",
    });
  }

  const blocked = checks.some((check) => check.status !== "passed");
  return {
    schemaVersion: "tiangong.release-doctor-report.v1",
    status: blocked ? "blocked" : "ready",
    complete: true,
    truncated: false,
    target: target ? targetPlanReference(target) : null,
    checks,
    warnings: checks
      .filter((check) => check.status === "skipped")
      .map((check) => ({ code: check.id, message: check.summary })),
    artifactPaths: [],
    nextCommands: blocked
      ? [`tiangong-release doctor --target ${input.targetId} --json`]
      : [
          `tiangong-release bootstrap --target ${input.targetId} --package-id <package-id> --json`,
        ],
  };
}
