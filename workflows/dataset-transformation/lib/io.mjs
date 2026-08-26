import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";

export async function readJson(file, code = "json_read_failed") {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(code, `Cannot read JSON artifact: ${file}`, { cause: error.code });
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    fail(code, `Artifact is not valid JSON: ${file}`);
  }
}

export function containedPath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`))
    fail("artifact_path_escape", `Artifact path escapes its root: ${relative}`);
  return target;
}

export async function writeCanonical(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(value), { flag: "wx" });
}

export async function writeImmutableDirectory(target, writer) {
  const resolved = path.resolve(target);
  try {
    await access(resolved);
    fail("output_exists", `Output directory already exists: ${resolved}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const staging = await mkdtemp(`${resolved}.tmp-`);
  try {
    await writer(staging);
    await rename(staging, resolved);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return resolved;
}
