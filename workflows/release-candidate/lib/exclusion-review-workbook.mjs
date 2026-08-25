import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";

const WORKBOOK_NAME = "exclusion-impact-review.xlsx";
const RECEIPT_NAME = "exclusion-impact-review-receipt.json";
const SHEET_NAMES = Object.freeze([
  "Summary",
  "Invalid Data",
  "Affected Roots",
  "Derived Data",
  "Unreachable Support",
  "Complete Exclusion Set",
  "Reference Conflicts",
]);

export async function buildExclusionImpactReviewWorkbook({
  impactReportPath,
  outDir,
  spreadsheetNodeModules,
  previewDir,
}) {
  const reportPath = path.resolve(impactReportPath);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.schemaVersion !== "tiangong.release.exclusion-impact-report.v1")
    fail(
      "exclusion_impact_report_invalid",
      "Expected tiangong.release.exclusion-impact-report.v1",
    );
  const sourceReportSha256 = hashJson(report);
  const target = path.resolve(outDir);
  if (!previewDir)
    fail(
      "review_workbook_preview_dir_required",
      "A preview directory is required to visually verify every workbook sheet",
    );
  const previews = path.resolve(previewDir);
  await assertTargetAbsent(target);
  await assertTargetAbsent(previews);
  const model = buildExclusionReviewWorkbookModel(report, {
    sourceReportSha256,
  });
  const { SpreadsheetFile, Workbook } = await loadArtifactTool(
    spreadsheetNodeModules,
  );
  const workbook = Workbook.create();
  const sheets = new Map(
    SHEET_NAMES.map((name) => [name, workbook.worksheets.add(name)]),
  );
  populateDetailSheet(sheets.get("Invalid Data"), model.invalidData, {
    widths: [15, 39, 13, 66, 24, 12, 13, 30, 18, 19],
  });
  populateDetailSheet(sheets.get("Affected Roots"), model.affectedRoots, {
    widths: [39, 13, 16],
  });
  populateDetailSheet(sheets.get("Derived Data"), model.derivedData, {
    widths: [16, 20, 21, 39, 13, 16, 53, 56],
  });
  populateDetailSheet(
    sheets.get("Unreachable Support"),
    model.unreachableSupport,
    { widths: [16, 20, 39, 13, 58] },
  );
  populateDetailSheet(
    sheets.get("Complete Exclusion Set"),
    model.completeExclusionSet,
    { widths: [16, 20, 21, 39, 13, 58, 34] },
  );
  populateDetailSheet(
    sheets.get("Reference Conflicts"),
    model.referenceConflicts,
    { widths: [62, 39, 13] },
  );
  populateSummarySheet(sheets.get("Summary"), model);

  const keyInspection = await workbook.inspect({
    kind: "table",
    range: "Summary!A1:D22",
    include: "values,formulas",
    tableMaxRows: 22,
    tableMaxCols: 4,
    maxChars: 7000,
  });
  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    summary: "exclusion review formula error scan",
    maxChars: 3000,
  });
  assertFormulaErrorScanClean(formulaErrors.ndjson);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}`;
  await mkdir(staging, { recursive: false });
  try {
    await mkdir(previews, { recursive: true });
    for (const sheetName of SHEET_NAMES) {
      const preview = await workbook.render({
        sheetName,
        autoCrop: "all",
        scale: 1,
        format: "png",
      });
      await writeFile(
        path.join(previews, `${fileSafe(sheetName)}.png`),
        new Uint8Array(await preview.arrayBuffer()),
      );
    }
    const stagedWorkbook = path.join(staging, WORKBOOK_NAME);
    const output = await SpreadsheetFile.exportXlsx(workbook);
    await suppressArtifactInspectNotice(() => output.save(stagedWorkbook));
    await rm(`${stagedWorkbook}.inspect.ndjson`, { force: true });
    const workbookBytes = await readFile(stagedWorkbook);
    const receipt = {
      schemaVersion: "tiangong.release.exclusion-impact-review-receipt.v1",
      authoritative: false,
      publicationAuthorized: false,
      source: {
        impactReportSha256: sourceReportSha256,
      },
      workbook: {
        path: WORKBOOK_NAME,
        sha256: sha256Bytes(workbookBytes),
        byteSize: workbookBytes.length,
        sheets: SHEET_NAMES,
      },
      verification: {
        keyRangeInspected: "Summary!A1:D22",
        formulaErrorScanCompleted: true,
        formulaErrorCount: 0,
        visualPreviewSheetCount: SHEET_NAMES.length,
      },
    };
    await writeFile(path.join(staging, RECEIPT_NAME), canonicalJson(receipt), {
      flag: "wx",
    });
    await rename(staging, target);
    return {
      path: target,
      impactReportPath: reportPath,
      workbookPath: path.join(target, WORKBOOK_NAME),
      receiptPath: path.join(target, RECEIPT_NAME),
      receipt,
      model,
      sourceReportSha256,
      inspection: {
        keyRange: keyInspection.ndjson,
        formulaErrors: formulaErrors.ndjson,
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(previews, { recursive: true, force: true });
    throw error;
  }
}

export function buildExclusionReviewWorkbookModel(
  report,
  { sourceReportSha256 = hashJson(report) } = {},
) {
  const impact = report.impact ?? {};
  const invalid = report.validationIssues?.invalidDatasets ?? [];
  const derived = impact.affectedMaterializedDatasets ?? [];
  const unreachable = impact.newlyUnreachableSupportDatasets ?? [];
  const reasonsByPath = new Map();
  const addReason = (items, reason) => {
    for (const item of items) {
      const reasons = reasonsByPath.get(item.path) ?? [];
      reasons.push(reason);
      reasonsByPath.set(item.path, reasons);
    }
  };
  addReason(invalid, "Initial validation error");
  addReason(derived, "Affected materialized dataset");
  addReason(unreachable, "Newly unreachable support dataset");
  return {
    sourceReportSha256,
    excludedSetHash: impact.excludedSetHash,
    status: report.status,
    safeToExclude: impact.safeToExclude === true,
    originalDatasetCount: impact.originalDatasetCount,
    resultingDatasetCount: impact.resultingDatasetCount,
    options: report.options ?? [],
    invalidData: {
      title: "Invalid Data",
      note: "Exact validation failures. A selected release root is not an orphan merely because inbound edges are zero.",
      headers: [
        "Dataset Type",
        "UUID",
        "Version",
        "Canonical Path",
        "Classification",
        "Orphan",
        "Issue Count",
        "Issue Codes",
        "Inbound Edges",
        "Outbound Edges",
      ],
      rows: invalid.map((item) => [
        item.datasetType,
        item.uuid,
        item.version,
        item.path,
        item.classification,
        item.orphan,
        item.issueCount,
        (item.issueCodes ?? []).join(", "),
        item.inboundCalculationEdgeCount,
        item.outboundCalculationEdgeCount,
      ]),
    },
    affectedRoots: {
      title: "Affected Process Roots",
      note: "Initial invalid processes plus every reverse-dependent process root blocked by their exclusion.",
      headers: ["UUID", "Version", "Process Index"],
      rows: (impact.affectedProcessRoots ?? []).map((item) => [
        item.id,
        item.version,
        item.processIndex,
      ]),
    },
    derivedData: {
      title: "Affected Materialized Data",
      note: "Result Process and LifecycleModel datasets derived from affected process roots.",
      headers: [
        "Dataset Type",
        "Role",
        "Materialization Role",
        "UUID",
        "Version",
        "Process Index",
        "Source Process",
        "Canonical Path",
      ],
      rows: derived.map((item) => [
        item.datasetType,
        item.role ?? "",
        item.materializationRole ?? "",
        item.uuid,
        item.version,
        item.processIndex ?? "",
        identityLabel(item.sourceProcess),
        item.path,
      ]),
    },
    unreachableSupport: {
      title: "Newly Unreachable Support",
      note: "Support datasets reachable before the scope change but unreachable after affected roots are removed.",
      headers: ["Dataset Type", "Role", "UUID", "Version", "Canonical Path"],
      rows: unreachable.map((item) => [
        item.datasetType,
        item.role ?? "",
        item.uuid,
        item.version,
        item.path,
      ]),
    },
    completeExclusionSet: {
      title: "Complete Exclusion Set",
      note: "This entire set—not only the initially invalid files—is the object of any exclusion confirmation.",
      headers: [
        "Dataset Type",
        "Role",
        "Materialization Role",
        "UUID",
        "Version",
        "Canonical Path",
        "Exclusion Reason",
      ],
      rows: (impact.excludedCanonicalDatasets ?? []).map((item) => [
        item.datasetType,
        item.role ?? "",
        item.materializationRole ?? "",
        item.uuid,
        item.version,
        item.path,
        (reasonsByPath.get(item.path) ?? ["Dependency impact"]).join("; "),
      ]),
    },
    referenceConflicts: {
      title: "Remaining Reference Conflicts",
      note: "Any row here blocks exclusion. Empty means no reachable document still resolves only to excluded datasets.",
      headers: ["Referencing Canonical Path", "Referenced UUID", "Version"],
      rows: (impact.remainingReferenceConflicts ?? []).map((item) => [
        item.from,
        item.reference?.uuid ?? "",
        item.reference?.version ?? "",
      ]),
    },
  };
}

function populateSummarySheet(sheet, model) {
  sheet.showGridLines = false;
  sheet.mergeCells("A1:D1");
  sheet.getRange("A1").values = [["Release Exclusion Impact Review"]];
  sheet.mergeCells("A2:D2");
  sheet.getRange("A2").values = [
    [
      "Human review view only. The immutable JSON impact report and its SHA-256 remain authoritative for every decision.",
    ],
  ];
  sheet.getRange("A4:D4").values = [
    ["Metric", "Workbook Value", "Report Evidence", "Interpretation"],
  ];
  sheet.getRange("A5:D16").values = [
    ["Analysis status", model.status, model.status, "complete or blocked"],
    [
      "Safe to exclude",
      model.safeToExclude,
      model.safeToExclude,
      "false blocks exclusion",
    ],
    ["Initial invalid datasets", null, null, "exact validation failures"],
    ["Affected process roots", null, null, "reverse dependency closure"],
    ["Affected materialized datasets", null, null, "Result/Model lineage"],
    ["Newly unreachable support", null, null, "support closure reduction"],
    ["Complete exclusion set", null, null, "confirmation scope"],
    [
      "Original dataset count",
      model.originalDatasetCount,
      model.originalDatasetCount,
      "preserved failed build",
    ],
    [
      "Resulting dataset count",
      null,
      model.resultingDatasetCount,
      "must equal original minus exclusion set",
    ],
    ["Remaining reference conflicts", null, null, "non-zero blocks exclusion"],
    ["Impact report SHA-256", model.sourceReportSha256, "", "decision binding"],
    ["Excluded set hash", model.excludedSetHash, "", "complete set identity"],
  ];
  const ranges = {
    invalid: detailFormula("Invalid Data", model.invalidData.rows.length),
    roots: detailFormula("Affected Roots", model.affectedRoots.rows.length),
    derived: detailFormula("Derived Data", model.derivedData.rows.length),
    unreachable: detailFormula(
      "Unreachable Support",
      model.unreachableSupport.rows.length,
    ),
    excluded: detailFormula(
      "Complete Exclusion Set",
      model.completeExclusionSet.rows.length,
    ),
    conflicts: detailFormula(
      "Reference Conflicts",
      model.referenceConflicts.rows.length,
    ),
  };
  sheet.getRange("B7:B11").formulas = [
    [ranges.invalid],
    [ranges.roots],
    [ranges.derived],
    [ranges.unreachable],
    [ranges.excluded],
  ];
  sheet.getRange("C7:C11").values = [
    [model.invalidData.rows.length],
    [model.affectedRoots.rows.length],
    [model.derivedData.rows.length],
    [model.unreachableSupport.rows.length],
    [model.completeExclusionSet.rows.length],
  ];
  sheet.getRange("B13").formulas = [["=B12-B11"]];
  sheet.getRange("B14").formulas = [[ranges.conflicts]];
  sheet.getRange("C14").values = [[model.referenceConflicts.rows.length]];

  sheet.mergeCells("A18:D18");
  sheet.getRange("A18").values = [["Decision Guide"]];
  sheet.getRange("A19:D19").values = [
    ["Action", "Recommended", "Allowed", "Meaning"],
  ];
  const options = new Map(model.options.map((item) => [item.action, item]));
  sheet.getRange("A20:D22").values = ["repair", "exclude", "stop"].map(
    (action) => {
      const option = options.get(action) ?? {};
      return [
        action,
        option.recommended === true,
        option.allowed === true,
        option.description ?? "",
      ];
    },
  );
  applyTitleStyle(sheet, 4);
  applyHeaderStyle(sheet.getRange("A4:D4"));
  applyHeaderStyle(sheet.getRange("A19:D19"));
  sheet.getRange("A5:D16").format.borders = {
    insideHorizontal: { style: "thin", color: "#D8E1E8" },
  };
  sheet.getRange("A20:D22").format.borders = {
    insideHorizontal: { style: "thin", color: "#D8E1E8" },
  };
  sheet.getRange("A18:D18").format = {
    fill: "#DCEFEA",
    font: { bold: true, color: "#123B35", size: 13 },
    verticalAlignment: "center",
  };
  sheet.getRange("A18:D18").format.rowHeight = 26;
  sheet.getRange("B7:C14").format.numberFormat = "#,##0";
  sheet.getRange("B15:B16").format.numberFormat = "@";
  sheet.getRange("A1:A22").format.columnWidth = 29;
  sheet.getRange("B1:B22").format.columnWidth = 68;
  sheet.getRange("C1:C22").format.columnWidth = 21;
  sheet.getRange("D1:D22").format.columnWidth = 58;
  sheet.getRange("A1:D22").format.verticalAlignment = "center";
  sheet.getRange("D1:D22").format.wrapText = true;
  sheet.getRange("B15:B16").format.wrapText = true;
  sheet.getRange("B15:B16").format.rowHeight = 30;
  sheet.getRange("A20:D20").format.fill = "#E8F3EF";
  sheet.getRange("A21:D21").format.fill = model.safeToExclude
    ? "#FFF4D6"
    : "#FDE8E7";
  sheet.getRange("A22:D22").format.fill = "#F1F4F6";
  sheet.freezePanes.freezeRows(4);
}

function populateDetailSheet(sheet, section, { widths }) {
  const columnCount = section.headers.length;
  const lastColumn = columnName(columnCount);
  const dataRows =
    section.rows.length > 0
      ? section.rows
      : [["No records", ...Array(columnCount - 1).fill("")]];
  const lastRow = 4 + dataRows.length;
  sheet.showGridLines = false;
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.getRange("A1").values = [[section.title]];
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getRange("A2").values = [[section.note]];
  sheet.getRange(`A4:${lastColumn}4`).values = [section.headers];
  sheet.getRange(`A5:${lastColumn}${lastRow}`).values = dataRows;
  applyTitleStyle(sheet, columnCount);
  applyHeaderStyle(sheet.getRange(`A4:${lastColumn}4`));
  sheet.getRange(`A5:${lastColumn}${lastRow}`).format.borders = {
    insideHorizontal: { style: "thin", color: "#E1E7EB" },
  };
  sheet.getRange(`A5:${lastColumn}${lastRow}`).format.verticalAlignment =
    "center";
  sheet.getRange(`A5:${lastColumn}${lastRow}`).format.wrapText = true;
  for (let index = 0; index < widths.length; index += 1)
    sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidth =
      widths[index];
  sheet.getRange(`A4:${lastColumn}${lastRow}`).format.autofitRows();
  sheet.getRange("A1").format.rowHeight = 31;
  sheet.getRange("A2").format.rowHeight = 36;
  sheet.getRange(`A4:${lastColumn}4`).format.rowHeight = 25;
  sheet.freezePanes.freezeRows(4);
}

function applyTitleStyle(sheet, columnCount) {
  const lastColumn = columnName(columnCount);
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: "#153B50",
    font: { bold: true, color: "#FFFFFF", size: 17 },
    verticalAlignment: "center",
  };
  sheet.getRange(`A2:${lastColumn}2`).format = {
    fill: "#EAF1F4",
    font: { color: "#365A6C", italic: true, size: 10 },
    verticalAlignment: "center",
    wrapText: true,
  };
  sheet.getRange("A1").format.rowHeight = 31;
  sheet.getRange("A2").format.rowHeight = 36;
}

function applyHeaderStyle(range) {
  range.format = {
    fill: "#2B6F72",
    font: { bold: true, color: "#FFFFFF", size: 10 },
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: "#245E61" },
  };
}

async function loadArtifactTool(nodeModulesDir) {
  const root = path.resolve(
    nodeModulesDir ?? process.env.RELEASE_SPREADSHEET_NODE_MODULES ?? "",
  );
  if (!nodeModulesDir && !process.env.RELEASE_SPREADSHEET_NODE_MODULES)
    fail(
      "spreadsheet_runtime_missing",
      "Set RELEASE_SPREADSHEET_NODE_MODULES or pass --spreadsheet-node-modules using the client Agent workspace dependency runtime",
    );
  const resolver = createRequire(path.join(path.dirname(root), "resolver.cjs"));
  let entry;
  try {
    entry = resolver.resolve("@oai/artifact-tool");
  } catch {
    fail(
      "spreadsheet_runtime_invalid",
      `@oai/artifact-tool is not resolvable from ${root}`,
    );
  }
  return import(entry);
}

async function suppressArtifactInspectNotice(action) {
  const originalWrite = process.stdout.write;
  process.stdout.write = function filteredWrite(chunk, encoding, callback) {
    if (String(chunk).startsWith("Inspect result written to file:")) {
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    }
    return originalWrite.call(process.stdout, chunk, encoding, callback);
  };
  try {
    return await action();
  } finally {
    process.stdout.write = originalWrite;
  }
}

function assertFormulaErrorScanClean(ndjson) {
  let records;
  try {
    records = String(ndjson)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    fail(
      "review_workbook_formula_scan_invalid",
      "Spreadsheet formula-error scan returned an unreadable result",
    );
  }
  if (
    records.length !== 1 ||
    records[0].kind !== "notice" ||
    records[0].message !== "Cell search matched 0 entries."
  )
    fail(
      "review_workbook_formula_error",
      "Spreadsheet review workbook contains a formula error",
      { scan: records },
    );
}

function detailFormula(sheetName, rowCount) {
  if (rowCount === 0) return "=0";
  return `=COUNTA('${sheetName}'!$A$5:$A$${4 + rowCount})`;
}

function identityLabel(value) {
  if (!value) return "";
  return `${value.id ?? value.uuid ?? ""}@${value.version ?? ""}`;
}

function columnName(columnCount) {
  let value = columnCount;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function fileSafe(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

async function assertTargetAbsent(target) {
  try {
    await stat(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
