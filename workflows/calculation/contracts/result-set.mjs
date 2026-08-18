const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ResultSetContractError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ResultSetContractError";
    this.code = "invalid_result_set_projection";
    this.details = details;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function decodeResultSet(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "resultSetId", "name", "createdAt"])
  ) {
    throw new ResultSetContractError(
      "ResultSet must contain exactly the v1 projection fields",
    );
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (
    value.schemaVersion !== "lcia.result-set.v1" ||
    !isUuid(value.resultSetId) ||
    !name ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new ResultSetContractError(
      "ResultSet contains invalid v1 field values",
    );
  }

  return {
    schemaVersion: "lcia.result-set.v1",
    resultSetId: value.resultSetId,
    name,
    createdAt: value.createdAt,
  };
}

export function decodeResultSetList(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["items"]) ||
    !Array.isArray(value.items)
  ) {
    throw new ResultSetContractError(
      "ResultSet list must contain exactly an items array",
    );
  }
  return { items: value.items.map(decodeResultSet) };
}

export function decodeCommandEnvelope(value, expectedCommand, decodeData) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.command !== expectedCommand ||
    !("data" in value)
  ) {
    throw new ResultSetContractError(
      `Expected successful ${expectedCommand} response envelope`,
    );
  }
  return decodeData(value.data);
}
