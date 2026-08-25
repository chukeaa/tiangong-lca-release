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
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";

export async function readJson(file, code = "artifact_missing") {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(code, `Required artifact is unavailable: ${file}`, {
      cause: error?.code ?? "unknown",
    });
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    fail("artifact_json_invalid", `Artifact is not valid JSON: ${file}`);
  }
}

export async function assertAbsent(target) {
  try {
    await access(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeImmutableDirectory(target, build) {
  await assertAbsent(target);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    await build(staging);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function writeCanonical(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(value), { flag: "wx" });
}

export function verifyJsonHash(value, expected, code, label) {
  const observed = hashJson(value);
  if (observed !== expected)
    fail(code, `${label} hash has drifted`, { expected, observed });
  return observed;
}

export function verifyBytes(bytes, expected, code, label) {
  const observed = sha256Bytes(bytes);
  if (observed !== expected)
    fail(code, `${label} bytes have drifted`, { expected, observed });
  return observed;
}

export function containedPath(root, relative, code = "artifact_path_escape") {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/u)
      .some((part) => !part || part === "." || part === "..")
  )
    fail(code, `Unsafe relative artifact path: ${relative}`);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`))
    fail(code, `Artifact path escapes its root: ${relative}`);
  return target;
}

export function assertExactObject(value, allowedKeys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(code, `${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail(code, `${label} contains unknown fields`, { unknown: unknown.sort() });
  return value;
}
