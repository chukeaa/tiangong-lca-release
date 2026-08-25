import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export function canonicalJson(value) {
  return `${canonicalize(value)}\n`;
}

export function hashJson(value) {
  return sha256Bytes(Buffer.from(canonicalize(value)));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
