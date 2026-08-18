const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ResultSetContractError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ResultSetContractError";
    this.code = "invalid_result_set_reference";
    this.details = details;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Converts a provider-owned payload into the minimal ResultSet reference used
 * by Calculation. Provider fields may grow or change versions without leaking
 * those details into the Workflow model.
 */
export function projectResultSetReference(value) {
  if (!isRecord(value)) {
    throw new ResultSetContractError(
      "ResultSet response must be an object containing identity semantics",
    );
  }

  const id = firstString(value, ["resultSetId", "id"]);
  const name = firstString(value, ["name", "displayName"]);
  const createdAtValue = firstString(value, ["createdAt", "created_at"]);
  const createdAt =
    createdAtValue && Number.isFinite(Date.parse(createdAtValue))
      ? createdAtValue
      : null;
  const externalSchemaVersion = firstString(value, [
    "schemaVersion",
    "schema_version",
  ]);

  if (!isUuid(id) || !name) {
    throw new ResultSetContractError(
      "ResultSet response must provide a UUID identity and non-empty name",
      {
        missing: [!isUuid(id) ? "id" : null, !name ? "name" : null].filter(
          Boolean,
        ),
      },
    );
  }

  return {
    id,
    name,
    createdAt,
    source: {
      system: "tiangong-lca",
      externalSchemaVersion,
    },
  };
}

export function projectResultSetReferenceList(value) {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : null;
  if (!items) {
    throw new ResultSetContractError(
      "ResultSet list response must provide an items array",
    );
  }
  return { items: items.map(projectResultSetReference) };
}

export function decodeCommandEnvelope(value, decodeData) {
  if (!isRecord(value) || value.ok !== true || !("data" in value)) {
    throw new ResultSetContractError(
      "Expected a successful ResultSet response envelope with data",
    );
  }
  return decodeData(value.data);
}
