import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import canonicalize from "canonicalize";

export const sha256Bytes = (value) =>
  createHash("sha256").update(value).digest("hex");

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function canonicalBytes(value) {
  return Buffer.from(
    canonicalize(value.normalize ? value.normalize("NFC") : value),
  );
}

export function canonicalJson(value) {
  return `${canonicalize(normalizeStrings(value))}\n`;
}

function normalizeStrings(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.normalize("NFC"),
        normalizeStrings(item),
      ]),
    );
  }
  return value;
}

export function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
