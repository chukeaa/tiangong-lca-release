import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/json.js";

const loneSurrogatePattern =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function normalizeString(value: string): string {
  if (loneSurrogatePattern.test(value)) {
    throw new TypeError("Canonical JSON rejects lone Unicode surrogates.");
  }
  return value.normalize("NFC");
}

function serialize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeString(value));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON rejects non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }

  const normalizedEntries = Object.entries(value).map(
    ([key, item]) => [normalizeString(key), item] as const,
  );
  const normalizedKeys = new Set(normalizedEntries.map(([key]) => key));
  if (normalizedKeys.size !== normalizedEntries.length) {
    throw new TypeError(
      "Canonical JSON object keys collide after Unicode NFC normalization.",
    );
  }
  normalizedEntries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${normalizedEntries
    .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
    .join(",")}}`;
}

export function canonicalize(value: JsonValue): string {
  return serialize(value);
}

export function canonicalSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
