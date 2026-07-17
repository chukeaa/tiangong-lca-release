import { createHash } from "node:crypto";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeUuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) {
    throw new TypeError(`Invalid UUID: ${value}`);
  }
  return normalized;
}

function uuidToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    Buffer.from(normalizeUuid(value).replaceAll("-", ""), "hex"),
  );
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export const NS_TG_RELEASE_ROOT_V1 = "18d2e159-c958-5822-9635-acc24f61b880";
export const NS_TG_LIFECYCLE_MODEL_V1 = "1f09df9a-9a14-5247-a355-90ce73b521dd";
export const NS_TG_RESULT_PROCESS_V1 = "6d130f3d-ca65-5a6f-a842-4b2f9c2f5461";
