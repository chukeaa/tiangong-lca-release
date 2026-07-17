import path from "node:path";
import {
  validatePackageDir,
  type PackageValidationReport,
} from "@tiangong-lca/tidas-sdk";
import type { JsonValue } from "../contracts/json.js";

function normalizeIssue(
  issue: PackageValidationReport["issues"][number],
  root: string,
): JsonValue {
  return {
    issueCode: issue.issue_code,
    severity: issue.severity,
    category: issue.category,
    filePath: path.relative(root, issue.file_path).split(path.sep).join("/"),
    location: issue.location,
    message: issue.message,
    context: issue.context as JsonValue,
  };
}

export function validateCanonicalTidasTree(
  inputDirectory: string,
): JsonValue & {
  status: "passed" | "failed";
} {
  const root = path.resolve(inputDirectory);
  const report = validatePackageDir(root, false);
  return {
    schemaVersion: "tiangong.release.tidas-validation-report.v1",
    status: report.ok ? "passed" : "failed",
    summary: {
      categoryCount: report.summary.category_count,
      issueCount: report.summary.issue_count,
      errorCount: report.summary.error_count,
      warningCount: report.summary.warning_count,
      infoCount: report.summary.info_count,
    },
    categories: report.categories.map((category) => ({
      category: category.category,
      status: category.ok ? "passed" : "failed",
      summary: {
        issueCount: category.summary.issue_count,
        errorCount: category.summary.error_count,
        warningCount: category.summary.warning_count,
        infoCount: category.summary.info_count,
      },
      issues: category.issues.map((issue) => normalizeIssue(issue, root)),
    })) as JsonValue,
    issues: report.issues.map((issue) =>
      normalizeIssue(issue, root),
    ) as JsonValue,
  };
}
