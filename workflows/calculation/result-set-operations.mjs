import { isUuid } from "./contracts/result-set.mjs";
import { CALCULATION_COMMAND } from "./runtime/cli-command.mjs";

export class ResultSetOperationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ResultSetOperationError";
    this.code = code;
    this.details = details;
  }
}

async function saveContext(contextStore, resultSet, target) {
  try {
    return await contextStore.save(resultSet, target);
  } catch (error) {
    throw new ResultSetOperationError(
      "local_context_write_failed",
      `Remote ResultSet ${resultSet.id} was read successfully, but its local recovery reference could not be written`,
      {
        resultSet,
        cause: error instanceof Error ? error.name : "unknown",
        nextCommand: `${CALCULATION_COMMAND} result-set get --result-set-id ${resultSet.id}`,
      },
    );
  }
}

export function createResultSetOperations({ api, contextStore }) {
  return {
    async list({ limit = 20 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ResultSetOperationError(
          "invalid_request",
          "limit must be an integer from 1 to 200",
        );
      }
      const data = await api.list(limit);
      return {
        data,
        completeness: {
          status: "bounded",
          limit,
          returned: data.items.length,
          mayHaveMore: data.items.length === limit,
          reason:
            "The remote ResultSet list contract has no cursor or total count",
        },
      };
    },

    async get({ resultSetId }) {
      if (!isUuid(resultSetId)) {
        throw new ResultSetOperationError(
          "invalid_request",
          "resultSetId must be an exact UUID; names are not resolved implicitly",
        );
      }
      const resultSet = await api.get(resultSetId);
      const contextPath = await saveContext(
        contextStore,
        resultSet,
        api.target,
      );
      return {
        data: resultSet,
        contextPath,
        completeness: { status: "complete", selector: "exact_result_set_id" },
      };
    },

    async create({ name, confirmed = false }) {
      const normalizedName = typeof name === "string" ? name.trim() : "";
      if (!normalizedName) {
        throw new ResultSetOperationError(
          "invalid_request",
          "name is required",
        );
      }
      if (!confirmed) {
        throw new ResultSetOperationError(
          "confirmation_required",
          "Creating a remote ResultSet requires --confirm-create after the exact name is reviewed",
          { name: normalizedName },
        );
      }
      const resultSet = await api.create(normalizedName);
      const contextPath = await saveContext(
        contextStore,
        resultSet,
        api.target,
      );
      return {
        data: resultSet,
        contextPath,
        completeness: {
          status: "complete",
          mutation: "remote_result_set_created",
        },
        warnings: [
          {
            code: "create_not_idempotent",
            message:
              "The remote create contract has no idempotency key; never blind-retry an uncertain request",
          },
        ],
      };
    },
  };
}
