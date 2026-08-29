import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import canonicalize from "canonicalize";

export function normalizeStrings(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.normalize("NFC"),
        normalizeStrings(item),
      ]),
    );
  return value;
}

export function canonicalJson(value) {
  return `${canonicalize(normalizeStrings(value))}\n`;
}

export function hashJson(value) {
  return sha256Bytes(Buffer.from(canonicalize(normalizeStrings(value))));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function nearlyEqual(left, right, tolerance = 1e-12) {
  return (
    Math.abs(left - right) <=
    tolerance * Math.max(Math.abs(left), Math.abs(right), 1)
  );
}

export function amountString(value) {
  if (!Number.isFinite(value))
    fail("numeric_result_invalid", "Non-finite amount");
  if (Object.is(value, -0) || value === 0) return "0";
  return String(Number(value.toPrecision(15)));
}

export function deepGet(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return current;
}

export function deepSet(value, path, replacement) {
  let current = value;
  for (const key of path.slice(0, -1)) {
    current[key] ??= {};
    current = current[key];
  }
  const finalKey = path.at(-1);
  if (replacement === undefined) delete current[finalKey];
  else current[finalKey] = structuredClone(replacement);
}

export const HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const VERSION_PATTERN = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
