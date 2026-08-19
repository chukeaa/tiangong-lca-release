#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./lib/common.mjs";
import { writeJobStatus } from "./lib/background-job.mjs";
import { materialize } from "./lib/materialize.mjs";

const jobDir = path.resolve(process.argv[2] ?? "");
let job;

try {
  job = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  const startedAt = new Date().toISOString();
  let lastProgressWriteAt = 0;
  let lastProgressPhase = null;
  await writeJobStatus(jobDir, {
    state: "running",
    phase: "preparing",
    createdAt: job.createdAt,
    startedAt,
    updatedAt: startedAt,
    progress: null,
  });
  emit({ event: "job_started", jobId: job.jobId, time: startedAt });
  const onProgress = async (progress) => {
    const now = Date.now();
    const phaseChanged = progress.phase !== lastProgressPhase;
    const phaseCompleted =
      Number.isInteger(progress.total) && progress.completed === progress.total;
    if (!phaseChanged && !phaseCompleted && now - lastProgressWriteAt < 1000) {
      return;
    }
    lastProgressWriteAt = now;
    lastProgressPhase = progress.phase;
    const updatedAt = new Date().toISOString();
    emit({ event: "progress", jobId: job.jobId, time: updatedAt, ...progress });
    try {
      await writeJobStatus(jobDir, {
        state: "running",
        phase: progress.phase,
        createdAt: job.createdAt,
        startedAt,
        updatedAt,
        progress,
      });
    } catch (error) {
      emit({
        event: "status_write_failed",
        jobId: job.jobId,
        time: new Date().toISOString(),
        message: error.message,
      });
    }
  };
  const request = job.request;
  const result = await materialize({
    intakeDir: request.intakeDir,
    outDir: request.outDir,
    processUuids: request.processUuids,
    outputType: request.outputType,
    resultProcessLayer: request.resultProcessLayer,
    firstGeneration: request.firstGeneration,
    previousManifestPath: request.previousManifestPath,
    onProgress,
  });
  const completedAt = new Date().toISOString();
  const payload = {
    ok: true,
    jobId: job.jobId,
    output: result.path,
    manifest: path.join(result.path, "materialization-manifest.json"),
    request: result.request,
    summary: result.summary,
    completedAt,
  };
  await writeFile(job.paths.result, canonicalJson(payload), { flag: "wx" });
  await writeFile(job.paths.exitCode, "0\n", { flag: "wx" });
  await writeJobStatus(jobDir, {
    state: "succeeded",
    phase: "completed",
    createdAt: job.createdAt,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    progress: { phase: "completed", ...result.summary },
  });
  emit({
    event: "job_completed",
    jobId: job.jobId,
    time: completedAt,
    ...result.summary,
  });
} catch (error) {
  const failedAt = new Date().toISOString();
  const payload = {
    ok: false,
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    failedAt,
  };
  emit({
    event: "job_failed",
    jobId: job?.jobId ?? null,
    time: failedAt,
    ...payload.error,
  });
  try {
    await writeFile(path.join(jobDir, "result.json"), canonicalJson(payload), {
      flag: "wx",
    });
    await writeFile(path.join(jobDir, "exit-code"), "1\n", { flag: "wx" });
    await writeJobStatus(jobDir, {
      state: "failed",
      phase: "failed",
      createdAt: job?.createdAt ?? failedAt,
      updatedAt: failedAt,
      failedAt,
      error: payload.error,
    });
  } catch {}
  process.exitCode = 1;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
