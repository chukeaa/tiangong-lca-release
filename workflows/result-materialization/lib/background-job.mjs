import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";
import { prepareMaterialization } from "./materialize.mjs";
import {
  MATERIALIZATION_COMMAND,
  RELEASE_COMMAND,
  shellQuote,
} from "../runtime/cli-command.mjs";

const JOB_SCHEMA = "tiangong.release.materialization-job.v1";
const STATUS_SCHEMA = "tiangong.release.materialization-job-status.v1";
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const DEFAULT_ARTIFACT_ROOT = fileURLToPath(
  new URL("../../../.release/", import.meta.url),
);

export function artifactRoot(value) {
  return path.resolve(value ?? DEFAULT_ARTIFACT_ROOT);
}

export function jobsRoot(value) {
  return path.join(artifactRoot(value), "result-materialization", "jobs");
}

export async function startMaterializationJob({ artifactRoot: root, request }) {
  const plan = request.outDir ? null : await prepareMaterialization(request);
  const jobId = randomUUID();
  const rootPath = jobsRoot(root);
  const jobDir = path.join(rootPath, jobId);
  await mkdir(rootPath, { recursive: true });
  await mkdir(jobDir);
  const createdAt = new Date().toISOString();
  const job = {
    schemaVersion: JOB_SCHEMA,
    jobId,
    createdAt,
    request,
    outputPath: plan?.target ?? path.resolve(request.outDir),
    paths: {
      job: path.join(jobDir, "job.json"),
      status: path.join(jobDir, "status.json"),
      process: path.join(jobDir, "process.json"),
      log: path.join(jobDir, "job.log"),
      exitCode: path.join(jobDir, "exit-code"),
      result: path.join(jobDir, "result.json"),
    },
  };
  await writeFile(job.paths.job, canonicalJson(job), { flag: "wx" });
  await writeStatus(jobDir, {
    state: "queued",
    phase: "queued",
    createdAt,
    updatedAt: createdAt,
  });
  const log = await open(job.paths.log, "a");
  let child;
  try {
    child = spawn(
      "nohup",
      [
        process.execPath,
        fileURLToPath(new URL("../job-runner.mjs", import.meta.url)),
        jobDir,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.env,
      },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await writeFile(
      job.paths.process,
      canonicalJson({
        pid: child.pid,
        startedAt: new Date().toISOString(),
        runner: "nohup-node.v1",
        jobDir,
      }),
      { flag: "wx" },
    );
    child.unref();
  } catch (error) {
    await writeStatus(jobDir, {
      state: "failed",
      phase: "launch",
      createdAt,
      updatedAt: new Date().toISOString(),
      error: { code: "background_launch_failed", message: error.message },
    });
    fail(
      "background_launch_failed",
      `Unable to start nohup job: ${error.message}`,
    );
  } finally {
    await log.close();
  }
  return getMaterializationJob({ artifactRoot: root, jobId });
}

export async function getMaterializationJob({ artifactRoot: root, jobId }) {
  const rootPath = artifactRoot(root);
  const jobDir = resolveJobDir(root, jobId);
  const job = await readJson(path.join(jobDir, "job.json"), "job_not_found");
  const status = await readJson(
    path.join(jobDir, "status.json"),
    "job_status_missing",
  );
  const processRecord = await readOptionalJson(
    path.join(jobDir, "process.json"),
  );
  const exitCode = await readOptionalExitCode(path.join(jobDir, "exit-code"));
  const alive = processRecord
    ? expectedRunnerIsAlive(processRecord.pid, jobDir)
    : false;
  let state = status.state;
  if (!TERMINAL_STATES.has(state) && !alive) {
    if (exitCode === 0) state = "succeeded";
    else if (Number.isInteger(exitCode)) state = "failed";
    else if (state === "cancelling") state = "cancelled";
    else if (processRecord) state = "interrupted";
  }
  if (state !== status.state && TERMINAL_STATES.has(state)) {
    await writeStatus(jobDir, {
      ...status,
      state,
      updatedAt: new Date().toISOString(),
    });
  }
  return {
    ok: true,
    jobId,
    state,
    phase: status.phase,
    pid: processRecord?.pid ?? null,
    processAlive: alive,
    exitCode,
    progress: status.progress ?? null,
    resources: status.resources ?? null,
    createdAt: job.createdAt,
    updatedAt: status.updatedAt,
    outputPath: job.outputPath,
    artifactRoot: rootPath,
    jobDir,
    logPath: job.paths.log,
    resultPath: job.paths.result,
    nextActions: nextActions(job, state, rootPath),
  };
}

export async function readMaterializationJobLogs({
  artifactRoot: root,
  jobId,
  tail = 100,
}) {
  if (!Number.isInteger(tail) || tail < 1 || tail > 500) {
    fail("invalid_tail", "--tail must be an integer from 1 to 500");
  }
  const jobDir = resolveJobDir(root, jobId);
  const job = await readJson(path.join(jobDir, "job.json"), "job_not_found");
  let text;
  try {
    text = await readFile(job.paths.log, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") text = "";
    else throw error;
  }
  const all = text.split(/\r?\n/).filter(Boolean);
  const selected = all.slice(-tail);
  let truncatedLineCount = 0;
  const lines = selected.map((line) => {
    if (line.length <= 4000) return line;
    truncatedLineCount += 1;
    return `${line.slice(0, 4000)}…`;
  });
  return {
    ok: true,
    jobId,
    artifactRoot: artifactRoot(root),
    logPath: job.paths.log,
    requestedTail: tail,
    returnedLineCount: lines.length,
    truncated: all.length > lines.length,
    truncatedLineCount,
    lines,
  };
}

export async function cancelMaterializationJob({ artifactRoot: root, jobId }) {
  const jobDir = resolveJobDir(root, jobId);
  const current = await getMaterializationJob({ artifactRoot: root, jobId });
  if (TERMINAL_STATES.has(current.state)) return current;
  if (!current.processAlive || !current.pid) {
    return getMaterializationJob({ artifactRoot: root, jobId });
  }
  const status = await readJson(
    path.join(jobDir, "status.json"),
    "job_status_missing",
  );
  await writeStatus(jobDir, {
    ...status,
    state: "cancelling",
    updatedAt: new Date().toISOString(),
    cancellationRequestedAt: new Date().toISOString(),
  });
  try {
    process.kill(current.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return {
    ...(await getMaterializationJob({ artifactRoot: root, jobId })),
    cancellationRequested: true,
  };
}

export async function writeJobStatus(jobDir, value) {
  return writeStatus(jobDir, value);
}

function resolveJobDir(root, jobId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      jobId ?? "",
    )
  ) {
    fail("invalid_job_id", "--job-id must be a UUID");
  }
  return path.join(jobsRoot(root), jobId.toLowerCase());
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      fail(code, `Required job file does not exist: ${file}`);
    throw error;
  }
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalExitCode(file) {
  try {
    const value = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
    return Number.isInteger(value) ? value : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expectedRunnerIsAlive(pid, jobDir) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const inspected = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return (
    inspected.status === 0 &&
    inspected.stdout.includes("job-runner.mjs") &&
    inspected.stdout.includes(jobDir)
  );
}

async function writeStatus(jobDir, value) {
  const target = path.join(jobDir, "status.json");
  const temporary = path.join(
    jobDir,
    `.status-${process.pid}-${randomUUID()}.tmp`,
  );
  await writeFile(
    temporary,
    canonicalJson({ schemaVersion: STATUS_SCHEMA, ...value }),
    { flag: "wx" },
  );
  await rename(temporary, target);
}

function nextActions(job, state, rootPath) {
  const { jobId } = job;
  const rootOption = ` --artifact-root ${shellQuote(rootPath)}`;
  if (state === "running" || state === "queued" || state === "cancelling") {
    return [
      `${MATERIALIZATION_COMMAND} job get --job-id ${jobId}${rootOption} --json`,
      `${MATERIALIZATION_COMMAND} job logs --job-id ${jobId}${rootOption} --tail 100 --json`,
    ];
  }
  if (state === "succeeded") {
    const releaseIntake = path.join(
      rootPath,
      "release",
      "intakes",
      path.basename(job.outputPath),
    );
    return [
      `${RELEASE_COMMAND} intake prepare --materialization ${shellQuote(job.outputPath)} --source-intake ${shellQuote(job.request.intakeDir)} --out-dir ${shellQuote(releaseIntake)} --json`,
    ];
  }
  return [
    `${MATERIALIZATION_COMMAND} job logs --job-id ${jobId}${rootOption} --tail 100 --json`,
  ];
}
